const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const L = require("../../server/backrun/validation/latencyBenchmark");
const backrun = { enabled: true, maxPending: 64, maxTriggerAgeMs: 8000, simulationTimeoutMs: 8000, orderflowSource: "custom", latencyBudgetMs: 2500 };

test("summary statistics use nearest-rank percentiles", () => {
  const s = L.summarize(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.deepEqual(s, { samples: 100, min: 1, mean: 51, median: 50, p75: 75, p90: 90, p95: 95, p99: 99, max: 100 });
  assert.deepEqual(L.summarize([]), { samples: 0 });
});

test("the service journals a monotonic T0-T7 stage clock on every decision", async () => {
  const service = L.timedService({ backrun, stageMs: { prediction: 5, simulation: 5 } });
  await service.ingest({ hash: "0x" + "77".repeat(32), rawTx: "0x01", affectedPools: ["0x" + "6".padStart(40, "0")], source: "custom" });
  while (service.processing || service.queue.length) await new Promise(r => setTimeout(r, 2));
  const [row] = service.ledger.recent(1);
  assert.equal(row.status, "SIMULATED");
  const order = ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7"].map(k => row.stageClock[k]);
  assert.ok(order.every(Number.isFinite), JSON.stringify(row.stageClock));
  for (let i = 1; i < order.length; i++) assert.ok(order[i] >= order[i - 1], JSON.stringify(row.stageClock));
  assert.ok(row.stageClock.T6 - row.stageClock.T5 >= 4);
  assert.equal(service.status().latency.budgetMs, 2500);
});

test("a latency baseline needs enough samples; the budget is enforced on request", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ triggerSource: i % 2 ? "mev_share" : "custom", fundingMode: "CAPITAL",
    stageClock: { T0: 0, T1: 1, T2: 2, T3: 10, T4: 20, T5: 21, T6: 80 + i, T7: 90 + i } }));
  const samples = L.samplesFromRows(rows);
  assert.equal(L.latencyReport(samples, { budgetMs: 2500 }).passed, true);
  assert.equal(L.latencyReport(samples, { budgetMs: 100 }).passed, true, "baseline recorded");
  assert.equal(L.latencyReport(samples, { budgetMs: 100 }).withinBudget, false);
  assert.equal(L.latencyReport(samples, { budgetMs: 100, enforceBudget: true }).reason, "p95_decision_latency_over_budget");
  assert.equal(L.latencyReport(samples.slice(0, 5), { budgetMs: 2500 }).reason, "insufficient_measured_samples");
  const r = L.latencyReport(samples, { budgetMs: 2500 });
  assert.equal(r.bySource.mev_share.samples, 20);
  assert.equal(r.stages.prediction.median, 8);
});

test("historical batch timings form a labelled local baseline", () => {
  const batch = { results: [{ timings: { postTriggerStateMs: 30, quoteAndSizeMs: 70, decisionMs: 100 },
    executions: [{ executionSucceeded: true, fundingMode: "FLASH_LOAN" }] }, { status: "ERROR" }] };
  const [s, ...rest] = L.samplesFromBatch(batch);
  assert.equal(rest.length, 0);
  assert.deepEqual([s.source, s.fundingMode, s.clock.T7, L.stageDurations(s.clock).prediction], ["historical_batch", "FLASH_LOAN", 100, 30]);
});

test("concurrent bursts stay fail-closed: terminal outcomes, no late decisions, bounded queue", { timeout: 30000 }, async () => {
  const r = await L.concurrencyBenchmark({ backrun, levels: [1, 4], stageMs: { prediction: 5, simulation: 5 } });
  assert.equal(r.passed, true, JSON.stringify(r, null, 1));
  assert.ok(r.stress.every(s => s.shed > 0));
});

test("latency CLI reads the journal and writes evidence", { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lat-")), journal = path.join(dir, "records.jsonl");
  fs.writeFileSync(journal, Array.from({ length: 25 }, (_, i) => JSON.stringify({ id: "r" + i, status: "SIMULATED", updatedAt: i,
    triggerSource: "custom", fundingMode: "FLASH_LOAN", stageClock: { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4, T5: 5, T6: 6, T7: 50 } })).join("\n") + "\n");
  const env = { ...process.env, BACKRUN_LEDGER_PATH: journal, BACKRUN_VALIDATION_DIR: dir, BACKRUN_EVIDENCE_MANIFEST: path.join(dir, "m.json") };
  delete env.PRIVATE_KEY;
  try {
    const { runGate } = require("../../scripts/lib/validationGate"), { run } = require("../../scripts/backrun-latency-benchmark");
    const result = await runGate("latency", run, { env, log: () => {} });
    assert.equal(result.passed, true, JSON.stringify(result.failed));
    assert.equal(result.measured.decision.samples, 25);
    assert.ok(fs.existsSync(path.join(dir, "latency.json")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
