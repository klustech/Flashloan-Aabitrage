const test = require("node:test"), assert = require("node:assert/strict");
const { runFailureInjection, liveHarness } = require("../../server/backrun/validation/failureInjection");

test("every injected failure is fail-closed and nothing is submitted despite an error", { timeout: 60000 }, async () => {
  const report = await runFailureInjection();
  assert.deepEqual(report.unsafe, []);
  assert.deepEqual(report.failed, []);
  assert.ok(report.scenarios >= 35);
  for (const category of ["control", "rpc", "trigger", "execution", "relay", "database", "fork"])
    assert.ok(report.results.some(r => r.category === category), category);
});

test("a LIVE public-pending backrun reaches the relays after recording its own submission intent", async () => {
  // Regression: the per-relay guard counted the engine's own SUBMITTED record
  // as another pending execution, so no bundle was ever sent.
  const r = await liveHarness();
  assert.equal(r.outcome, "SUBMITTED", r.error);
  assert.equal(r.signatures, 1);
  assert.equal(r.relaySubmissions, 2);
  assert.equal(r.pendingSubmissions, 1);
});

test("a different pending LIVE submission still blocks signing", async () => {
  const r = await liveHarness({ fault: { pendingSubmission: true } });
  assert.equal(r.outcome, "DROP_BEFORE_SIGN");
  assert.equal(r.signatures, 0);
});
