// Fresh-clone reproduction (blueprint §41): a clean clone of the committed
// HEAD, installed from the lockfiles, must build the identical executor
// runtime bytecode and pass test:core and the failure/recovery gates, using
// only the isolated test environment (no operator .env, PAPER_ONLY, database
// or fork settings). A failure names its stage on a final "REASON:" line.
// Usage: node scripts/backrun-fresh-clone-check.js [--keep]
const fs = require("fs"), os = require("os"), path = require("path");
const { spawnSync } = require("child_process");
const { executorCodeHash } = require("../server/backrun/validation/validationEvidence");
const { testEnv } = require("./lib/testEnv");

const ROOT = path.resolve(__dirname, "..");

function stage(name, command, args, cwd, env) {
  const r = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 256 << 20 });
  const ok = r.status === 0;
  const why = r.error ? `could not start ${command} (${r.error.code || r.error.message})` : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
  return { name, ok, detail: ok ? null : why, output: ok ? undefined : String((r.stdout || "") + (r.stderr || "")).split("\n").slice(-20).join("\n") };
}

function main(argv = process.argv.slice(2)) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-clone-")), stages = [];
  const env = testEnv(process.env, { root: dir, extra: { BACKRUN_VALIDATION_DIR: path.join(dir, "runtime/fresh"),
    BACKRUN_EVIDENCE_MANIFEST: path.join(dir, "runtime/fresh/m.json") } });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = (...a) => { const s = stage(...a); stages.push(s); return s.ok; };
  try {
    const ok = run("clone", "git", ["clone", "--quiet", "--no-local", ROOT, dir], ROOT, env)
      && run("checkout", "git", ["checkout", "--quiet", head], dir, env)
      && run("install", npm, ["ci", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], dir, env)
      && run("install server", npm, ["ci", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], path.join(dir, "server"), env)
      && run("compile", process.execPath, [require.resolve("hardhat/internal/cli/cli", { paths: [dir] }), "compile", "--force"], dir, env);
    let sameExecutorBytecode = false;
    if (ok) {
      sameExecutorBytecode = executorCodeHash(dir) === executorCodeHash(ROOT);
      stages.push({ name: "identical executor bytecode", ok: sameExecutorBytecode, detail: sameExecutorBytecode ? null : "runtime bytecode differs from this checkout" });
      run("test:core", process.execPath, ["scripts/run-core-tests.js"], dir, env);
      run("failure injection", process.execPath, ["scripts/backrun-failure-test.js"], dir, env);
      run("restart recovery", process.execPath, ["scripts/backrun-recovery-test.js"], dir, env);
    }
    const failed = stages.find(s => !s.ok);
    const result = { kind: "FRESH_CLONE_CHECK", commit: head, stages, passed: !failed && stages.length >= 9 };
    console.log(JSON.stringify(result, null, 2));
    if (failed) console.error(`REASON: ${failed.name}: ${failed.detail}`);
    return result;
  } finally { if (!argv.includes("--keep")) fs.rmSync(dir, { recursive: true, force: true }); }
}

if (require.main === module) {
  try { process.exitCode = main().passed ? 0 : 1; } catch (error) { console.error(`REASON: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main };
