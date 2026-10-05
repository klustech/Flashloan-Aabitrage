const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { runValidation, redact } = require("../../server/backrun/validation/validationRunner");
const { ACCEPTANCE, evaluateAcceptance, writeValidationReport, localValidationStatus, DAY } = require("../../server/backrun/validation/acceptance");
const { writeEvidence, readEvidence } = require("../../server/backrun/validation/validationEvidence");
const { replayGate } = require("../../scripts/backrun-economic-gates");
const { EXECUTOR_VERSION } = require("../../server/config/executorVersion");

const manifest = { manifestId: "0x" + "11".repeat(32), gitCommit: "abc", gitDirty: false, solcVersion: "0.8.20",
  executorVersion: EXECUTOR_VERSION, executorCodeHash: "0x" + "22".repeat(32), profileFingerprint: "fp" };
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "val-"));
  return { dir, env: { BACKRUN_VALIDATION_DIR: dir, PATH: process.env.PATH }, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("runner records step evidence, strips PRIVATE_KEY and stops at the first required failure", async () => {
  const { env, done } = sandbox(), seen = [];
  try {
    const exec = (command, args, { env: child }) => { seen.push({ args, key: child.PRIVATE_KEY });
      return args.includes("test:core") ? { status: 1, stdout: "fail at https://rpc.example/v2/SECRETKEY", stderr: "" } : { status: 0, stdout: "", stderr: "" }; };
    const r = await runValidation({ env: { ...env, PRIVATE_KEY: "0xabc" }, exec, manifestFor: () => manifest, log: () => {} });
    assert.deepEqual(r.results.map(x => [x.id, x.passed]), [["compiler", true], ["core-tests", false]]);
    assert.equal(r.passed, false);
    assert.ok(seen.every(s => s.key === undefined));
    const { record } = readEvidence("step-core-tests", { manifest, env });
    assert.equal(record.passed, false);
    assert.ok(!JSON.stringify(record).includes("SECRETKEY"));
  } finally { done(); }
});

test("fork tests require a local fork and refuse skipped tests; gate CLIs need their evidence", async () => {
  const { env, done } = sandbox();
  try {
    const ok = () => ({ status: 0, stdout: "# pass 3\n# skipped 2\n", stderr: "" });
    let r = await runValidation({ env, exec: ok, manifestFor: () => manifest, only: ["fork-tests"], log: () => {} });
    assert.match(r.results[0].reason, /LOCAL_BACKRUN_TEST_RPC/);
    r = await runValidation({ env: { ...env, LOCAL_BACKRUN_TEST_RPC: "http://127.0.0.1:8548" }, exec: ok, manifestFor: () => manifest, only: ["fork-tests"], log: () => {} });
    assert.equal(r.results[0].reason, "tests were skipped");
    r = await runValidation({ env, exec: ok, manifestFor: () => manifest, only: ["latency"], log: () => {} });
    assert.equal(r.results[0].passed, false);
    assert.match(r.results[0].reason, /evidence missing/);
  } finally { done(); }
});

test("redaction keeps hosts and drops key-shaped material", () => {
  const out = redact("wss://eth.example.com/ws/v3/abcdef key 0x" + "ab".repeat(32));
  assert.ok(out.includes("wss://eth.example.com/…") && !out.includes("abcdef") && !out.includes("ab".repeat(32)));
});

test("acceptance: local validation, PAPER readiness and the preflight status", () => {
  const { env, done } = sandbox();
  try {
    for (const g of ACCEPTANCE) writeEvidence(g.evidence, { passed: true }, manifest, { env });
    const profile = { expectedContractCodeHash: "0x" + "33".repeat(32) };
    let a = evaluateAcceptance({ manifest, profile, env });
    assert.equal(a.localValidationPassed, true); assert.equal(a.readyForPaper, true);
    assert.equal(evaluateAcceptance({ manifest, profile: {}, env }).readyForPaper, false);
    assert.equal(evaluateAcceptance({ manifest: { ...manifest, gitDirty: true }, profile, env }).readyForPaper, false);

    writeValidationReport({ manifest, profile, env });
    assert.equal(localValidationStatus({ manifest, env }).ok, true);
    assert.match(localValidationStatus({ manifest: { ...manifest, manifestId: "0x" + "99".repeat(32) }, env }).reason, /different code/);
    assert.match(localValidationStatus({ manifest, env, now: () => Date.now() + 8 * DAY }).reason, /older/);

    writeEvidence("gas-stress", { passed: false, reason: "accepted_below_minimum", unsafe: ["x"] }, manifest, { env });
    a = evaluateAcceptance({ manifest, profile, env });
    assert.deepEqual(a.failedRequired, ["gas-stress"]);
    writeValidationReport({ manifest, profile, env });
    assert.match(localValidationStatus({ manifest, env }).reason, /local validation failed: gate gas-stress/);
  } finally { done(); }
});

test("canonical replay gate binds reports to this executor build and rejects unsafe executions", () => {
  const good = { executionSucceeded: true, canonicalReceiptsVerified: true, sameBlock: true, principalPreserved: true };
  const report = (over = {}, rows = [good]) => ({ kind: "LOCAL_EXECUTOR_SIZE_FEE_SWEEP", status: "finished", executorVersion: EXECUTOR_VERSION,
    executorArtifactHash: manifest.executorCodeHash, results: rows, ...over });
  assert.equal(replayGate({ sweep: report(), rows: [1] }, manifest).passed, true);
  assert.match(replayGate({ sweep: report({ executorArtifactHash: "0x00" }), rows: [1] }, manifest).reason, /different executor build/);
  assert.match(replayGate({ sweep: report({ executorVersion: undefined }), rows: [1] }, manifest).reason, /unrecorded/);
  assert.match(replayGate({ sweep: report({}, [{ ...good, principalPreserved: false }]), rows: [1] }, manifest).reason, /preserved principal/);
  assert.match(replayGate({ sweep: report(), rows: [] }, manifest).reason, /no measured/);
});
