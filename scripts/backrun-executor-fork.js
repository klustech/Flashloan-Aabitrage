const fs = require("fs"), path = require("path"), { spawn } = require("child_process");
const { utils } = require("ethers");
const { environment, save, routeFromFixture, QuoteEngine } = require("./backrun-context");
const { withLocalFork } = require("./backrun-local-fork");
const { HistoricalReplay } = require("../server/backrun/historicalReplay");
const { prepareLocalExecutor, executeLocalMode } = require("../server/backrun/localExecutorDiagnostic");
const { TokenRegistry } = require("../server/market/tokenRegistry");
const { PoolRegistry } = require("../server/market/poolRegistry");
const { createAdapters } = require("../server/dex");
const { address, bn } = require("../server/bot/units");
const { replayDiagnostic } = require("./backrun-replay-diagnostics");

async function compile() {
  const child = spawn(process.execPath, [require.resolve("hardhat/internal/cli/cli"), "compile"], {
    stdio: "inherit", env: { ...process.env, ENABLE_MAINNET_FORK: "false", PRIVATE_KEY: "" },
  });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (code !== 0) throw new Error("Local executor compilation failed");
}
async function fixtureQuote(profile, provider, fixture, block, amountIn = fixture.amountIn) {
  // Read only the fixture's exact pools; an unrelated topology-cache file must
  // neither change this route nor require broad pool discovery.
  const tokens = new TokenRegistry(provider, 1);
  await tokens.load(Object.fromEntries(profile.tokenSymbols.map(symbol => [symbol, profile.tokens[symbol]])), block.number);
  const adapters = createAdapters(provider, profile), registry = new PoolRegistry(tokens);
  for (const ref of fixture.routePools) {
    const pool = { ...profile.routers[ref.dex], dex: ref.dex, poolAddress: ref.address, feeTier: ref.feeTier };
    registry.add({ ...pool, ...await adapters[ref.dex].getPoolState(pool, block.number) });
  }
  const route = routeFromFixture(fixture, { registry }, profile, block.number), quoter = new QuoteEngine(adapters);
  quoter.beginBlock(block.hash);
  const quote = await quoter.quoteRoute(route, amountIn, block.number);
  // This is a measurement run, so allow execution above one wei of contract
  // profit. Report the configured net floor separately; a losing diagnostic
  // must never become production readiness evidence.
  return { quote, data: quoter.buildData(quote, bn(1), profile.slippageBps) };
}
async function main({ progress = () => {} } = {}) {
  const { profile, archive, backend } = environment({ onMiningProgress: progress,
    onArchiveRetry: event => progress({ stage: "archive_retry", ...event }) });
  if (backend.engine !== "anvil") throw new Error("Use backrun:executor-fork (Anvil required)");
  if (Number(await archive.send("eth_chainId", [])) !== 1) throw new Error("Mainnet archive required");
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../test/fixtures/backrun-26115902.json"), "utf8"));
  if (fixture.borrowSymbol !== "WETH") throw new Error("Local diagnostic requires native-denominated WETH settlement");
  const output = "runtime/backrun/local-executor-diagnostic.json";
  if (fs.existsSync(output)) fs.unlinkSync(output); // Never leave stale success at this diagnostic path.
  progress({ stage: "compile_local_executor" }); await compile();
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/ArbitrageFlashloan.sol/ArbitrageFlashloan.json"), "utf8"));
  const replay = new HistoricalReplay({ archive, backend, progress }), data = await replay.block(fixture.targetBlock);
  const index = fixture.triggerTransactionIndex;
  if (fixture.arbitrageTransactionIndex !== index + 1 ||
      data.block.transactions[index]?.hash.toLowerCase() !== fixture.triggerTransaction.toLowerCase() ||
      data.block.transactions[index + 1]?.hash.toLowerCase() !== fixture.arbitrageTransaction.toLowerCase())
    throw new Error("Fixture does not match canonical trigger/arbitrage order");
  const results = [], minimum = utils.parseEther(profile.backrun.minimumProfitBySymbol.WETH || "0.00001");
  return backend.exclusive(async () => {
    const local = await prepareLocalExecutor({ backend, parent: data.parent, artifact,
      addressesProvider: profile.flashloanProvider.addressesProvider, lendingPool: profile.flashloanProvider.lendingPool,
      wrappedNative: profile.tokens.WETH, amount: bn(fixture.amountIn), progress });
    try {
      for (const fundingMode of ["CAPITAL", "FLASH_LOAN"]) {
        let modeContext = { stage: "executor_prepare", fundingMode, blockNumber: data.block.number, endIndex: index };
        const modeProgress = event => { if (!event.stage.startsWith("mining_")) modeContext = { ...modeContext, ...event }; progress(event); };
        try {
          local.setFundingMode(fundingMode);
          await backend.reset(data.parent);
          const prefix = await backend.mine(data.raw.slice(0, index + 1), data.block,
            { canonicalTransactions: data.block.transactions.slice(0, index + 1) });
          require("../server/backrun/historicalReplay").verifyReceipts(prefix.receipts, data.receipts.slice(0, index + 1));
          modeProgress({ stage: "executor_quote", fundingMode, blockNumber: data.block.number });
          const prepared = await fixtureQuote(profile, backend.provider, fixture, prefix.block);
          const result = await executeLocalMode({ backend, data, endIndex: index, local, quoteData: prepared.data,
            fundingMode, minimumProfit: minimum, progress: modeProgress });
          result.expectedFinalAmount = prepared.quote.expectedFinalAmount.toString();
          results.push(result);
          console.log(JSON.stringify({ kind: "LOCAL_EXECUTOR_SETTLEMENT", ...result }));
        } catch (error) {
          // A lost mining response makes this node unusable. Do not continue to
          // the other funding method or issue further mutations.
          if (backend.miningOutcomeUnknown) throw error;
          const diagnostic = replayDiagnostic(error, modeContext);
          results.push({ fundingMode, executionSucceeded: false, diagnostic });
          console.error(JSON.stringify(diagnostic));
        }
      }
      const report = { kind: "LOCAL_EXECUTOR_HISTORICAL_DIAGNOSTIC", fixture: fixture.name, chainId: 1,
        blockNumber: data.block.number, blockHash: data.block.hash, parentHash: data.parent.hash,
        triggerHash: fixture.triggerTransaction, replayBackend: "anvil", executorVersion: 3,
        executorAddress: address(local.executor.address), executorRuntimeCodeHash: local.runtimeCodeHash,
        deployedOnlyLocally: true, unsigned: true, mainnetSubmitted: false, commissioningEvidence: false,
        syntheticCapital: true, syntheticGasFunds: true, historicalPoolAndAaveSetupUnmodified: true,
        executionOnly: true, blobDataAvailabilityVerified: false,
        localDeploymentGasUsed: local.deploymentReceipt.gasUsed.toString(),
        deploymentAndInfrastructureCostsIncluded: false, builderInclusionTested: false,
        feeAssumption: "historical arbitrage priority fee; no additional direct builder payment modelled",
        configuredMinimumNetWeth: minimum.toString(), results,
        technicalPassed: results.length === 2 && results.every(result => result.executionSucceeded),
        economicallyPositiveModes: results.filter(result => result.netPositive).map(result => result.fundingMode),
        recordedAt: Date.now() };
      progress({ stage: "save_local_diagnostic" }); save(output, report);
      console.log(JSON.stringify(report, null, 2));
      if (!report.technicalPassed) process.exitCode = 1;
      return report;
    } finally { local.restoreReset(); }
  });
}
async function cli() {
  // This command always uses the dedicated owned/reusable Anvil lifecycle.
  if (!process.argv.includes("--anvil")) process.argv.push("--anvil");
  let context = { stage: "configuration" };
  const progress = event => {
    if (!event.stage.startsWith("mining_") && event.stage !== "archive_retry") context = event;
    if (["canonical_receipt", "signed_transaction"].includes(event.stage) &&
        (event.stage !== "signed_transaction" || event.transactionIndex % 50 !== 0)) return;
    console.log(JSON.stringify({ kind: "LOCAL_EXECUTOR_PROGRESS", ...event }));
  };
  try {
    const { backend } = environment();
    await withLocalFork({ backrun: { forkRpcUrl: backend.url } }, () => main({ progress }), progress, { engine: "anvil" });
  } catch (error) {
    console.error(JSON.stringify(replayDiagnostic(error, context), null, 2)); process.exitCode = 1;
  }
}
if (require.main === module) cli();
module.exports = { main, cli, fixtureQuote, compile };
