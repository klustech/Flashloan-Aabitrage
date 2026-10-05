// Gate 8: failure injection. Every scenario drives the real LIVE execution
// path (BackrunExecutionEngine + PrivateRelays + TradeLedger), the fork
// backend or the backrun service with exactly one dependency faulted, and
// checks the outcome is fail-closed:
//   DROP_BEFORE_SIGN  nothing signed, nothing submitted
//   DROP_AFTER_SIGN   signed but never submitted, no pending submission
//   HELD_UNCERTAIN    submission intent recorded (SUBMITTED) before the relay
//                     failed: further signing is blocked until it settles
//   CIRCUIT           the service tripped its circuit breaker (and paused LIVE)
// A healthy control scenario must reach SUBMITTED, proving the harness works.
const { Wallet, utils } = require("ethers");
const { BackrunExecutionEngine } = require("../executionEngine");
const { PrivateRelays } = require("../../execution/privateRelays");
const { TradeLedger } = require("../../bot/tradeLedger");
const { ForkBackend } = require("../forkBackend");
const { BackrunService } = require("../service");
const { BackrunLedger } = require("../backrunLedger");
const { bn } = require("../../bot/units");

const a = n => "0x" + n.toString(16).padStart(40, "0");
const PARENT = { number: 100, hash: "0x" + "ab".repeat(32) };
const RELAYS = ["https://relay-a.example", "https://relay-b.example"];

function rpcError(message, code) { const e = new Error(message); if (code) e.code = code; return e; }

async function signedTrigger({ nonce = 7 } = {}) {
  const sender = Wallet.createRandom();
  const raw = await sender.signTransaction({ to: a(77), chainId: 1, type: 2, nonce, gasLimit: 21000,
    maxFeePerGas: utils.parseUnits("10", "gwei"), maxPriorityFeePerGas: 1, value: 0 });
  return { raw, hash: utils.keccak256(raw), from: sender.address.toLowerCase(), nonce };
}

function preparedOpportunity(trigger, now) {
  const W = a(2), D = a(1);
  const leg = (tokenIn, tokenOut) => ({ poolAddress: a(10), tokenIn, tokenOut, stateBlock: PARENT.number, stateTimestamp: now,
    tokenInDecimals: 18, tokenOutDecimals: 18 });
  return { executionId: "exec-" + Math.random().toString(16).slice(2), block: PARENT,
    trigger: { hash: trigger.hash, rawTx: trigger.raw, source: "public_pending", receivedAt: now },
    route: { id: "route", chainId: 1, borrowToken: W, legs: [leg(W, D), leg(D, W)] },
    quote: { stateBlock: PARENT.number, quotedAt: now, borrowAmount: bn(10) }, funding: { mode: "CAPITAL" },
    economics: { profitable: true, estimatedGasUnits: bn(300000) },
    transaction: { to: a(9), data: "0x", gasLimit: bn(300000), maxFeePerGas: bn(2e9), maxPriorityFeePerGas: bn(1e9) },
    tip: { maxFeePerGas: bn(2e9) } };
}

// Relay fakes: each relay URL maps to a behaviour object.
function relayClient(behaviours) {
  const relays = new PrivateRelays(null, RELAYS, undefined, { env: {} });
  relays.get = async url => {
    const b = behaviours[url] || {};
    return {
      simulate: async txs => {
        if (b.simulate) return b.simulate(txs);
        const [trigger, backrun] = txs;
        return { stateBlockNumber: PARENT.number, totalGasUsed: "121000", results: [
          { txHash: utils.keccak256(trigger), gasUsed: "21000" },
          { txHash: utils.keccak256(backrun), gasUsed: "100000", ethSentToCoinbase: "0" }] };
      },
      sendRawBundle: async () => (b.send ? b.send() : { bundleHash: "0xbundle" }),
    };
  };
  return relays;
}

async function liveHarness({ fault = {}, relayBehaviours = {}, ledger: injected } = {}) {
  const now = Date.now(), trigger = await signedTrigger(), wallet = Wallet.createRandom();
  const counters = { signatures: 0, relaySubmissions: 0 };
  const prepared = preparedOpportunity(trigger, now);
  if (fault.prepared) fault.prepared(prepared, trigger);
  const provider = {
    getBlock: async () => (fault.getBlock ? fault.getBlock() : PARENT),
    getTransaction: async () => (fault.getTransaction ? fault.getTransaction() : { blockNumber: null }),
    getTransactionCount: async (who, tag) => (fault.getTransactionCount ? fault.getTransactionCount(who, tag) :
      who === trigger.from ? trigger.nonce : 3),
    getBalance: async () => (fault.getBalance ? fault.getBalance() : utils.parseEther("1")),
  };
  const ledger = injected || new TradeLedger({ file: null, persist: fault.persist });
  if (fault.pendingSubmission) await ledger.write({ id: "old", mode: "LIVE", status: "SUBMITTED" });
  if (fault.dailyLoss) await ledger.write({ id: "loss", mode: "LIVE", status: "INCLUDED", realizedNetNative: utils.parseEther("-5").toString() });
  const relays = relayClient(relayBehaviours);
  const send = relays.submit.bind(relays);
  relays.submit = async (...args) => { const r = await send(...args); counters.relaySubmissions += r.length; return r; };
  const signer = { address: wallet.address, signTransaction: async tx => { counters.signatures++; return wallet.signTransaction(tx); } };
  const engine = new BackrunExecutionEngine({ provider, wallet: signer, relays, ledger,
    profile: { paperOnly: false, chainId: 1, maxRouteHops: 3, maxGasUnits: 1500000, maxQuoteAgeMs: 10000, maxPoolStateAgeMs: 10000,
      maxDailyLossNative: "1", fingerprint: "f", tokens: { WETH: a(2) }, backrun: { maxTriggerAgeMs: 10000, maxSimulationAgeMs: 10000 } },
    contract: { paused: async () => !!fault.paused, profitRecipient: async () => a(7) },
    state: { canSign: () => !fault.disarmed }, tokens: { get: () => ({ symbol: "WETH", decimals: 18 }) },
    readiness: async () => (fault.notReady ? { ready: false, errors: [fault.notReady] } : { ready: true }), emit: () => {} });
  let error = null;
  try { await engine.execute(prepared, { revision: 1 }); } catch (e) { error = e; }
  const statuses = ledger.recent(100).filter(r => r.id === prepared.executionId).map(r => r.status);
  const submittedRecorded = statuses.includes("SUBMITTED");
  let outcome;
  if (!error) outcome = "SUBMITTED";
  else if (counters.relaySubmissions > 0) outcome = "UNSAFE_SUBMITTED_DESPITE_ERROR";
  else if (submittedRecorded) outcome = "HELD_UNCERTAIN";
  else outcome = counters.signatures ? "DROP_AFTER_SIGN" : "DROP_BEFORE_SIGN";
  return { outcome, error: error?.message || null, ...counters, pendingSubmissions: ledger.pending().length };
}

const ENGINE_SCENARIOS = [
  ["control", "healthy dependencies", {}, {}, "SUBMITTED"],
  ["rpc", "head RPC timeout", { getBlock: () => { throw rpcError("timeout", "TIMEOUT"); } }, {}, "DROP_BEFORE_SIGN"],
  ["rpc", "head RPC HTTP 500", { getBlock: () => { throw rpcError("bad response 500", "SERVER_ERROR"); } }, {}, "DROP_BEFORE_SIGN"],
  ["rpc", "RPC rate-limited (429)", { getBlock: () => { throw rpcError("429 Too Many Requests"); } }, {}, "DROP_BEFORE_SIGN"],
  ["rpc", "invalid head response", { getBlock: () => null }, {}, "DROP_BEFORE_SIGN"],
  ["rpc", "stale or advanced parent", { getBlock: () => ({ ...PARENT, hash: "0x" + "cd".repeat(32) }) }, {}, "DROP_BEFORE_SIGN"],
  ["rpc", "trigger lookup disconnect", { getTransaction: () => { throw rpcError("socket hang up", "NETWORK_ERROR"); } }, {}, "DROP_BEFORE_SIGN"],
  ["rpc", "wrong chain / readiness failure", { notReady: "chain: chain ID mismatch" }, {}, "DROP_BEFORE_SIGN"],
  ["trigger", "malformed raw transaction", { prepared: p => { p.trigger.rawTx = "0x02deadbeef"; } }, {}, "DROP_BEFORE_SIGN"],
  ["trigger", "hash does not match raw transaction", { prepared: p => { p.trigger.hash = "0x" + "11".repeat(32); } }, {}, "DROP_BEFORE_SIGN"],
  ["trigger", "trigger already mined", { getTransaction: () => ({ blockNumber: 99 }) }, {}, "DROP_BEFORE_SIGN"],
  ["trigger", "trigger disappeared", { getTransaction: () => null }, {}, "DROP_BEFORE_SIGN"],
  ["trigger", "trigger replaced (nonce advanced)", { getTransactionCount: (_w, tag) => (tag === "latest" ? 8 : 3) }, {}, "DROP_BEFORE_SIGN"],
  ["trigger", "trigger expired", { prepared: p => { p.trigger.receivedAt -= 60000; } }, {}, "DROP_BEFORE_SIGN"],
  ["execution", "executor paused", { paused: true }, {}, "DROP_BEFORE_SIGN"],
  ["execution", "router no longer approved", { notReady: "routers: uniswap_v2 router not approved on-chain" }, {}, "DROP_BEFORE_SIGN"],
  ["execution", "operator role removed", { notReady: "executor role: operator lacks the executor role" }, {}, "DROP_BEFORE_SIGN"],
  ["execution", "insufficient signer gas balance", { getBalance: () => bn(1) }, {}, "DROP_BEFORE_SIGN"],
  ["execution", "previous submission still pending", { pendingSubmission: true }, {}, "DROP_BEFORE_SIGN"],
  ["execution", "daily loss limit exceeded", { dailyLoss: true }, {}, "DROP_BEFORE_SIGN"],
  ["execution", "trading disarmed", { disarmed: true }, {}, "DROP_BEFORE_SIGN"],
  ["execution", "gas above maximum", { prepared: p => { p.economics.estimatedGasUnits = bn(2000000); } }, {}, "DROP_BEFORE_SIGN"],
  ["execution", "profit below minimum", { prepared: p => { p.economics.profitable = false; } }, {}, "DROP_BEFORE_SIGN"],
  ["execution", "stale quote", { prepared: p => { p.quote.quotedAt -= 60000; } }, {}, "DROP_BEFORE_SIGN"],
  ["relay", "every relay simulation times out", {}, { [RELAYS[0]]: { simulate: () => { throw rpcError("timeout"); } },
    [RELAYS[1]]: { simulate: () => { throw rpcError("timeout"); } } }, "DROP_AFTER_SIGN"],
  ["relay", "relay simulation rejects (revert)", {}, { [RELAYS[0]]: { simulate: () => ({ firstRevert: { error: "revert" } }) },
    [RELAYS[1]]: { simulate: () => ({ error: { message: "bundle reverted" } }) } }, "DROP_AFTER_SIGN"],
  ["relay", "malformed relay simulation response", {}, { [RELAYS[0]]: { simulate: () => ({ results: [] }) },
    [RELAYS[1]]: { simulate: () => "garbage" } }, "DROP_AFTER_SIGN"],
  ["relay", "every relay rejects the submission", {}, { [RELAYS[0]]: { send: () => ({ error: { message: "rejected" } }) },
    [RELAYS[1]]: { send: () => { throw rpcError("timeout"); } } }, "HELD_UNCERTAIN"],
  ["relay", "partial relay availability", {}, { [RELAYS[0]]: { simulate: () => { throw rpcError("timeout"); } } }, "SUBMITTED"],
  ["database", "PostgreSQL unavailable at first write", { persist: async () => { throw new Error("ECONNREFUSED"); } }, {}, "DROP_AFTER_SIGN"],
  ["database", "insert fails when recording submission intent", { persist: async row => { if (row.status === "SUBMITTED") throw new Error("insert failed"); } }, {}, "DROP_AFTER_SIGN"],
];

async function forkScenario() {
  const backend = new ForkBackend({ url: "http://127.0.0.1:8547", provider: { send: async () => { throw new Error("must not be called"); } } });
  backend.miningOutcomeUnknown = true;
  const refused = [];
  for (const [name, call] of [["reset", () => backend.reset(PARENT)], ["mine", () => backend.mine([], PARENT)],
    ["state write", () => backend.applyHint({ poolEffects: [{}] }, PARENT)]]) {
    try { await call(); refused.push({ name, refused: false }); } catch (e) { refused.push({ name, refused: e.code === "BACKRUN_FORK_RESTART_REQUIRED" }); }
  }
  return { category: "fork", name: "unknown mining outcome blocks further fork mutations", expected: "DROP_BEFORE_SIGN",
    outcome: refused.every(r => r.refused) ? "DROP_BEFORE_SIGN" : "UNSAFE_FORK_MUTATION", detail: refused };
}

function serviceFixture({ persist, liveResult } = {}) {
  let paused = null; const pending = [];
  const block = { number: 1, hash: "0x" + "01".repeat(32) };
  const coordinator = { profile: { paperOnly: false, expectedProfitRecipient: a(9),
    backrun: { enabled: true, maxPending: 4, maxTriggerAgeMs: 8000, simulationTimeoutMs: 8000, orderflowSource: "custom" } },
    state: { state: "LIVE_RUNNING", revision: 1, snapshot: () => ({ state: "LIVE_RUNNING", mode: "LIVE" }), pause: reason => { paused = reason; } },
    provider: { getBlock: async () => block, getTransaction: async () => ({ blockNumber: null }) }, marketCache: { head: block },
    poolRegistry: { values: () => [{ poolAddress: a(6) }] }, ledger: { pending: () => pending }, tokens: { get: () => ({ symbol: "WETH", decimals: 18 }) },
    execution: { activity: { signatures: 0, submissions: 0 } },
    contract: { address: a(8), interface: { parseLog: () => ({ name: "ProfitWithdrawn", args: { token: a(1), recipient: a(9), amount: bn(30) } }) } } };
  const engine = { status: () => ({}), inspect: async (_x, consume) => consume({ rejections: [], context: { id: "c", predictionMs: 0, changedPools: new Set([a(6)]), header: { number: 2 } },
    stages: {}, opportunities: [{ route: { id: "r", borrowToken: a(1), legs: [{ dex: "uniswap_v2", poolAddress: a(6) }] }, quote: { borrowAmount: bn(100) },
      grossProfit: bn(30), funding: { mode: "CAPITAL", flashFee: bn(0), capitalAvailable: bn(100) },
      economics: { profitable: true, minimumRequiredProfit: bn(5), expectedNetProfit: bn(10) }, costBudgetBorrow: bn(10),
      transaction: { gasLimit: bn(100000) }, tip: { builderPaymentNativeWei: bn(0) } }] }) };
  const backend = { simulateUnsignedBundle: async () => ({ kind: "UNSIGNED_FORK_BUNDLE", gasUsed: bn(1), triggerGasUsed: bn(1), parentHash: block.hash,
    simulatedAt: Date.now(), backrunReceipt: { logs: [{ address: a(8) }] } }) };
  const execution = { activity: { signatures: 0, submissions: 0 }, execute: async () => liveResult() };
  const service = new BackrunService({ coordinator, engine, backend, execution, ledger: new BackrunLedger({ file: null, persist }),
    source: { status: () => ({ connected: true }), stop() {}, removeListener() {}, on() {} }, evidence: { record() {}, report: () => ({}) } });
  service.closed = false;
  service.enabled = () => true;
  return { service, paused: () => paused, pending };
}

async function serviceScenarios() {
  const results = [];
  { // Persistence failure while ingesting order flow trips the circuit.
    const { service, paused } = serviceFixture({ persist: async () => { throw new Error("database unavailable"); } });
    await service.onHint({ hash: "0x" + "33".repeat(32), rawTx: "0x01", affectedPools: [a(6)], source: "custom", receivedAt: Date.now() });
    await new Promise(r => setImmediate(r));
    results.push({ category: "database", name: "persistence failure during order-flow intake", expected: "CIRCUIT",
      outcome: service.circuitReason ? "CIRCUIT" : "NO_CIRCUIT", detail: { circuitReason: service.circuitReason, paused: paused() } });
  }
  { // A burst of source errors trips the order-flow circuit breaker.
    const { service } = serviceFixture();
    for (let i = 0; i < 30; i++) service.onSourceError(new Error("disconnect"));
    results.push({ category: "rpc", name: "order-flow source disconnect storm", expected: "CIRCUIT",
      outcome: service.circuitReason === "orderflow_source_circuit_breaker" ? "CIRCUIT" : "NO_CIRCUIT", detail: { circuitReason: service.circuitReason } });
  }
  { // An error after submission intent leaves the outcome unknown: trip and pause LIVE.
    const { service, paused } = serviceFixture({ liveResult: async () => ({ status: "SUBMITTED", txHash: "0x" + "44".repeat(32) }) });
    const row = await service.ledger.write({ id: "x", triggerHash: "0x" + "55".repeat(32), triggerSource: "custom", status: "DETECTED", mode: "LIVE" });
    service.ledger.write = (orig => async record => { if (record.status === "SUBMITTED") { await orig(record); throw new Error("journal write lost"); } return orig(record); })(service.ledger.write.bind(service.ledger));
    await service.process({ trigger: { hash: row.triggerHash, rawTx: "0x01", source: "custom", receivedAt: Date.now() }, row });
    results.push({ category: "relay", name: "uncertain state after submission", expected: "CIRCUIT",
      outcome: service.circuitReason === "backrun_submission_uncertain" && paused() ? "CIRCUIT" : "NO_CIRCUIT",
      detail: { circuitReason: service.circuitReason, paused: paused() } });
  }
  { // The engine recorded a pending LIVE submission, then the relay call threw.
    let fixture;
    fixture = serviceFixture({ liveResult: async () => { fixture.pending.push({ status: "SUBMITTED" }); throw new Error("relay socket closed"); } });
    const { service, paused } = fixture;
    const row = await service.ledger.write({ id: "y", triggerHash: "0x" + "66".repeat(32), triggerSource: "custom", status: "DETECTED", mode: "LIVE" });
    await service.process({ trigger: { hash: row.triggerHash, rawTx: "0x01", source: "custom", receivedAt: Date.now() }, row });
    results.push({ category: "relay", name: "execution error after pending submission recorded", expected: "CIRCUIT",
      outcome: service.circuitReason === "backrun_submission_uncertain" && paused() ? "CIRCUIT" : "NO_CIRCUIT",
      detail: { circuitReason: service.circuitReason, paused: paused() } });
  }
  return results;
}

async function runFailureInjection() {
  const results = [];
  for (const [category, name, fault, relayBehaviours, expected] of ENGINE_SCENARIOS) {
    const r = await liveHarness({ fault, relayBehaviours });
    results.push({ category, name, expected, ...r });
  }
  results.push(await forkScenario(), ...(await serviceScenarios()));
  for (const r of results) r.passed = r.outcome === r.expected;
  const unsafe = results.filter(r => /^UNSAFE/.test(r.outcome));
  return { kind: "FAILURE_INJECTION", scenarios: results.length, failed: results.filter(r => !r.passed).map(r => r.name),
    unsafe: unsafe.map(r => r.name), results, passed: results.every(r => r.passed) };
}

module.exports = { runFailureInjection, liveHarness, ENGINE_SCENARIOS };
