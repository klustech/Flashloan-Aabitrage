// Gate 9: restart recovery. Each scenario writes the durable journals a crash
// at a given point would leave behind, restarts from those files (new ledger
// instances, as a process restart does) and checks the recovered state:
//   - pre-submission backrun rows expire, never resume against stale state
//   - LIVE intent never sent is dropped; PAPER evidence is untouched
//   - a possibly-sent LIVE submission stays pending, blocks further signing,
//     is linked to its backrun row and settles through receipt reconciliation
//   - a write torn by the crash is skipped; corruption elsewhere stops startup
const fs = require("fs");
const os = require("os");
const path = require("path");
const { TradeLedger } = require("../../bot/tradeLedger");
const { ExecutionEngine } = require("../../bot/executionEngine");
const { BackrunLedger } = require("../backrunLedger");
const { BackrunService } = require("../service");
const { liveHarness } = require("./failureInjection");

const hash = n => "0x" + n.toString(16).padStart(64, "0");

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "backrun-recovery-")); }

function restartedService(backrunFile, tradeLedger) {
  const coordinator = { profile: { backrun: { enabled: true, maxPending: 4 } }, ledger: tradeLedger,
    state: { state: "LIVE_RUNNING", snapshot: () => ({ mode: "LIVE" }), pause() {} } };
  return new BackrunService({ coordinator, engine: {}, backend: {}, execution: { activity: {} },
    ledger: new BackrunLedger({ file: backrunFile }), evidence: { record() {}, report: () => ({}) } });
}

async function journal(ledger, id, statuses, extra = {}) {
  let row;
  for (const status of statuses) row = await ledger.write({ ...row, id, status, ...extra });
  return row;
}

const BACKRUN_PATH = ["DETECTED", "POST_TRIGGER_QUOTED", "FUNDING_SELECTED", "SIMULATED"];

async function crashBeforeSigning(dir) {
  const file = path.join(dir, "records.jsonl"), before = new BackrunLedger({ file });
  for (let i = 1; i <= 4; i++) await journal(before, "b" + i, BACKRUN_PATH.slice(0, i), { triggerHash: hash(i), mode: "LIVE" });
  const service = restartedService(file, new TradeLedger({ file: null }));
  const recovered = await service.recoverAfterRestart();
  const statuses = service.ledger.recent(10).map(r => r.status);
  const passed = statuses.length === 4 && statuses.every(s => s === "REJECTED") && recovered.expired === 4;
  return { name: "crash before signing: queued, quoted, funded and simulated rows expire", passed, detail: { recovered, statuses } };
}

async function crashBeforeSubmission(dir) {
  const file = path.join(dir, "executions.jsonl"), before = new TradeLedger({ file });
  await journal(before, "live-discovered", ["DISCOVERED"], { mode: "LIVE" });
  await journal(before, "live-simulated", ["DISCOVERED", "SIMULATED"], { mode: "LIVE" });
  await journal(before, "paper-simulated", ["DISCOVERED", "SIMULATED"], { mode: "PAPER" });
  const after = new TradeLedger({ file }), expired = await after.expireUnsubmitted();
  const status = id => after.records.get(id).status;
  const passed = expired.length === 2 && status("live-discovered") === "DROPPED" && status("live-simulated") === "DROPPED" &&
    after.records.get("live-simulated").reason === "restarted_before_submission" && status("paper-simulated") === "SIMULATED" &&
    after.pending().length === 0;
  return { name: "crash after LIVE intent but before submission: dropped, PAPER untouched", passed,
    detail: { expired: expired.map(r => r.id), paper: status("paper-simulated") } };
}

async function crashAfterSubmission(dir) {
  const tradeFile = path.join(dir, "executions.jsonl"), backrunFile = path.join(dir, "records.jsonl");
  const trades = new TradeLedger({ file: tradeFile }), backruns = new BackrunLedger({ file: backrunFile }), trigger = hash(0xbeef);
  await journal(trades, "exec-1", ["DISCOVERED", "SIMULATED", "SUBMITTED"], { mode: "LIVE", strategy: "TRANSACTION_TRIGGERED_BACKRUN",
    triggerHash: trigger, txHash: hash(0xfeed), targetBlock: 101 });
  // The process died before the backrun row recorded the submission.
  await journal(backruns, "row-1", BACKRUN_PATH, { triggerHash: trigger, mode: "LIVE" });

  const restartedTrades = new TradeLedger({ file: tradeFile });
  await restartedTrades.expireUnsubmitted();
  const service = restartedService(backrunFile, restartedTrades), recovered = await service.recoverAfterRestart();
  const linked = service.ledger.records.get("row-1");
  const blocked = await liveHarness({ ledger: restartedTrades });

  // Receipt reconciliation: no receipt well past the target block.
  const bot = new ExecutionEngine({ ledger: restartedTrades, profile: { confirmations: 2 },
    provider: { getBlockNumber: async () => 200, getTransactionReceipt: async () => null } });
  await bot.reconcile(); await service.reconcile();
  const settled = service.ledger.records.get("row-1"), resumed = await liveHarness({ ledger: restartedTrades });

  const checks = {
    pendingKept: blocked.pendingSubmissions >= 1,
    signingBlockedWhilePending: blocked.outcome === "DROP_BEFORE_SIGN" && blocked.signatures === 0,
    rowLinked: recovered.linked === 1 && linked.status === "SUBMITTED" && linked.executionId === "exec-1",
    rowSettled: settled.status === "DROPPED" && settled.executionId === "exec-1",
    signingResumesAfterSettlement: resumed.outcome === "SUBMITTED",
  };
  return { name: "crash after submission intent: held pending, linked, reconciled, then resumed",
    passed: Object.values(checks).every(Boolean), detail: { checks, recovered, blocked: blocked.error } };
}

async function tornJournal(dir) {
  const tradeFile = path.join(dir, "torn-executions.jsonl"), backrunFile = path.join(dir, "torn-records.jsonl");
  const trades = new TradeLedger({ file: tradeFile }), backruns = new BackrunLedger({ file: backrunFile });
  await journal(trades, "t1", ["DISCOVERED"], { mode: "PAPER" });
  await journal(backruns, "r1", ["DETECTED"], { mode: "PAPER", triggerHash: hash(1) });
  fs.appendFileSync(tradeFile, '{"id":"t2","status":"SUBM'); fs.appendFileSync(backrunFile, '{"id":"r2","sta');
  const t = new TradeLedger({ file: tradeFile }), b = new BackrunLedger({ file: backrunFile });
  const corrupt = path.join(dir, "corrupt.jsonl");
  fs.writeFileSync(corrupt, '{"id":"a","status":"DISCOVERED","updatedAt":1}\n{not json}\n{"id":"b","status":"DISCOVERED","updatedAt":2}\n');
  let corruptionRefused = false;
  try { new TradeLedger({ file: corrupt }); } catch (_) { corruptionRefused = true; }
  const passed = t.records.size === 1 && t.tornWrites === 1 && b.records.size === 1 && b.tornWrites === 1 && corruptionRefused;
  return { name: "torn final journal write skipped; mid-file corruption stops startup", passed,
    detail: { tradeRecords: t.records.size, backrunRecords: b.records.size, corruptionRefused } };
}

async function runRecoveryValidation() {
  const dir = tempDir();
  try {
    const results = [];
    for (const scenario of [crashBeforeSigning, crashBeforeSubmission, crashAfterSubmission, tornJournal]) {
      const sub = fs.mkdtempSync(path.join(dir, "s-"));
      try { results.push(await scenario(sub)); }
      catch (error) { results.push({ name: scenario.name, passed: false, error: error.message }); }
    }
    return { kind: "RESTART_RECOVERY", scenarios: results.length, failed: results.filter(r => !r.passed).map(r => r.name),
      results, passed: results.every(r => r.passed) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { runRecoveryValidation };
