const { utils } = require("ethers");
const { bn, address, serialize } = require("../bot/units");
const { sizeTrade } = require("../bot/tradeSizer");
const { TokenRegistry } = require("../market/tokenRegistry");
const { PoolRegistry } = require("../market/poolRegistry");
const { createAdapters } = require("../dex");
const { QuoteEngine } = require("../bot/quoteEngine");
const { scanTwoLeg } = require("../scripts/crossDexScanner");
const { SWAP_TOPICS } = require("./triggerDecoder");
const { verifyReceipts } = require("./historicalReplay");
const { AaveV2 } = require("../flashloan/aaveV2");
const { prepareLocalExecutor, executeLocalMode } = require("./localExecutorDiagnostic");
const { replayDiagnostic } = require("../../scripts/backrun-replay-diagnostics");

function bounded(value, fallback, name, min, max) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error("Invalid " + name);
  return result;
}
function batchOptions(profile, fixture, env = process.env) {
  if ((env.BACKRUN_START_BLOCK === undefined) !== (env.BACKRUN_END_BLOCK === undefined))
    throw new Error("Specify both BACKRUN_START_BLOCK and BACKRUN_END_BLOCK");
  const start = bounded(env.BACKRUN_START_BLOCK, fixture.targetBlock - 9, "batch start block", 1, Number.MAX_SAFE_INTEGER);
  const end = bounded(env.BACKRUN_END_BLOCK, fixture.targetBlock + 10, "batch end block", start, start + 99);
  const maximum = utils.parseEther(profile.backrun.maxAmountBySymbol.WETH || "1");
  if (maximum.lte(0)) throw new Error("Positive BACKRUN_MAX_AMOUNT_WETH required");
  const minimum = env.BACKRUN_BATCH_MIN_AMOUNT_WETH ? utils.parseEther(env.BACKRUN_BATCH_MIN_AMOUNT_WETH) :
    (maximum.div(1000000).gt(0) ? maximum.div(1000000) : bn(1));
  if (minimum.lte(0) || minimum.gt(maximum)) throw new Error("Invalid batch amount bounds");
  return { start, end, maximum, minimum,
    maxTriggers: bounded(env.BACKRUN_BATCH_MAX_TRIGGERS, 200, "batch trigger limit", 1, 1000),
    maxRoutes: bounded(env.BACKRUN_BATCH_MAX_ROUTES, 32, "batch route limit", 1, 64),
    samples: bounded(env.BACKRUN_BATCH_SIZING_SAMPLES, 10, "batch sizing samples", 2, 20),
    refinements: bounded(env.BACKRUN_BATCH_SIZING_REFINEMENTS, 5, "batch sizing refinements", 0, 10),
    finalists: bounded(env.BACKRUN_BATCH_FINALISTS, 3, "batch finalists", 1, 5) };
}
function poolReferences(profile, values) {
  if (!Array.isArray(values) || values.length < 2 || values.length > 20) throw new Error("Batch requires 2..20 explicit supported pools");
  const result = new Map();
  for (const value of values) {
    const dex = value.dex, config = profile.routers[dex];
    if (!config || !["uniswap_v2", "sushiswap_v2", "uniswap_v3", "pancake_v3"].includes(dex))
      throw new Error("Unsupported batch pool DEX");
    const poolAddress = address(value.poolAddress || value.address), feeTier = dex.endsWith("_v3") ? Number(value.feeTier) : 0;
    if (dex.endsWith("_v3") && (!Number.isSafeInteger(feeTier) || feeTier < 1 || feeTier > 100000))
      throw new Error("Batch V3 fee tier required");
    if (result.has(poolAddress)) throw new Error("Duplicate batch pool address");
    result.set(poolAddress, { ...config, dex, poolAddress, feeTier });
  }
  return [...result.values()];
}
function groupSwapLogs(logs, pools, start, end) {
  const known = new Set(pools.map(pool => address(pool.poolAddress))), found = new Map();
  for (const log of logs) {
    if (log.removed || !known.has(address(log.address)) || !SWAP_TOPICS.has(log.topics?.[0]?.toLowerCase()) ||
        !Number.isSafeInteger(log.blockNumber) || log.blockNumber < start || log.blockNumber > end ||
        !Number.isSafeInteger(log.transactionIndex) || log.transactionIndex < 0 ||
        !/^0x[0-9a-f]{64}$/i.test(log.transactionHash || "") || !/^0x[0-9a-f]{64}$/i.test(log.blockHash || ""))
      throw new Error("Invalid historical Swap log discovery");
    const key = log.blockNumber + ":" + log.transactionIndex, previous = found.get(key);
    if (previous && (previous.triggerHash !== log.transactionHash.toLowerCase() || previous.blockHash !== log.blockHash.toLowerCase()))
      throw new Error("Conflicting historical Swap transaction identity");
    const entry = previous || { blockNumber: log.blockNumber, transactionIndex: log.transactionIndex,
      triggerHash: log.transactionHash.toLowerCase(), blockHash: log.blockHash.toLowerCase(), affectedPools: new Set() };
    entry.affectedPools.add(address(log.address)); found.set(key, entry);
  }
  return [...found.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex)
    .map(entry => ({ ...entry, affectedPools: [...entry.affectedPools] }));
}
async function discoverTriggers(archive, pools, options) {
  const logs = [];
  for (const pool of pools) logs.push(...await archive.getLogs({ address: pool.poolAddress,
    fromBlock: options.start, toBlock: options.end, topics: [[...SWAP_TOPICS]] }));
  return groupSwapLogs(logs, pools, options.start, options.end);
}
function verifyTrigger(data, trigger) {
  const tx = data.block.transactions[trigger.transactionIndex], receipt = data.receipts[trigger.transactionIndex];
  const affected = new Set(trigger.affectedPools);
  if (data.block.hash.toLowerCase() !== trigger.blockHash || tx?.hash.toLowerCase() !== trigger.triggerHash ||
      receipt?.transactionHash.toLowerCase() !== trigger.triggerHash || receipt.status !== 1 ||
      receipt.blockHash.toLowerCase() !== trigger.blockHash || receipt.transactionIndex !== trigger.transactionIndex ||
      ![...affected].every(pool => receipt.logs.some(log => address(log.address) === pool && SWAP_TOPICS.has(log.topics?.[0]?.toLowerCase()))))
    throw new Error("Discovered trigger does not match canonical successful Swap receipt");
}
function blockFeeReference(data) {
  const base = bn(data.block.baseFeePerGas);
  const priorities = data.receipts.filter(receipt => receipt?.status === 1).map(receipt => {
    if (receipt.effectiveGasPrice === undefined) throw new Error("Historical fee receipt missing");
    const priority = bn(receipt.effectiveGasPrice).sub(base);
    if (priority.lt(0)) throw new Error("Historical fee below block base fee");
    return priority;
  }).sort((a, b) => a.lt(b) ? -1 : a.gt(b) ? 1 : 0);
  if (!priorities.length) throw new Error("No historical successful transaction fee reference");
  const priority = priorities[Math.floor(priorities.length / 2)];
  return { source: "historical_block_successful_transaction_median_priority", sampleCount: priorities.length,
    priorityFeePerGas: priority.toString(), effectiveGasPrice: base.add(priority).toString(),
    usesFutureBlockInformation: true, winningBuilderBidKnown: false, directBuilderPaymentsIncluded: false };
}
async function poolContext(profile, provider, pools, block) {
  const tokens = new TokenRegistry(provider, 1), adapters = createAdapters(provider, profile), registry = new PoolRegistry(tokens);
  await tokens.load({ WETH: profile.tokens.WETH }, block.number);
  if (tokens.get(profile.tokens.WETH).decimals !== 18) throw new Error("WETH native accounting requires 18 decimals");
  for (const pool of pools) {
    const state = await adapters[pool.dex].getPoolState(pool, block.number);
    for (const token of [state.token0, state.token1]) if (!tokens.tokens.has(address(token)))
      await tokens.load({ [address(token)]: token }, block.number);
    registry.add({ ...pool, ...state });
  }
  const quoter = new QuoteEngine(adapters); quoter.beginBlock(block.hash);
  return { registry, quoter };
}
function candidateRoutes(registry, weth, affectedPools, blockNumber) {
  const affected = new Set(affectedPools.map(address));
  return scanTwoLeg(registry.edges(), [address(weth)], blockNumber)
    .filter(route => route.legs.some(leg => affected.has(address(leg.poolAddress))))
    .sort((a, b) => a.id.localeCompare(b.id));
}
// Exact quotes seed and refine sizing. Actual net is measured for the top few
// sizes of EACH route/mode, rather than asserting pre-gas sizing is net-optimal.
async function sizeCandidates({ routes, quoter, block, terms, flashloan, options }) {
  const candidates = [], errors = [], searches = [];
  let quoteProbes = 0;
  for (const route of routes) {
    const cache = new Map();
    const quoteAt = async amount => {
      const key = amount.toString();
      if (!cache.has(key)) {
        quoteProbes++;
        const quote = await quoter.quoteRoute(route, amount, block.number);
        cache.set(key, quote);
      }
      return cache.get(key);
    };
    for (const fundingMode of ["CAPITAL", "FLASH_LOAN"]) {
      const upper = fundingMode === "FLASH_LOAN" && terms.availableLiquidity.lt(options.maximum) ? terms.availableLiquidity : options.maximum;
      if (upper.lt(options.minimum)) continue;
      const value = quote => quote.expectedFinalAmount.sub(quote.borrowAmount).sub(
        fundingMode === "FLASH_LOAN" ? flashloan.fee(quote.borrowAmount, terms.premiumBps) : 0);
      await sizeTrade({ route, minInput: options.minimum, maxInput: upper,
        premiumBps: fundingMode === "FLASH_LOAN" ? terms.premiumBps : 0,
        samples: options.samples, refinements: options.refinements,
        evaluate: async amount => {
          try {
            const quote = await quoteAt(amount);
            return { quote, economics: { expectedNetProfit: value(quote) } };
          } catch (error) { errors.push({ routeId: route.id, amountIn: amount.toString(), fundingMode,
            diagnostic: replayDiagnostic(error, { stage: "batch_exact_sizing", blockNumber: block.number }) }); throw error; }
        } });
      const ranked = [...cache.values()].filter(quote => quote.borrowAmount.lte(upper) && value(quote).gt(0))
        .sort((a, b) => value(a).gt(value(b)) ? -1 : value(a).lt(value(b)) ? 1 : a.borrowAmount.lt(b.borrowAmount) ? -1 : 1);
      const tested = [...cache.values()].filter(quote => quote.borrowAmount.lte(upper));
      const bestQuote = tested.reduce((best, quote) => !best || value(quote).gt(value(best)) ? quote : best, null);
      searches.push({ routeId: route.id, fundingMode, minimumAmount: options.minimum.toString(), maximumAmount: upper.toString(),
        successfulExactSizes: tested.length, positiveExactSizes: ranked.length,
        bestAmountIn: bestQuote?.borrowAmount.toString(), bestQuotedProfitAfterFunding: bestQuote ? value(bestQuote).toString() : null,
        selectedFinalists: Math.min(ranked.length, options.finalists) });
      for (const quote of ranked.slice(0, options.finalists)) candidates.push({ fundingMode, quote,
        quotedProfitAfterFunding: value(quote).toString() });
    }
  }
  return { candidates, quoteProbes, errors, searches };
}
function bestMeasured(executions, mode) {
  return executions.filter(row => row.fundingMode === mode && row.status === "MEASURED" && row.executionSucceeded &&
    row.canonicalReceiptsVerified && row.sameBlock && row.principalPreserved).reduce((best, row) =>
      !best || bn(row.netAfterGasNative).gt(best.netAfterGasNative) ? row : best, null);
}
function summarizeBatch(results, { discoveredTriggers, truncated = false, finished = false, blockErrors = [] } = {}) {
  const unique = new Map();
  for (const result of results) {
    const key = result.blockNumber + ":" + result.triggerHash;
    if (unique.has(key)) throw new Error("Duplicate batch trigger result");
    unique.set(key, result);
  }
  const technicalErrors = blockErrors.length + results.reduce((count, row) => count + row.errors.length, 0);
  const valid = results.filter(result => result.status === "EVALUATED" && !result.errors.length);
  const byMode = {};
  for (const mode of ["CAPITAL", "FLASH_LOAN"]) {
    const best = valid.map(row => bestMeasured(row.executions, mode)).filter(Boolean);
    const greatest = best.reduce((result, row) => !result || bn(row.netAfterGasNative).gt(result.netAfterGasNative) ? row : result, null);
    byMode[mode] = { triggersWithMeasuredExecution: best.length,
      netPositiveTriggers: best.filter(row => row.netPositive).length,
      aboveConfiguredMinimumTriggers: best.filter(row => row.meetsConfiguredMinimum).length,
      triggerCreatedGrossEdgeCount: best.filter(row => row.triggerCreatedGrossEdge).length,
      bestMeasured: greatest };
  }
  const complete = finished && !truncated && results.length === discoveredTriggers && !technicalErrors;
  return { complete, allDiscoveredTriggersEvaluatedWithoutTechnicalErrors: complete,
    discoveredTriggers, evaluatedTriggers: valid.length, attemptedTriggers: results.length,
    truncated, technicalErrors, distinctEvaluatedBlocks: new Set(valid.map(row => row.blockNumber)).size,
    byMode, profitsMustNotBeSummed: true, mutuallyExclusiveAlternatives: true,
    samePoolOpportunitiesCanOverlap: true, builderInclusionTested: false, netOptimalityProven: false };
}
async function evaluateTrigger({ profile, backend, data, trigger, pools, options, artifact, progress = () => {},
  prepare = prepareLocalExecutor, execute = executeLocalMode, context = poolContext, sizing = sizeCandidates, flashloanFactory }) {
  const result = { ...trigger, status: "EVALUATED", errors: [], executions: [], routes: 0, quoteProbes: 0 };
  let local;
  const stage = event => progress({ ...trigger, ...event });
  try {
    verifyTrigger(data, trigger); result.feeReference = blockFeeReference(data);
    local = await prepare({ backend, parent: data.parent, artifact, addressesProvider: profile.flashloanProvider.addressesProvider,
      lendingPool: profile.flashloanProvider.lendingPool, wrappedNative: profile.tokens.WETH, amount: options.maximum, progress: stage });
    result.executorRuntimeCodeHash = local.runtimeCodeHash;
    const prefixAt = async index => {
      local.setFundingMode("CAPITAL", options.maximum); await backend.reset(data.parent);
      if (index < 0) return data.parent;
      const prefix = await backend.mine(data.raw.slice(0, index + 1), data.block,
        { canonicalTransactions: data.block.transactions.slice(0, index + 1) });
      verifyReceipts(prefix.receipts, data.receipts.slice(0, index + 1)); return prefix.block;
    };
    stage({ stage: "batch_post_trigger" });
    const block = await prefixAt(trigger.transactionIndex), post = await context(profile, backend.provider, pools, block);
    const routes = candidateRoutes(post.registry, profile.tokens.WETH, trigger.affectedPools, block.number);
    result.routes = routes.length;
    if (routes.length > options.maxRoutes) throw new Error("Batch route bound exceeded; no silent route truncation");
    if (!routes.length) { result.reason = "no_supported_WETH_two_leg_route"; return result; }
    const flashloan = flashloanFactory ? flashloanFactory(backend.provider, profile) : new AaveV2(backend.provider, profile.flashloanProvider);
    const terms = await flashloan.terms(profile.tokens.WETH, block.number);
    result.flashloanTerms = serialize(terms);
    stage({ stage: "batch_sizing", routeCount: routes.length });
    const sized = await sizing({ routes, quoter: post.quoter, block, terms, flashloan, options });
    result.quoteProbes = sized.quoteProbes; result.sizingSearches = sized.searches; result.errors.push(...sized.errors);
    if (!sized.candidates.length) { result.reason = "no_positive_exact_quote_after_funding_in_tested_sizes"; return result; }
    const before = new Map();
    stage({ stage: "batch_before_trigger" });
    const previous = await prefixAt(trigger.transactionIndex - 1);
    const pre = await context(profile, backend.provider, pools, previous);
    for (const candidate of sized.candidates) {
      const key = candidate.quote.route.id + ":" + candidate.quote.borrowAmount;
      if (!before.has(key)) try {
        const quote = await pre.quoter.quoteRoute(candidate.quote.route, candidate.quote.borrowAmount, previous.number);
        before.set(key, quote.expectedFinalAmount.sub(quote.borrowAmount).toString());
      } catch (error) { result.errors.push({ stage: "batch_before_trigger", routeId: candidate.quote.route.id,
        diagnostic: replayDiagnostic(error, { stage: "batch_before_trigger", blockNumber: data.block.number }) }); before.set(key, null); }
    }
    for (const candidate of sized.candidates) {
      const quote = candidate.quote, key = quote.route.id + ":" + quote.borrowAmount;
      const identity = { fundingMode: candidate.fundingMode, routeId: quote.route.id, amountIn: quote.borrowAmount.toString(),
        amountWeth: utils.formatEther(quote.borrowAmount), quotedGross: quote.expectedFinalAmount.sub(quote.borrowAmount).toString(),
        quotedProfitAfterFunding: candidate.quotedProfitAfterFunding, beforeTriggerGross: before.get(key),
        triggerCreatedGrossEdge: before.get(key) !== null && bn(before.get(key)).lte(0) && quote.expectedFinalAmount.gt(quote.borrowAmount),
        routePools: quote.route.legs.map(leg => ({ dex: leg.dex, address: leg.poolAddress, feeTier: leg.feeTier })),
        blockNumber: data.block.number, triggerHash: trigger.triggerHash };
      try {
        const measured = await execute({ backend, data, endIndex: trigger.transactionIndex, local,
          quoteData: post.quoter.buildData(quote, bn(1), profile.slippageBps), fundingMode: candidate.fundingMode,
          minimumProfit: utils.parseEther(profile.backrun.minimumProfitBySymbol.WETH || "0.00001"),
          feeReference: result.feeReference, progress: stage });
        result.executions.push({ ...identity, ...measured, status: "MEASURED" });
      } catch (error) {
        if (backend.miningOutcomeUnknown) throw error;
        const diagnostic = replayDiagnostic(error, { stage: "batch_executor", blockNumber: data.block.number,
          transactionIndex: trigger.transactionIndex });
        result.errors.push({ ...identity, diagnostic }); result.executions.push({ ...identity, status: "ERROR", diagnostic });
      }
    }
    return result;
  } catch (error) {
    const diagnostic = replayDiagnostic(error, { stage: "batch_trigger", blockNumber: data.block.number,
      transactionIndex: trigger.transactionIndex });
    result.errors.push({ diagnostic }); result.status = "ERROR";
    if (backend.miningOutcomeUnknown) { error.batchResult = result; throw error; }
    return result;
  } finally { local?.restoreReset(); }
}
module.exports = { batchOptions, poolReferences, groupSwapLogs, discoverTriggers, verifyTrigger, blockFeeReference,
  poolContext, candidateRoutes, sizeCandidates, bestMeasured, summarizeBatch, evaluateTrigger };
