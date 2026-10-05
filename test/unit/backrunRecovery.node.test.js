const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { runRecoveryValidation } = require("../../server/backrun/validation/recoveryValidation");
const { TradeLedger, readJournal } = require("../../server/bot/tradeLedger");

test("restart recovery scenarios all pass", async () => {
  const report = await runRecoveryValidation();
  assert.deepEqual(report.failed, [], JSON.stringify(report.results, null, 1));
  assert.equal(report.scenarios, 4);
});

test("only an unterminated final journal line is treated as a torn write", () => {
  const stats = {};
  assert.deepEqual(readJournal('{"id":"a"}\n{"id":"b', stats).map(r => r.id), ["a"]);
  assert.equal(stats.tornWrites, 1);
  assert.deepEqual(readJournal('{"id":"a"}\n', {}).map(r => r.id), ["a"]);
  assert.throws(() => readJournal('{"id":"a"}\n{bad}\n'));
});

test("expireUnsubmitted drops only LIVE pre-submission records", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), file = path.join(dir, "x.jsonl");
  try {
    const l = new TradeLedger({ file });
    await l.write({ id: "a", mode: "LIVE", status: "DISCOVERED" });
    await l.write({ id: "b", mode: "LIVE", status: "DISCOVERED" }); await l.write({ id: "b", status: "SIMULATED" });
    await l.write({ id: "b", status: "SUBMITTED" });
    await l.write({ id: "c", mode: "PAPER", status: "DISCOVERED" });
    const expired = await new TradeLedger({ file }).expireUnsubmitted();
    assert.deepEqual(expired.map(r => r.id), ["a"]);
    const after = new TradeLedger({ file });
    assert.equal(after.records.get("b").status, "SUBMITTED");
    assert.equal(after.records.get("c").status, "DISCOVERED");
    assert.equal(after.pending().length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
