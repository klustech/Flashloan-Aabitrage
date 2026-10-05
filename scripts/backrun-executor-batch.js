const fs = require("fs"), path = require("path");
const { utils } = require("ethers");
const { environment, save } = require("./backrun-context");
const { compile } = require("./backrun-executor-fork");
const { withLocalFork } = require("./backrun-local-fork");
const { HistoricalReplay } = require("../server/backrun/historicalReplay");
const { batchOptions, poolReferences, discoverTriggers, evaluateTrigger, summarizeBatch } = require("../server/backrun/localHistoricalBatch");
const { replayDiagnostic } = require("./backrun-replay-diagnostics");
const OUTPUT = "runtime/backrun/local-executor-batch.json";
function configuration(profile) {
  const fixture = require("../test/fixtures/backrun-26115902.json"), options = batchOptions(profile, fixture);
  const file = process.env.BACKRUN_BATCH_TOPOLOGY_PATH;
  const values = file ? JSON.parse(fs.readFileSync(file, "utf8")).pools : fixture.routePools;
  return { options, pools: poolReferences(profile, values), topologySource: file ? "explicit_pool_file" : "canonical_fixture_seed_pools" };
}
function readableBest(row) {
  return row ? { blockNumber: row.blockNumber, triggerHash: row.triggerHash, amountWeth: row.amountWeth,
    routePools: row.routePools, gasUsed: row.gasUsed, grossWeth: utils.formatEther(row.grossBeforeFundingFee),
    flashFeeWeth: utils.formatEther(row.flashloanFee), gasETH: utils.formatEther(row.gasCostNative),
    netETH: utils.formatEther(row.netAfterGasNative), netPositive: row.netPositive,
    meetsConfiguredMinimum: row.meetsConfiguredMinimum, triggerCreatedGrossEdge: row.triggerCreatedGrossEdge } : null;
}
async function runBatch({ profile, archive, backend, options, pools, topologySource, artifact,
  progress = () => {}, write = save, discover = discoverTriggers, evaluate = evaluateTrigger,
  replay = new HistoricalReplay({ archive, backend, progress }) }) {
  const results = [], blockErrors = [];
  let discoveredTriggers = null, truncated = false;
  const metadata = { kind: "LOCAL_EXECUTOR_HISTORICAL_BATCH", chainId: 1, replayBackend: "anvil",
    startBlock: options.start, endBlock: options.end, topologySource,
    pools: pools.map(pool => ({ dex: pool.dex, address: pool.poolAddress, feeTier: pool.feeTier })),
    coverage: "tracked pools, WETH two-leg cycles only; historical Swap transactions; no whole-market coverage claim",
    sampling: "all discovered triggers in range unless explicit limit reached; includes unprofitable triggers",
    configuredMaximumWeth: utils.formatEther(options.maximum), configuredMinimumAmountWeth: utils.formatEther(options.minimum),
    sizingSamples: options.samples, sizingRefinements: options.refinements, finalistsPerRoutePerMode: options.finalists,
    maxTriggers: options.maxTriggers, maxRoutes: options.maxRoutes,
    sizingObjective: "exact quote profit after funding before gas; measure top few sizes per route/mode after actual gas",
    hypotheticalLocalExecution: true, syntheticCapital: true, syntheticGasFunds: true, deployedOnlyLocally: true,
    unsigned: true, mainnetSubmitted: false, commissioningEvidence: false, builderInclusionTested: false,
    orderflowAvailabilityVerified: false, deploymentAndInfrastructureCostsIncluded: false,
    executionOnly: true, blobDataAvailabilityVerified: false,
    feeAssumption: "actual historical block base fee plus successful-transaction median priority; priority counted once; winning builder bid and extra direct payments unknown",
    usesFutureBlockInformation: true, netOptimalityProven: false,
    selectionBias: topologySource === "canonical_fixture_seed_pools" ? "default range/pools anchored around a known historical example" : "user-selected historical range/pools" };
  const checkpoint = (status = "running") => {
    const summary = summarizeBatch(results, { discoveredTriggers, truncated, finished: status === "finished", blockErrors });
    const report = { ...metadata, status, ...summary, blockErrors, results, recordedAt: Date.now() };
    write(OUTPUT, report); return report;
  };
  checkpoint();
  try {
    progress({ stage: "batch_discovery", startBlock: options.start, endBlock: options.end, poolCount: pools.length });
    const triggers = await discover(archive, pools, options, { progress,
      onDiscovery: discovery => { metadata.discovery = discovery; checkpoint(); } });
    discoveredTriggers = triggers.length; truncated = triggers.length > options.maxTriggers; checkpoint();
    progress({ stage: "batch_discovery_complete", discoveredTriggers, selectedTriggers: Math.min(triggers.length, options.maxTriggers), truncated });
    await backend.exclusive(async () => {
      let data, failedBlock;
      for (const trigger of triggers.slice(0, options.maxTriggers)) {
        progress({ stage: "batch_trigger", blockNumber: trigger.blockNumber, transactionIndex: trigger.transactionIndex,
          completedTriggers: results.length, selectedTriggers: Math.min(triggers.length, options.maxTriggers) });
        if (failedBlock === trigger.blockNumber) {
          results.push({ ...trigger, status: "ERROR", errors: [{ reason: "canonical_block_unavailable" }], executions: [] });
          checkpoint(); continue;
        }
        try {
          if (data?.block.number !== trigger.blockNumber) data = await replay.block(trigger.blockNumber);
        } catch (error) {
          failedBlock = trigger.blockNumber;
          blockErrors.push(replayDiagnostic(error, { stage: "batch_canonical_block", blockNumber: trigger.blockNumber }));
          results.push({ ...trigger, status: "ERROR", errors: [], executions: [] }); checkpoint(); continue;
        }
        try {
          const result = await evaluate({ profile, backend, data, trigger, pools, options, artifact, progress });
          results.push(result);
          progress({ stage: "batch_trigger_complete", blockNumber: trigger.blockNumber, transactionIndex: trigger.transactionIndex,
            routes: result.routes, quoteProbes: result.quoteProbes, executions: result.executions.length, errors: result.errors.length });
        } catch (error) {
          if (error.batchResult) results.push(error.batchResult);
          throw error; // Unknown mining outcome stops the entire run.
        }
        checkpoint();
      }
    });
    return checkpoint("finished");
  } catch (error) { blockErrors.push(replayDiagnostic(error, { stage: "batch_aborted" })); checkpoint("failed"); throw error; }
}
async function main({ progress = () => {} } = {}) {
  const { profile, archive, backend } = environment({ onMiningProgress: progress,
    onArchiveRetry: event => progress({ stage: "archive_retry", ...event }) });
  if (backend.engine !== "anvil") throw new Error("Historical executor batch requires Anvil");
  const configured = configuration(profile);
  if (fs.existsSync(OUTPUT)) fs.unlinkSync(OUTPUT);
  if (Number(await archive.send("eth_chainId", [])) !== 1) throw new Error("Mainnet archive required");
  progress({ stage: "compile_local_executor" }); await compile();
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/ArbitrageFlashloan.sol/ArbitrageFlashloan.json"), "utf8"));
  const report = await runBatch({ profile, archive, backend, ...configured, artifact, progress });
  console.table(report.results.map(result => {
    const best = mode => require("../server/backrun/localHistoricalBatch").bestMeasured(result.executions, mode);
    const capital = best("CAPITAL"), flash = best("FLASH_LOAN");
    return { block: result.blockNumber, triggerIndex: result.transactionIndex,
      capitalWETH: capital?.amountWeth || "—", capitalNetETH: capital ? utils.formatEther(capital.netAfterGasNative) : "—",
      flashWETH: flash?.amountWeth || "—", flashNetETH: flash ? utils.formatEther(flash.netAfterGasNative) : "—",
      errors: result.errors.length, outcome: result.status === "ERROR" || result.errors.length ? "ERROR" :
        !result.executions.length ? "NO_VIABLE_TESTED_SIZE" : "MEASURED" };
  }));
  console.log(JSON.stringify({ kind: "LOCAL_EXECUTOR_HISTORICAL_BATCH_SUMMARY", reportPath: OUTPUT,
    startBlock: report.startBlock, endBlock: report.endBlock, complete: report.complete, truncated: report.truncated,
    discoveredTriggers: report.discoveredTriggers, evaluatedTriggers: report.evaluatedTriggers,
    distinctEvaluatedBlocks: report.distinctEvaluatedBlocks, technicalErrors: report.technicalErrors,
    discovery: report.discovery,
    byMode: Object.fromEntries(Object.entries(report.byMode).map(([mode, value]) => [mode, { ...value, bestMeasured: readableBest(value.bestMeasured) }])),
    coverage: report.coverage, selectionBias: report.selectionBias, feeAssumption: report.feeAssumption,
    usesFutureBlockInformation: true, profitsMustNotBeSummed: true, builderInclusionTested: false,
    orderflowAvailabilityVerified: false, commissioningEvidence: false, netOptimalityProven: false }, null, 2));
  if (!report.complete) process.exitCode = 1;
  return report;
}
async function cli() {
  if (!process.argv.includes("--anvil")) process.argv.push("--anvil");
  let context = { stage: "configuration" };
  const progress = event => {
    if (!event.stage.startsWith("mining_") && event.stage !== "archive_retry") context = event;
    if (event.stage === "canonical_receipt" || (event.stage === "signed_transaction" && event.transactionIndex % 50 !== 0)) return;
    console.log(JSON.stringify({ kind: "LOCAL_BATCH_PROGRESS", ...event }));
  };
  try {
    const { profile, backend } = environment(); configuration(profile);
    await withLocalFork({ backrun: { forkRpcUrl: backend.url } }, () => main({ progress }), progress, { engine: "anvil" });
  } catch (error) { console.error(JSON.stringify(replayDiagnostic(error, context), null, 2)); process.exitCode = 1; }
}
if (require.main === module) cli();
module.exports = { main, cli, runBatch, configuration, readableBest };
