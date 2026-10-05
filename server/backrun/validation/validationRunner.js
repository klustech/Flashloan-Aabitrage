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
    // Test steps run through scripts/run-core-tests.js, which isolates them from
    // the operator environment (PAPER_ONLY, database, fork RPC).
    { id: "core-tests", command: node, args: ["scripts/run-core-tests.js"], evidence: "step-core-tests" },
    { id: "contract-tests", command: node, args: ["scripts/run-core-tests.js", "--hardhat"], evidence: "step-contract-tests" },
    { id: "static-analysis", evidence: "step-static-analysis", sequence: [
      { tool: "slither", args: [".", "--compile-force-framework", "hardhat", "--hardhat-ignore-compile", "--exclude-dependencies",
        "--filter-paths", "contracts/mocks", "--fail-high"] },
      { command: node, args: ["scripts/audit-gate.js"] }] },
    { id: "fork-tests", evidence: "step-fork-tests", env: forkEnv, requiresEnv: "LOCAL_BACKRUN_TEST_RPC", noSkips: true,
      command: node, args: ["scripts/run-core-tests.js", "--fork"] },
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
  return { status: r.error ? null : r.status, signal: r.signal || null, error: r.error ? r.error.code || r.error.message : null,
    stdout: r.stdout || "", stderr: (r.stderr || "") + (r.error ? String(r.error.message) : "") };
}

// Slither is a Python tool: use SLITHER_BIN, then `slither` on PATH, then
// `python3 -m slither`. A missing tool is a named failure, never "exit null".
const SLITHER_HELP = "install it with `pip install slither-analyzer==0.11.6` or set SLITHER_BIN";
function resolveTool(tool, env, exec) {
  if (tool !== "slither") return { command: tool, prefix: [] };
  const candidates = [...(env.SLITHER_BIN ? [[env.SLITHER_BIN]] : []), ["slither"], ["python3", "-m", "slither"]];
  for (const [command, ...prefix] of candidates) {
    const r = exec(command, [...prefix, "--version"], { env });
    if (r.status === 0) return { command, prefix, version: String(r.stdout || r.stderr).trim().split("\n")[0] };
  }
  return null;
}

function failureReason(r) {
  if (r.status !== null && r.status !== undefined) return `exit ${r.status}`;
  if (r.error) return `could not start (${r.error})`;
  if (r.signal) return `killed by ${r.signal}`;
  return "no exit status";
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
  let reason = null;
  for (const part of step.sequence || [step]) {
    let command = part.command, args = part.args, tool = null;
    if (part.tool) {
      tool = resolveTool(part.tool, childEnv, exec);
      if (!tool) { reason = `${part.tool} not found: ${SLITHER_HELP}`; runs.push({ command: part.tool, exitCode: null, error: "not found" }); break; }
      command = tool.command; args = [...tool.prefix, ...part.args];
    }
    log(`→ ${step.id}: ${[command, ...args].join(" ")}`);
    const r = exec(command, args, { env: childEnv });
    runs.push({ command: [path.basename(command), ...args].join(" "), toolVersion: tool?.version, exitCode: r.status,
      signal: r.signal || null, error: r.error || null, output: tail(r.stdout + "\n" + r.stderr) });
    if (r.status !== 0) {
      // A tool may explain its own failure on a final "REASON: ..." line.
      const own = String(r.stderr || "").match(/^REASON: (.+)$/m);
      reason = own ? own[1].trim() : `${path.basename(command)}: ${failureReason(r)}`; break;
    }
  }
  let passed = reason === null;
  if (passed && step.noSkips && !/(#|ℹ) skipped 0\b/.test(runs.map(r => r.output).join("\n"))) { passed = false; reason = "tests were skipped"; }
  const manifest = manifestFor();
  if (step.evidence) writeEvidence(step.evidence, { passed, reason, durationMs: Date.now() - started, runs }, manifest, { env });
  // A gate CLI's own verdict explains more than its exit status.
  if (step.gateEvidence) for (const name of step.gateEvidence) {
    const { ok, reason: why, record } = readEvidence(name, { manifest, env });
    if (!ok || record.passed !== true) {
      passed = false;
      const detail = !ok ? why : `${name}: ${record.reason || (record.failed || [])[0] || "failed"}`;
      reason = reason && /^[^:]+: exit \d+$/.test(reason) ? detail : reason || detail;
    }
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

module.exports = { runValidation, runStep, steps, redact, resolveTool, failureReason };
