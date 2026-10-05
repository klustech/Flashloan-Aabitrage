// Ordered local validation run (blueprint §37). Each step is a command; the
// runner records its outcome as step evidence (test steps) or relies on the
// gate CLI's own evidence (economic, failure, recovery, latency), and stops at
// the first failed required step unless keepGoing is set. Nothing here
// needs or accepts a funded key, and nothing is submitted to mainnet.
const path = require("path");
const { spawnSync } = require("child_process");
const { writeEvidence, readEvidence } = require("./validationEvidence");

const ROOT = path.resolve(__dirname, "../../..");
const node = process.execPath;

function steps(env = process.env) {
  const forkEnv = { LOCAL_BACKRUN_TEST_RPC: env.LOCAL_BACKRUN_TEST_RPC, LOCAL_BACKRUN_TEST_ENGINE: env.LOCAL_BACKRUN_TEST_ENGINE || "anvil" };
  return [
    { id: "compiler", command: "npx", args: ["hardhat", "compile", "--force"], evidence: "step-compiler" },
    { id: "core-tests", command: "npm", args: ["run", "test:core"], evidence: "step-core-tests" },
    { id: "contract-tests", command: "npx", args: ["hardhat", "test"], evidence: "step-contract-tests" },
    { id: "static-analysis", evidence: "step-static-analysis", sequence: [
      { command: "slither", args: [".", "--compile-force-framework", "hardhat", "--hardhat-ignore-compile", "--exclude-dependencies",
        "--filter-paths", "contracts/mocks", "--fail-high"] },
      { command: node, args: ["scripts/audit-gate.js"] }] },
    { id: "fork-tests", evidence: "step-fork-tests", env: forkEnv, requiresEnv: "LOCAL_BACKRUN_TEST_RPC", noSkips: true,
      command: node, args: ["--test", "--test-concurrency=1", "test/unit/backrunFork.node.test.js", "test/unit/mevShareFork.node.test.js"] },
    { id: "economic-gates", command: node, args: ["scripts/backrun-economic-gates.js", "all"],
      gateEvidence: ["canonical-replay", "size-sweep", "gas-stress", "builder-competition", "liquidity-stress", "funding-parity"] },
    { id: "failure-injection", command: node, args: ["scripts/backrun-failure-test.js"], gateEvidence: ["failure-injection"] },
    { id: "restart-recovery", command: node, args: ["scripts/backrun-recovery-test.js"], gateEvidence: ["restart-recovery"] },
    { id: "fresh-clone", command: node, args: ["scripts/backrun-fresh-clone-check.js"], evidence: "step-fresh-clone" },
    { id: "latency", command: node, args: ["scripts/backrun-latency-benchmark.js"], gateEvidence: ["latency"] },
  ];
}

// Output tails go into evidence: keep URLs to their host (paths and query
// strings carry provider API keys) and drop anything shaped like a key.
function redact(text) {
  return String(text || "").replace(/\b(https?|wss?):\/\/([^/\s:]+)[^\s"']*/g, "$1://$2/…")
    .replace(/0x[0-9a-fA-F]{64}\b/g, m => m.slice(0, 10) + "…");
}
function tail(text, lines = 40) { return redact(text).split("\n").slice(-lines).join("\n"); }

function defaultExec(command, args, { env }) {
  const r = spawnSync(command, args, { cwd: ROOT, env, encoding: "utf8", maxBuffer: 256 << 20 });
  return { status: r.error ? null : r.status, stdout: r.stdout || "", stderr: (r.stderr || "") + (r.error ? String(r.error.message) : "") };
}

async function runStep(step, { env, exec, manifestFor, log }) {
  const started = Date.now(), childEnv = { ...env };
  // Fork tests share one local node and must run serially, so only the
  // fork step sees it; test:core would otherwise run them concurrently.
  delete childEnv.PRIVATE_KEY; delete childEnv.LOCAL_BACKRUN_TEST_RPC; delete childEnv.LOCAL_BACKRUN_TEST_ENGINE;
  Object.assign(childEnv, step.env || {});
  if (step.requiresEnv && !env[step.requiresEnv]) return { id: step.id, passed: false, durationMs: 0,
    reason: `${step.requiresEnv} not set (start a local fork: node scripts/backrun-fork-node.js --anvil)` };
  const runs = [];
  for (const part of step.sequence || [step]) {
    log(`→ ${step.id}: ${[part.command, ...part.args].join(" ")}`);
    const r = exec(part.command, part.args, { env: childEnv });
    runs.push({ command: [path.basename(part.command), ...part.args].join(" "), exitCode: r.status, output: tail(r.stdout + "\n" + r.stderr) });
    if (r.status !== 0) break;
  }
  let passed = runs.every(r => r.exitCode === 0), reason = passed ? null : `exit ${runs[runs.length - 1].exitCode}`;
  if (passed && step.noSkips && !/# skipped 0\b/.test(runs.map(r => r.output).join("\n"))) { passed = false; reason = "tests were skipped"; }
  const manifest = manifestFor();
  if (step.evidence) writeEvidence(step.evidence, { passed, reason, durationMs: Date.now() - started, runs }, manifest, { env });
  if (step.gateEvidence) for (const name of step.gateEvidence) {
    const { ok, reason: why, record } = readEvidence(name, { manifest, env });
    if (!ok || record.passed !== true) { passed = false; reason ||= why || `${name} failed`; }
  }
  return { id: step.id, passed, reason, durationMs: Date.now() - started };
}

async function runValidation({ env = process.env, exec = defaultExec, manifestFor, keepGoing = false, only, log = console.log } = {}) {
  const results = [];
  for (const step of steps(env).filter(s => !only || only.includes(s.id))) {
    const result = await runStep(step, { env, exec, manifestFor, log });
    results.push(result);
    log(`${result.passed ? "✓" : "✗"} ${step.id}${result.reason ? ` (${result.reason})` : ""}`);
    if (!result.passed && !keepGoing) break;
  }
  return { results, passed: results.length > 0 && results.every(r => r.passed) };
}

module.exports = { runValidation, runStep, steps, redact };
