// Isolated test entry points (see scripts/lib/testEnv.js):
//   node scripts/run-core-tests.js            node:test unit suite, without fork tests
//   node scripts/run-core-tests.js --fork     fork tests only, serially, against LOCAL_BACKRUN_TEST_RPC
//   node scripts/run-core-tests.js --hardhat  Hardhat contract/security tests
// Exit status is the suite's own exit status.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { testEnv } = require("./lib/testEnv");

const ROOT = path.resolve(__dirname, "..");
// These connect to the shared local fork and must run serially, on request only.
const FORK_TESTS = ["test/unit/backrunFork.node.test.js", "test/unit/mevShareFork.node.test.js"];

function coreFiles(root = ROOT) {
  return fs.readdirSync(path.join(root, "test/unit")).filter(n => n.endsWith(".node.test.js")).sort()
    .map(n => "test/unit/" + n).filter(f => !FORK_TESTS.includes(f));
}

function plan(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--fork")) {
    if (!env.LOCAL_BACKRUN_TEST_RPC) throw new Error("LOCAL_BACKRUN_TEST_RPC is required (start: node scripts/backrun-fork-node.js --anvil)");
    return { command: process.execPath, args: ["--test", "--test-concurrency=1", ...FORK_TESTS],
      env: testEnv(env, { extra: { LOCAL_BACKRUN_TEST_RPC: env.LOCAL_BACKRUN_TEST_RPC,
        LOCAL_BACKRUN_TEST_ENGINE: env.LOCAL_BACKRUN_TEST_ENGINE || "anvil" } }) };
  }
  if (argv.includes("--hardhat"))
    return { command: process.execPath, args: [require.resolve("hardhat/internal/cli/cli"), "test"], env: testEnv(env) };
  return { command: process.execPath, args: ["--test", ...coreFiles()], env: testEnv(env) };
}

if (require.main === module) {
  try {
    const { command, args, env } = plan();
    const r = spawnSync(command, args, { cwd: ROOT, env, stdio: "inherit" });
    process.exitCode = r.status === null ? 1 : r.status;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { plan, coreFiles, FORK_TESTS };
