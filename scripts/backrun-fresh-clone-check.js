// Fresh-clone reproduction (blueprint §41): a clean clone of the committed
// HEAD, installed from the lockfiles, must build the identical executor
// runtime bytecode and pass test:core and the failure/recovery gates. Proves
// results do not depend on local, uncommitted or cached state.
// Usage: node scripts/backrun-fresh-clone-check.js [--keep]
const fs = require("fs"), os = require("os"), path = require("path");
const { execFileSync } = require("child_process");
const { executorCodeHash } = require("../server/backrun/validation/validationEvidence");

const ROOT = path.resolve(__dirname, "..");
const run = (cmd, args, cwd, env = {}) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
  env: { ...process.env, PRIVATE_KEY: "", LOCAL_BACKRUN_TEST_RPC: "", ...env }, maxBuffer: 256 << 20 });

function main(argv = process.argv.slice(2)) {
  const head = run("git", ["rev-parse", "HEAD"], ROOT).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-clone-")), checks = {};
  try {
    run("git", ["clone", "--quiet", "--no-local", ROOT, dir], ROOT);
    run("git", ["checkout", "--quiet", head], dir);
    run("npm", ["ci", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], dir);
    run("npm", ["ci", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], path.join(dir, "server"));
    run("npx", ["hardhat", "compile", "--force"], dir);
    checks.sameExecutorBytecode = executorCodeHash(dir) === executorCodeHash(ROOT);
    const env = { BACKRUN_VALIDATION_DIR: path.join(dir, "runtime/fresh"), BACKRUN_EVIDENCE_MANIFEST: path.join(dir, "runtime/fresh/m.json") };
    for (const [name, args] of [["coreTests", ["run", "test:core"]], ["failureInjection", ["run", "backrun:validate:failure"]],
      ["restartRecovery", ["run", "backrun:validate:recovery"]]]) {
      try { run("npm", args, dir, env); checks[name] = true; } catch (error) { checks[name] = false; checks[name + "Output"] = String(error.stdout || "").split("\n").slice(-15).join("\n"); }
    }
    const passed = ["sameExecutorBytecode", "coreTests", "failureInjection", "restartRecovery"].every(k => checks[k] === true);
    const result = { kind: "FRESH_CLONE_CHECK", commit: head, checks, passed };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally { if (!argv.includes("--keep")) fs.rmSync(dir, { recursive: true, force: true }); }
}

if (require.main === module) {
  try { process.exitCode = main().passed ? 0 : 1; } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
