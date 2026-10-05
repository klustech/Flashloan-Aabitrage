// Gate 10: decision latency from the backrun journal's T0-T9 stage clock
// (written by BackrunService during local/PAPER runs) and the historical
// batch's local decision timings, plus the 1-16 trigger
// concurrency benchmark. Writes runtime/backrun/validation/latency.json.
const fs = require("fs");
const { BackrunLedger } = require("../server/backrun/backrunLedger");
const { samplesFromRows, samplesFromBatch, latencyReport, concurrencyBenchmark } = require("../server/backrun/validation/latencyBenchmark");
const { cli } = require("./lib/validationGate");

function journalRows(env) {
  const file = env.BACKRUN_LEDGER_PATH || "runtime/backrun/records.jsonl";
  return fs.existsSync(file) ? new BackrunLedger({ file, limit: 100000 }).recent(100000) : [];
}

function batchReport(env) {
  const file = env.BACKRUN_VALIDATION_BATCH || "runtime/backrun/local-executor-batch.json";
  try { const r = JSON.parse(fs.readFileSync(file, "utf8")); return r.status === "finished" ? r : null; } catch (_) { return null; }
}

// Samples: service decisions journaled during local/PAPER runs, plus the
// historical batch's local decision baseline. BACKRUN_LATENCY_ENFORCE_BUDGET=true
// also requires p95 within budget (PAPER enforces it on live latency).
async function run({ profile, env }) {
  const samples = [...samplesFromRows(journalRows(env)), ...samplesFromBatch(batchReport(env))];
  const measured = latencyReport(samples, { budgetMs: profile.backrun.latencyBudgetMs,
    minSamples: Number(env.BACKRUN_LATENCY_MIN_SAMPLES || 20), enforceBudget: env.BACKRUN_LATENCY_ENFORCE_BUDGET === "true" });
  // Stand-in stage times follow the measured medians when there are any.
  const stageMs = { prediction: measured.stages.prediction.median ?? 40, simulation: measured.stages.simulation.median ?? 60 };
  const concurrency = await concurrencyBenchmark({ backrun: profile.backrun, stageMs });
  const failed = [...(measured.passed ? [] : [measured.reason]), ...(concurrency.passed ? [] : ["concurrency_invariant_violated"])];
  return { kind: "LATENCY_BENCHMARK", measured, concurrency, failed, passed: !failed.length };
}

if (require.main === module) cli("latency", run);
module.exports = { run, journalRows };
