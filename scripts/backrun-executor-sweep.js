const fs = require("fs"), path = require("path");
const { utils } = require("ethers");
const { environment, save } = require("./backrun-context");
const { compile, fixtureQuote } = require("./backrun-executor-fork");
const { withLocalFork } = require("./backrun-local-fork");
const { HistoricalReplay, verifyReceipts } = require("../server/backrun/historicalReplay");
const { prepareLocalExecutor, executeLocalMode } = require("../server/backrun/localExecutorDiagnostic");
const { sweepOptions, summarizeSweep } = require("../server/backrun/localSweep");
const { AaveV2 } = require("../server/flashloan/aaveV2");
const { bn } = require("../server/bot/units");
const { replayDiagnostic } = require("./backrun-replay-diagnostics");
const { EXECUTOR_VERSION } = require("../server/config/executorVersion");
const { executorCodeHash } = require("../server/backrun/validation/validationEvidence");
const OUTPUT = "runtime/backrun/local-executor-sweep.json";

async function main({ progress = () => {} } = {}) {
  const { profile, archive, backend } = environment({ onMiningProgress: progress,
    onArchiveRetry: event => progress({ stage: "archive_retry", ...event }) });
  if (backend.engine !== "anvil") throw new Error("Executor sweep requires Anvil");
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../test/fixtures/backrun-26115902.json"), "utf8"));
  if (fixture.borrowSymbol !== "WETH") throw new Error("Executor sweep requires native-denominated WETH settlement");
  const options = sweepOptions(profile, fixture.amountIn);
  if (fs.existsSync(OUTPUT)) fs.unlinkSync(OUTPUT);
  if (Number(await archive.send("eth_chainId", [])) !== 1) throw new Error("Mainnet archive required");
  progress({ stage: "compile_local_executor" }); await compile();
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/ArbitrageFlashloan.sol/ArbitrageFlashloan.json"), "utf8"));
  const replay = new HistoricalReplay({ archive, backend, progress }), data = await replay.block(fixture.targetBlock), index = fixture.triggerTransactionIndex;
  if (fixture.arbitrageTransactionIndex !== index + 1 ||
      data.block.transactions[index]?.hash.toLowerCase() !== fixture.triggerTransaction.toLowerCase() ||
      data.block.transactions[index + 1]?.hash.toLowerCase() !== fixture.arbitrageTransaction.toLowerCase())
    throw new Error("Sweep fixture does not match canonical trigger/arbitrage order");
  const minimum = utils.parseEther(profile.backrun.minimumProfitBySymbol.WETH || "0.00001"), results = [];
  const metadata = { kind: "LOCAL_EXECUTOR_SIZE_FEE_SWEEP", executorVersion: EXECUTOR_VERSION, executorArtifactHash: executorCodeHash(), fixture: fixture.name, blockNumber: data.block.number,
    blockHash: data.block.hash, parentHash: data.parent.hash, triggerHash: fixture.triggerTransaction, chainId: 1,
    replayBackend: "anvil", deployedOnlyLocally: true, unsigned: true, mainnetSubmitted: false, commissioningEvidence: false,
    syntheticCapital: true, syntheticGasFunds: true, builderInclusionTested: false,
    executionOnly: true, blobDataAvailabilityVerified: false, historicalPoolAndAaveSetupUnmodified: true,
    configuredMaximumWeth: utils.formatEther(options.cap), configuredMinimumNetWeth: minimum.toString(),
    amountsWeth: options.amounts.map(utils.formatEther), priorityMultipliersBps: options.priorities,
    expectedRows: options.amounts.length * 2 * options.priorities.length,
    deploymentAndInfrastructureCostsIncluded: false, additionalDirectBuilderPaymentModelled: false,
    feeAssumption: "original historical base fee; priority fee multiplied by stated bps; priority included once in measured gas cost" };
  const checkpoint = (status = "running") => {
    const summary = summarizeSweep(results), complete = results.length === metadata.expectedRows && status === "finished";
    const report = { ...metadata, status, complete, allRowsEvaluatedWithoutTechnicalErrors: complete && summary.technicalErrors === 0,
      ...summary, results, recordedAt: Date.now() };
    save(OUTPUT, report); return report;
  };
  checkpoint();
  return backend.exclusive(async () => {
    let local;
    try {
      local = await prepareLocalExecutor({ backend, parent: data.parent, artifact,
        addressesProvider: profile.flashloanProvider.addressesProvider, lendingPool: profile.flashloanProvider.lendingPool,
        routers: Object.values(profile.routers).map(r => r.router),
        wrappedNative: profile.tokens.WETH, amount: options.amounts.at(-1), progress });
      metadata.executorAddress = local.executor.address;
      metadata.executorRuntimeCodeHash = local.runtimeCodeHash;
      metadata.localDeploymentGasUsed = local.deploymentReceipt.gasUsed.toString();
      const flashloan = new AaveV2(backend.provider, profile.flashloanProvider);
      for (const amount of options.amounts) {
        const amountWeth = utils.formatEther(amount);
        let context = { stage: "sweep_quote", amountWeth, blockNumber: data.block.number, endIndex: index };
        const track = event => { if (!event.stage.startsWith("mining_")) context = { ...context, ...event }; progress({ ...context, ...event }); };
        let prepared, terms, quoteError;
        try {
          track({ stage: "sweep_quote", amountWeth });
          local.setFundingMode("CAPITAL", amount); await backend.reset(data.parent);
          const prefix = await backend.mine(data.raw.slice(0, index + 1), data.block,
            { canonicalTransactions: data.block.transactions.slice(0, index + 1) });
          verifyReceipts(prefix.receipts, data.receipts.slice(0, index + 1));
          prepared = await fixtureQuote(profile, backend.provider, fixture, prefix.block, amount);
          terms = await flashloan.terms(profile.tokens.WETH, data.block.number);
        } catch (error) {
          if (backend.miningOutcomeUnknown) throw error;
          quoteError = replayDiagnostic(error, context);
        }
        for (const fundingMode of ["CAPITAL", "FLASH_LOAN"]) for (const priorityFeeBps of options.priorities) {
          const identity = { amountWeth, amountIn: amount.toString(), fundingMode, priorityFeeBps,
            historicalFeeScenario: priorityFeeBps === 10000, inclusionTested: false };
          let row;
          if (quoteError) row = { ...identity, status: "ERROR", diagnostic: quoteError };
          else {
            const gross = prepared.quote.expectedFinalAmount.sub(amount), fundingFee = fundingMode === "CAPITAL" ? bn(0) : flashloan.fee(amount, terms.premiumBps);
            const evidence = { expectedFinalAmount: prepared.quote.expectedFinalAmount.toString(),
              quotedGross: gross.toString(), quotedFundingFee: fundingFee.toString() };
            if (gross.sub(fundingFee).lte(0) || (fundingMode === "FLASH_LOAN" && amount.gt(terms.availableLiquidity))) {
              row = { ...identity, ...evidence, status: "QUOTE_REJECTED", executionSucceeded: false,
                reason: gross.sub(fundingFee).lte(0) ? "no_positive_profit_before_gas" : "insufficient_flash_liquidity" };
            } else try {
              track({ stage: "sweep_execution", amountWeth, fundingMode, priorityFeeBps });
              const settled = await executeLocalMode({ backend, data, endIndex: index, local, quoteData: prepared.data,
                fundingMode, minimumProfit: minimum, priorityFeeBps, progress: track });
              row = { ...identity, ...evidence, ...settled, status: "MEASURED" };
            } catch (error) {
              if (backend.miningOutcomeUnknown) throw error;
              row = { ...identity, ...evidence, status: "ERROR", executionSucceeded: false, diagnostic: replayDiagnostic(error, context) };
            }
          }
          results.push(row); checkpoint();
          console.log(JSON.stringify({ kind: "LOCAL_SWEEP_ROW", amountWeth, fundingMode, priorityFeeBps,
            status: row.status, gasUsed: row.gasUsed,
            netETH: row.netAfterGasNative !== undefined ? utils.formatEther(row.netAfterGasNative) : undefined,
            reason: row.reason, diagnostic: row.diagnostic }));
        }
      }
      const report = checkpoint("finished");
      console.table(results.map(row => ({ WETH: row.amountWeth, funding: row.fundingMode,
        priorityPercent: row.priorityFeeBps / 100, gas: row.gasUsed || "—",
        netETH: row.netAfterGasNative !== undefined ? utils.formatEther(row.netAfterGasNative) : "—",
        outcome: row.status === "MEASURED" ? row.netPositive ? "positive" : "negative" : row.status })));
      const readableBest = best => Object.fromEntries(Object.entries(best).map(([mode, row]) => [mode, {
        amountWeth: row.amountWeth, priorityPercent: row.priorityFeeBps / 100, gasUsed: row.gasUsed,
        grossWeth: utils.formatEther(row.grossBeforeFundingFee), flashFeeWeth: utils.formatEther(row.flashloanFee),
        gasETH: utils.formatEther(row.gasCostNative), netETH: utils.formatEther(row.netAfterGasNative),
        netPositive: row.netPositive, meetsConfiguredMinimum: row.meetsConfiguredMinimum }]));
      console.log(JSON.stringify({ kind: "LOCAL_EXECUTOR_SIZE_FEE_SWEEP_SUMMARY", reportPath: OUTPUT,
        complete: report.complete, allRowsEvaluatedWithoutTechnicalErrors: report.allRowsEvaluatedWithoutTechnicalErrors,
        measuredExecutions: report.measuredExecutions, quoteRejected: report.quoteRejected, technicalErrors: report.technicalErrors,
        profitableAtHistoricalFeeCombinations: report.profitableAtHistoricalFee,
        bestAtHistoricalFee: readableBest(report.bestAtHistoricalFee),
        bestAcrossTestedFees: readableBest(report.bestAcrossTestedFees),
        profitsMustNotBeSummed: true, builderInclusionTested: false, commissioningEvidence: false }, null, 2));
      if (!report.allRowsEvaluatedWithoutTechnicalErrors) process.exitCode = 1;
      return report;
    } catch (error) { checkpoint("failed"); throw error; }
    finally { local?.restoreReset(); }
  });
}
async function cli() {
  if (!process.argv.includes("--anvil")) process.argv.push("--anvil");
  let context = { stage: "configuration" };
  const progress = event => {
    if (!event.stage.startsWith("mining_") && event.stage !== "archive_retry") context = event;
    if (["canonical_receipt", "signed_transaction"].includes(event.stage) &&
        (event.stage !== "signed_transaction" || event.transactionIndex % 50 !== 0)) return;
    console.log(JSON.stringify({ kind: "LOCAL_SWEEP_PROGRESS", ...event }));
  };
  try {
    const { backend, profile } = environment();
    const fixture = require("../test/fixtures/backrun-26115902.json");
    sweepOptions(profile, fixture.amountIn); // Validate before starting any node.
    await withLocalFork({ backrun: { forkRpcUrl: backend.url } }, () => main({ progress }), progress, { engine: "anvil" });
  } catch (error) { console.error(JSON.stringify(replayDiagnostic(error, context), null, 2)); process.exitCode = 1; }
}
if (require.main === module) cli();
module.exports = { main, cli };
