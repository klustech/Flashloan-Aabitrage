const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { BackrunEvidence, CONTINUITY } = require("../../server/backrun/evidence");
const { CODES, rejectionCode } = require("../../server/backrun/rejectionTaxonomy");
const { infrastructure, project } = require("../../server/backrun/economicProjection");
const { buildProjection } = require("../../scripts/backrun-economic-projection");
const { timedService } = require("../../server/backrun/validation/latencyBenchmark");

const DAY = 86400000, hash = n => "0x" + n.toString(16).padStart(64, "0");
const profile = (over = {}) => ({ chainId: 1, backrun: { latencyBudgetMs: 2500, ...over } });
const ok = { paper: true, running: true, sourceConnected: true, headAgeMs: 1000, dbHealthy: true };
function clocked(p = profile(), file = null) { const t = { now: 1e6 }; const e = new BackrunEvidence(p, { file, now: () => t.now }); return { e, t }; }
const row = (n, over = {}) => ({ mode: "PAPER", status: "SIMULATED", triggerHash: hash(n), simulation: { ordered: true, signed: false, submitted: false },
  economics: { profitable: true, expectedNetProfit: "100", estimatedGasCostNative: "10" }, netNative: String(n * 100), fundingMode: "CAPITAL",
  fundingComparisons: { CAPITAL: { viable: true, expectedNetProfit: "100" }, FLASH_LOAN: { viable: true, expectedNetProfit: "90" } },
  parentBlock: 7, parentHash: hash(7), candidateId: "r1", route: { legs: [{ dex: "uniswap_v2" }, { dex: "uniswap_v3" }] }, rawTx: "0xsecret", ...over });

test("each continuity rule resets the window with its own reason", () => {
  const cases = [
    [{ ...ok, paper: false }, "left_paper_mode"], [{ ...ok, signatures: 1 }, "signing_occurred"], [{ ...ok, submissions: 1 }, "submission_occurred"],
    [{ ...ok, circuitReason: "x" }, "circuit_breaker:x"], [{ ...ok, running: false }, "observer_stopped"],
    [{ ...ok, dbHealthy: false }, "database_unavailable"], [{ ...ok, headAgeMs: CONTINUITY.headStallMs + 1 }, "chain_heads_stalled"],
  ];
  for (const [status, reason] of cases) {
    const { e, t } = clocked(); e.heartbeat(ok); t.now += 5000; e.heartbeat(ok);
    assert.equal(e.report().continuousMs, 5000);
    t.now += 5000; e.heartbeat(status);
    const r = e.report();
    assert.equal(r.continuousMs, 0, reason); assert.equal(r.resets.at(-1).reason, reason); assert.equal(r.gaps, 1);
  }
  const { e, t } = clocked(); e.heartbeat(ok); t.now += CONTINUITY.heartbeatGapMs + 1; e.heartbeat(ok);
  assert.equal(e.report().resets.at(-1).reason, "process_stopped");
});

test("a short order-flow outage is tolerated and counted; a long one resets", () => {
  const { e, t } = clocked(); e.heartbeat(ok);
  for (let i = 0; i < 10; i++) { t.now += 5000; e.heartbeat({ ...ok, sourceConnected: false }); }
  t.now += 5000; e.heartbeat(ok);
  let r = e.report(); assert.equal(r.continuousMs, 55000); assert.equal(r.sourceDisconnects, 1); assert.equal(r.gaps, 0);
  for (let i = 0; i < 14; i++) { t.now += 5000; e.heartbeat({ ...ok, sourceConnected: false }); }
  r = e.report(); assert.equal(r.resets.at(-1).reason, "orderflow_disconnected"); assert.equal(r.continuousMs, 0);
});

test("a configuration change starts a new window and is counted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-")), file = path.join(dir, "burn-in.json");
  try {
    const first = new BackrunEvidence(profile(), { file }); first.heartbeat(ok);
    const same = new BackrunEvidence(profile(), { file });
    assert.equal(same.report().configurationChanges, 0);
    const changed = new BackrunEvidence(profile({ capitalReserveBps: 500 }), { file });
    assert.equal(changed.report().configurationChanges, 1); assert.equal(changed.report().resets.at(-1).reason, "configuration_changed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("PAPER passes only after 7 days with profitable CAPITAL economics, latency in budget and nothing signed", () => {
  const { e, t } = clocked(); e.heartbeat(ok);
  e.record(row(1)); e.record(row(1)); e.record(row(2, { fundingComparisons: { FLASH_LOAN: { viable: true, expectedNetProfit: "5" } } }));
  for (let i = 0; i < 30; i++) e.evaluated({ candidates: 3, latencyMs: 1000 + i, budgetMs: 2500 });
  for (let i = 0; i < 7 * 24 * 120; i++) { t.now += 30000; e.heartbeat(ok); }
  let r = e.report();
  assert.equal(r.passed, true, JSON.stringify(r.checks));
  assert.deepEqual([r.profitable, r.capitalPositive, r.flashloanPositive, r.triggersEvaluated, r.candidatesGenerated], [2, 1, 2, 30, 90]);
  assert.deepEqual([r.totalHypotheticalNetNative, r.bestHypotheticalNetNative, r.medianHypotheticalNetNative, r.totalHypotheticalGasNative], ["300", "200", "100", "20"]);
  assert.equal(r.continuityDay, 7); assert.equal(r.latency.p95Ms, 1028);
  const o = r.opportunities[0];
  assert.deepEqual([o.headNumber, o.dexPath, o.fundingMode, o.pipelineLatencyMs === undefined], [7, "uniswap_v2 → uniswap_v3", "CAPITAL", false]);
  assert.ok(!JSON.stringify(r).includes("0xsecret"));
  for (let i = 0; i < 30; i++) e.evaluated({ latencyMs: 9000, budgetMs: 2500 });
  r = e.report(); assert.equal(r.checks.latencyWithinBudget, false); assert.equal(r.passed, false);
});

test("rejections are counted by canonical code with error counters", () => {
  const { e } = clocked(); e.heartbeat(ok);
  for (const reason of ["post_trigger_rpc_or_executor_failed", "Canonical cache parent mismatch", "No successful ordered private bundle simulation",
    "Measured backrun net below minimum", "duplicate_trigger"]) e.rejected({ mode: "PAPER", candidateId: "r" }, reason);
  e.rejected({ mode: "LIVE" }, "Executor paused");
  const r = e.report();
  assert.deepEqual(r.rejections, { RPC_UNHEALTHY: 1, STATE_MISMATCH: 1, RELAY_UNAVAILABLE: 1, NET_PROFIT_TOO_LOW: 1, DUPLICATE_TRIGGER: 1 });
  assert.deepEqual([r.rpcErrors, r.forkErrors, r.relayErrors], [1, 1, 1]);
  assert.equal(r.opportunities.at(-1).rejectCode, "DUPLICATE_TRIGGER");
});

test("the taxonomy classifies known reasons and every code is in the canonical list", () => {
  const table = { "Trigger expired in queue": "TRIGGER_STALE", "Trigger nonce replaced": "TRIGGER_REPLACED",
    "no_tracked_pool_impact_hint": "NO_AFFECTED_POOL", "mev_share_hint_lacks_swap_state": "TRIGGER_UNSUPPORTED",
    "No viable exact post-trigger route": "NO_ROUTE", "Post-trigger gross not positive": "NO_POSITIVE_GROSS",
    "flashloan_fee_or_liquidity_eliminates_profit": "FLASH_LIQUIDITY_LOW", "insufficient_capital_or_net_profit": "CAPITAL_LOW",
    "Backrun gas price exceeds ceiling": "GAS_TOO_HIGH", "Executor paused": "CONTRACT_PAUSED", "amount_exceeds_backrun_limit": "RISK_LIMIT",
    "Ordered bundle settlement does not meet profit floor": "SIMULATION_REVERT", "pending_queue_saturated": "QUEUE_SATURATED",
    "router not approved": "ROUTER_NOT_APPROVED", "Quote state is stale": "SLIPPAGE_TOO_HIGH", "decision over latency budget": "LATENCY_BUDGET_EXCEEDED",
    "builder payment exceeds share": "BUILDER_COST_TOO_HIGH", "something unforeseen": "UNCLASSIFIED" };
  for (const [reason, code] of Object.entries(table)) assert.equal(rejectionCode(reason), code, reason);
  for (const code of Object.values(table)) assert.ok(CODES.includes(code));
});

test("projections apply capture, inclusion, builder and gas assumptions, then infrastructure", () => {
  assert.throws(() => infrastructure({ monthlyUsd: undefined, ethUsd: 3000 }), /MONTHLY_INFRASTRUCTURE_COST_USD/);
  assert.throws(() => infrastructure({ monthlyUsd: 600 }), /ETH_USD_PRICE/);
  const infra = infrastructure({ monthlyUsd: 600, ethUsd: 3000 });
  const p = project({ durationMs: 7 * DAY, opportunities: 70, totalNetNative: "700000000000000000", totalGasNative: "70000000000000000" }, infra);
  assert.equal(p.scenarios.conservative.includedTradesPerDay, 0.25);
  assert.equal(p.scenarios.conservative.retainedPerTradeNative, 0.0045);
  assert.equal(p.scenarios.conservative.economicallyViable, false);
  assert.equal(p.scenarios.base.includedTradesPerDay, 1.5);
  assert.equal(p.scenarios.base.tradingNetPerDayNative, 0.01125);
  assert.equal(p.scenarios.base.economicallyViable, true, "0.01125/day covers 0.00789/day infrastructure + 20% margin");
  assert.equal(p.economicallyReady, true);
  const thin = project({ durationMs: 7 * DAY, opportunities: 7, totalNetNative: "70000000000000000", totalGasNative: "7000000000000000" }, infra);
  assert.equal(thin.scenarios.base.economicallyViable, false); assert.equal(thin.economicallyReady, false);
  const built = buildProjection(profile(), { continuousMs: DAY, profitable: 100, totalHypotheticalNetNative: "10000000000000000000",
    totalHypotheticalGasNative: "0", passed: false }, { MONTHLY_INFRASTRUCTURE_COST_USD: "600", ETH_USD_PRICE: "3000" });
  assert.equal(built.kind, "BACKRUN_ECONOMIC_PROJECTION"); assert.ok(built.profileFingerprint);
});

test("the service feeds PAPER evidence and exposes the dashboard", async () => {
  const backrun = { enabled: true, maxPending: 64, maxTriggerAgeMs: 8000, simulationTimeoutMs: 8000, orderflowSource: "custom", latencyBudgetMs: 2500 };
  const service = timedService({ backrun, stageMs: { prediction: 2, simulation: 2 } });
  service.evidence = new BackrunEvidence(profile(), { file: null });
  service.evidence.heartbeat(ok); service.headChanged({ hash: hash(1) });
  for (let i = 1; i <= 3; i++) await service.ingest({ hash: hash(100 + i), rawTx: "0x01", affectedPools: ["0x" + "6".padStart(40, "0")], source: "custom" });
  await service.ingest({ hash: hash(101), rawTx: "0x01", affectedPools: ["0x" + "6".padStart(40, "0")], source: "custom" });
  while (service.processing || service.queue.length) await new Promise(r => setTimeout(r, 2));
  const r = service.evidence.report(), d = service.dashboard();
  assert.deepEqual([r.headsObserved, r.triggersObserved, r.triggersDecoded, r.triggersEvaluated, r.profitable], [1, 4, 4, 3, 3]);
  assert.equal(r.rejections.DUPLICATE_TRIGGER, 1);
  assert.equal(d.mode, "PAPER"); assert.equal(d.executorVersion, 4); assert.equal(d.signatures, 0); assert.equal(d.submissions, 0);
  assert.deepEqual(d.topRejections, [{ code: "DUPLICATE_TRIGGER", count: 1 }]);
  assert.equal(d.continuity.of, 7);
  assert.equal(service.status().executorVersion, 4);
});
