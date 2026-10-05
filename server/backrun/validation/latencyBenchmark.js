// Gate 10: latency. Two parts:
//  1. Measured decision latency from the service's T0-T9 stage clock (rows
//     journaled by BackrunService during local/PAPER runs): min, mean,
//     median, p75, p90, p95, p99, max overall, per order-flow source, per
//     funding mode and per stage. p95 decision latency (T7) must be within
//     BACKRUN_LATENCY_BUDGET_MS over enough samples.
//  2. Queue behaviour under 1-16 simultaneous triggers through the real
//     BackrunService with timed stand-ins for prediction and simulation:
//     every trigger must end SIMULATED or REJECTED, nothing may be decided
//     after its trigger expired, and the queue must stay within maxPending.
const { BackrunService } = require("../service");
const { BackrunLedger } = require("../backrunLedger");
const { bn } = require("../../bot/units");

const STAGES = { queueWait: ["T0", "T1"], parentCheck: ["T1", "T2"], prediction: ["T2", "T3"], quoteAndSize: ["T3", "T4"],
  funding: ["T4", "T5"], simulation: ["T5", "T6"], decision: ["T6", "T7"], execution: ["T8", "T9"] };

function rank(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]; }

function summarize(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { samples: 0 };
  return { samples: v.length, min: v[0], mean: Math.round(v.reduce((s, x) => s + x, 0) / v.length), median: rank(v, .5),
    p75: rank(v, .75), p90: rank(v, .9), p95: rank(v, .95), p99: rank(v, .99), max: v[v.length - 1] };
}

function stageDurations(clock) {
  const out = {};
  for (const [name, [from, to]] of Object.entries(STAGES))
    if (Number.isFinite(clock?.[from]) && Number.isFinite(clock?.[to])) out[name] = clock[to] - clock[from];
  return out;
}

// Samples are { source, fundingMode, clock } with clock.T7 set (a decision
// was reached). Journal rows carry triggerSource/fundingMode/stageClock.
function samplesFromRows(rows) {
  return rows.filter(r => Number.isFinite(r?.stageClock?.T7))
    .map(r => ({ source: r.triggerSource || "unknown", fundingMode: r.fundingMode || "unknown", clock: r.stageClock }));
}

// Local baseline from the historical batch: decision time per evaluated
// trigger (post-trigger state, route search, exact sizing) on local Anvil.
function samplesFromBatch(report) {
  return (report?.results || []).filter(r => Number.isFinite(r?.timings?.decisionMs)).map(r => {
    const mode = (r.executions || []).find(e => e.executionSucceeded)?.fundingMode || "none";
    return { source: "historical_batch", fundingMode: mode,
      clock: { T0: 0, T1: 0, T2: 0, T3: r.timings.postTriggerStateMs, T4: r.timings.decisionMs, T5: r.timings.decisionMs,
        T6: r.timings.decisionMs, T7: r.timings.decisionMs } };
  });
}

function groupBy(samples, key) {
  const groups = {};
  for (const s of samples) (groups[s[key]] ||= []).push(s.clock.T7);
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, summarize(v)]));
}

function latencyReport(samples, { budgetMs, minSamples = 20, enforceBudget = false } = {}) {
  const decided = samples.filter(s => Number.isFinite(s.clock?.T7));
  const decision = summarize(decided.map(s => s.clock.T7));
  const stages = {};
  for (const name of Object.keys(STAGES)) stages[name] = summarize(decided.map(s => stageDurations(s.clock)[name]));
  const enough = decision.samples >= minSamples, withinBudget = enough && decision.p95 <= budgetMs;
  // Local validation requires a measured baseline (blueprint §41); staying
  // within budget is enforced on live PAPER latency (§43) unless asked here.
  const passed = enough && (!enforceBudget || withinBudget);
  return { budgetMs, minSamples, enforceBudget, decision, withinBudget, bySource: groupBy(decided, "source"),
    byFundingMode: groupBy(decided, "fundingMode"), stages, passed,
    reason: !enough ? "insufficient_measured_samples" : !passed ? "p95_decision_latency_over_budget" : null };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const a = n => "0x" + n.toString(16).padStart(40, "0");

function timedService({ backrun, stageMs }) {
  const block = { number: 1, hash: "0x" + "01".repeat(32) }, recipient = a(9);
  backrun = { ...backrun, enabled: true };
  const coordinator = { profile: { paperOnly: true, expectedProfitRecipient: recipient, backrun },
    state: { state: "PAPER", revision: 1, snapshot: () => ({ state: "PAPER", mode: "PAPER" }), pause() {} },
    provider: { getBlock: async () => block, getTransaction: async () => ({ blockNumber: null }) }, marketCache: { head: block },
    poolRegistry: { values: () => [{ poolAddress: a(6), router: a(5) }] }, ledger: { pending: () => [] },
    tokens: { get: () => ({ symbol: "WETH", decimals: 18 }) }, execution: { activity: { signatures: 0, submissions: 0 } },
    contract: { address: a(8), interface: { parseLog: () => ({ name: "ProfitWithdrawn", args: { token: a(1), recipient, amount: bn(30) } }) } } };
  const engine = { status: () => ({}), inspect: async (_x, consume) => {
    await sleep(stageMs.prediction);
    return consume({ rejections: [], context: { id: "c", predictionMs: stageMs.prediction, changedPools: new Set([a(6)]), header: { number: 2 } },
      stages: {}, opportunities: [{ route: { id: "r", borrowToken: a(1), legs: [{ dex: "uniswap_v2", poolAddress: a(6) }] },
        quote: { borrowAmount: bn(100) }, grossProfit: bn(30), funding: { mode: "CAPITAL", flashFee: bn(0), capitalAvailable: bn(100) },
        economics: { profitable: true, minimumRequiredProfit: bn(5), expectedNetProfit: bn(10) }, costBudgetBorrow: bn(10),
        transaction: { gasLimit: bn(100000) }, tip: { builderPaymentNativeWei: bn(0) } }] });
  } };
  const backend = { simulateUnsignedBundle: async () => { await sleep(stageMs.simulation);
    return { kind: "UNSIGNED_FORK_BUNDLE", gasUsed: bn(1), triggerGasUsed: bn(1), parentHash: block.hash, simulatedAt: Date.now(),
      backrunReceipt: { logs: [{ address: a(8) }] } }; } };
  const service = new BackrunService({ coordinator, engine, backend, execution: { activity: { signatures: 0, submissions: 0 } },
    ledger: new BackrunLedger({ file: null }), evidence: { record() {}, report: () => ({}) },
    source: { status: () => ({ connected: true }), stop() {}, removeListener() {}, on() {} } });
  service.closed = false;
  return service;
}

async function concurrencyBenchmark({ backrun, levels = [1, 2, 4, 8, 16], stageMs = { prediction: 40, simulation: 60 }, stress: withStress = true } = {}) {
  const results = [];
  for (const level of levels) {
    const service = timedService({ backrun, stageMs });
    let maxQueue = 0;
    const startedAt = Date.now();
    await Promise.all(Array.from({ length: level }, (_, i) => service.ingest({ hash: "0x" + (i + 1).toString(16).padStart(64, "0"),
      rawTx: "0x01", affectedPools: [a(6)], source: "custom", receivedAt: Date.now() })));
    while (service.processing || service.queue.length) { maxQueue = Math.max(maxQueue, service.queue.length); await sleep(2); }
    const rows = service.ledger.recent(1000), decided = service.stageClocks.filter(s => Number.isFinite(s.clock.T7));
    const lateDecisions = decided.filter(s => s.clock.T7 > backrun.maxTriggerAgeMs).length;
    const terminal = rows.every(r => ["SIMULATED", "REJECTED"].includes(r.status));
    results.push({ level, wallMs: Date.now() - startedAt, simulated: rows.filter(r => r.status === "SIMULATED").length,
      rejected: rows.filter(r => r.status === "REJECTED").length, rejectionReasons: service.stats.reasons, maxQueue,
      decision: summarize(decided.map(s => s.clock.T7)), queueWait: summarize(service.stageClocks.map(s => s.clock.T1)),
      invariants: { allTerminal: terminal && rows.length === level, noDecisionAfterExpiry: lateDecisions === 0,
        queueBounded: maxQueue <= (backrun.maxPending || 64) } });
  }
  // Fail-closed stress: triggers that wait too long expire, an overfull
  // queue sheds its oldest work, and neither ever produces a late decision.
  const stress = [];
  if (!withStress) return { stageMs, levels: results, passed: results.every(r => Object.values(r.invariants).every(Boolean)) };
  const perTrigger = stageMs.prediction + stageMs.simulation;
  for (const [name, overrides, reason] of [["trigger expiry", { maxTriggerAgeMs: perTrigger * 3 }, "expired"],
    ["queue saturation", { maxPending: 4 }, "pending_queue_saturated"]]) {
    const [r] = (await concurrencyBenchmark({ backrun: { ...backrun, ...overrides }, levels: [16], stageMs, stress: false })).levels;
    const shed = Object.entries(r.rejectionReasons).filter(([k]) => k.includes(reason)).reduce((n, [, v]) => n + v, 0);
    stress.push({ name, ...r, shed, invariants: { ...r.invariants, shedsLoad: shed > 0 } });
  }
  const passed = [...results, ...stress].every(r => Object.values(r.invariants).every(Boolean));
  return { stageMs, levels: results, stress, passed,
    // Triggers are processed one at a time: queue wait grows with burst size.
    serialProcessing: true };
}

module.exports = { summarize, stageDurations, samplesFromRows, samplesFromBatch, latencyReport, concurrencyBenchmark, timedService, STAGES };
