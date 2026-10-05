// Gate 10: decision latency from the backrun journal's T0-T9 stage clock
// (written by BackrunService during local/PAPER runs) plus the 1-16 trigger
// concurrency benchmark. Writes runtime/backrun/validation/latency.json.
const fs = require("fs");
const { BackrunLedger } = require("../server/backrun/backrunLedger");
const { samplesFromRows, latencyReport, concurrencyBenchmark } = require("../server/backrun/validation/latencyBenchmark");
const { cli } = require("./lib/validationGate");

function journalRows(env) {
  const file = env.BACKRUN_LEDGER_PATH || "runtime/backrun/records.jsonl";
  return fs.existsSync(file) ? new BackrunLedger({ file, limit: 100000 }).recent(100000) : [];
}

async function run({ profile, env }) {
  const samples = samplesFromRows(journalRows(env));
  const measured = latencyReport(samples, { budgetMs: profile.backrun.latencyBudgetMs,
    minSamples: Number(env.BACKRUN_LATENCY_MIN_SAMPLES || 20) });
  // Stand-in stage times follow the measured medians when there are any.
  const stageMs = { prediction: measured.stages.prediction.median ?? 40, simulation: measured.stages.simulation.median ?? 60 };
  const concurrency = await concurrencyBenchmark({ backrun: profile.backrun, stageMs });
  const failed = [...(measured.passed ? [] : [measured.reason]), ...(concurrency.passed ? [] : ["concurrency_invariant_violated"])];
  return { kind: "LATENCY_BENCHMARK", measured, concurrency, failed, passed: !failed.length };
}

if (require.main === module) cli("latency", run);
module.exports = { run, journalRows };
