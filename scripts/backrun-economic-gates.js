// Economic validation gates (blueprint §6-10) over measured local executions.
// Inputs are the reports written by backrun:executor-sweep and
// backrun:executor-batch (Anvil, canonical replay, v4 executor deployed
// locally). Output: runtime/backrun/validation/<gate>.json bound to the
// evidence manifest. Usage: node scripts/backrun-economic-gates.js [replay|size|gas|builder|liquidity|parity|all]
const fs = require("fs");
const { utils } = require("ethers");
const { productionProfile } = require("../server/config/productionProfile");
const { loadEnvironment } = require("./paper-preflight");
const { measuredRows } = require("../server/backrun/validation/economics");
const { analyzeSizeCurve } = require("../server/backrun/validation/sizeSweep");
const { gasStress } = require("../server/backrun/validation/gasStress");
const { builderCompetition } = require("../server/backrun/validation/builderCompetition");
const { fundingParity } = require("../server/backrun/validation/fundingParity");
const { outputHaircut } = require("../server/backrun/validation/slippageStress");
const { buildManifest, writeEvidence, writeManifest } = require("../server/backrun/validation/validationEvidence");

const GATES = ["replay", "size", "gas", "builder", "liquidity", "parity"];
const EVIDENCE = { replay: "canonical-replay", size: "size-sweep", gas: "gas-stress", builder: "builder-competition", liquidity: "liquidity-stress", parity: "funding-parity" };

function readReport(file) {
  if (!fs.existsSync(file)) return null;
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  if (report.status && report.status !== "finished") throw new Error(`${file} is not a finished run`);
  return report;
}

function inputs(env = process.env) {
  const sweepFile = env.BACKRUN_VALIDATION_SWEEP || "runtime/backrun/local-executor-sweep.json";
  const batchFile = env.BACKRUN_VALIDATION_BATCH || "runtime/backrun/local-executor-batch.json";
  const sweep = readReport(sweepFile), batch = readReport(batchFile);
  if (!sweep && !batch) throw new Error("No measured reports: run backrun:executor-sweep and/or backrun:executor-batch first");
  return { sweep, batch, sources: { sweep: sweep ? sweepFile : null, batch: batch ? batchFile : null },
    rows: [...measuredRows(sweep), ...measuredRows(batch)] };
}

// The engine's choice for the sweep's trigger, as sized by the batch run.
function engineSelection(batch, triggerHash, fundingMode) {
  const item = (batch?.results || []).find(r => r.triggerHash?.toLowerCase() === triggerHash?.toLowerCase());
  const execution = (item?.executions || []).find(e => e.fundingMode === fundingMode && e.executionSucceeded);
  return execution ? execution.amountIn : null;
}

// Every measured execution must come from this executor build, replay the
// canonical prefix receipts in the same historical block and preserve principal.
function replayGate(data, manifest) {
  const reports = [data.sweep, data.batch].filter(Boolean), problems = [];
  for (const report of reports) {
    if (report.executorVersion !== manifest.executorVersion) problems.push(`${report.kind}: executor version ${report.executorVersion ?? "unrecorded"}`);
    if (report.executorArtifactHash !== manifest.executorCodeHash) problems.push(`${report.kind}: produced by a different executor build`);
  }
  const executions = reports.flatMap(r => (r.results || []).flatMap(item => Array.isArray(item.executions) ? item.executions : [item]))
    .filter(e => e?.executionSucceeded);
  const violations = executions.filter(e => e.principalPreserved !== true || e.canonicalReceiptsVerified !== true || e.sameBlock !== true);
  if (violations.length) problems.push(`${violations.length} successful execution(s) without verified receipts, same block or preserved principal`);
  if (!data.rows.length) problems.push("no measured canonical executions");
  return { reports: reports.map(r => ({ kind: r.kind, status: r.status, executorVersion: r.executorVersion ?? null,
    blocks: r.blockNumber ?? [r.startBlock, r.endBlock] })), succeededExecutions: executions.length, measuredRows: data.rows.length,
    violations: violations.length, problems, passed: !problems.length, reason: problems[0] || null };
}

async function runGate(gate, { profile, data, minimumWei, manifest }) {
  const options = { minimumWei, profile };
  if (gate === "replay") return replayGate(data, manifest);
  if (gate === "size") {
    if (!data.sweep) return { passed: false, reason: "size sweep report missing" };
    const sweepRows = measuredRows(data.sweep), modes = ["CAPITAL", "FLASH_LOAN"];
    const curves = modes.map(mode => analyzeSizeCurve(sweepRows, { fundingMode: mode,
      selectedAmount: engineSelection(data.batch, data.sweep.triggerHash, mode) }));
    const evaluated = curves.filter(c => c.reason !== "no_measured_sizes");
    return { kind: "SIZE_OPTIMISATION", triggerHash: data.sweep.triggerHash, blockNumber: data.sweep.blockNumber, curves,
      passed: evaluated.length > 0 && evaluated.every(c => c.passed) };
  }
  if (gate === "gas") return gasStress(data.rows, options);
  if (gate === "builder") return builderCompetition(data.rows, options);
  if (gate === "parity") return fundingParity(data.rows);
  if (gate === "liquidity") {
    const routes = outputHaircut(data.rows, options);
    // The analytic table must show worsening turning into rejects; the
    // on-chain floor itself is proven by test/security/executorAdversarial.
    const { BigNumber } = require("ethers");
    const consistent = routes.every(r => r.scenarios.every((s, i, all) => i === 0 ||
      (BigNumber.from(s.netAfterGas).lte(all[i - 1].netAfterGas) && (all[i - 1].stillProfitable || !s.stillProfitable))));
    return { kind: "LIQUIDITY_SLIPPAGE_STRESS", routes, onChainFloorEvidence: "test/security/executorAdversarial.test.js",
      passed: routes.length > 0 && consistent, reason: routes.length ? null : "no_profitable_measured_rows" };
  }
  throw new Error(`Unknown gate ${gate}`);
}

async function main(args = process.argv.slice(2), env = process.env) {
  loadEnvironment(env);
  if (env.PRIVATE_KEY) throw new Error("Validation refuses PRIVATE_KEY");
  const which = args[0] || "all", gates = which === "all" ? GATES : [which];
  if (gates.some(g => !GATES.includes(g))) throw new Error(`Gate must be one of ${GATES.join(", ")} or all`);
  const profile = productionProfile(env), manifest = buildManifest(profile, { env });
  writeManifest(manifest, { env });
  const minimumWei = utils.parseEther(profile.backrun.minimumProfitBySymbol.WETH || "0.00001");
  const data = inputs(env), summary = {};
  for (const gate of gates) {
    const result = await runGate(gate, { profile, data, minimumWei, manifest });
    writeEvidence(EVIDENCE[gate], { ...result, sources: data.sources, minimumWei: minimumWei.toString() }, manifest, { env });
    summary[gate] = { passed: result.passed, reason: result.reason || null };
  }
  console.log(JSON.stringify({ kind: "BACKRUN_ECONOMIC_GATES", manifestId: manifest.manifestId, summary }, null, 2));
  return summary;
}

if (require.main === module) main().then(s => { process.exitCode = Object.values(s).every(g => g.passed) ? 0 : 1; })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, runGate, replayGate, inputs, engineSelection, GATES, EVIDENCE };
