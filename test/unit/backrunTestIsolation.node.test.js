const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { testEnv } = require("../../scripts/lib/testEnv");
const { plan, coreFiles, FORK_TESTS } = require("../../scripts/run-core-tests");
const { codeHash } = require("../../scripts/backrun-executor-code-hash");
const { utils } = require("ethers");

test("the test environment drops operator settings and neutralises local dotenv keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envtest-"));
  try {
    fs.writeFileSync(path.join(dir, ".env.mainnet-paper"), "PAPER_ONLY=true\nexport CUSTOM_SECRET=abc\nBACKRUN_ENABLED=true\n");
    const env = testEnv({ PATH: "/bin", HOME: "/h", HTTPS_PROXY: "http://proxy", PAPER_ONLY: "true", PRIVATE_KEY: "0x01", NODE_ENV: "production",
      PG_HOST: "db", LOCAL_BACKRUN_TEST_RPC: "http://127.0.0.1:8548", MAINNET_RPC_URL: "https://rpc/key", OTHER: "x" }, { root: dir });
    assert.deepEqual([env.PATH, env.HOME, env.HTTPS_PROXY], ["/bin", "/h", "http://proxy"]);
    assert.deepEqual([env.PAPER_ONLY, env.PRIVATE_KEY, env.PG_HOST, env.LOCAL_BACKRUN_TEST_RPC, env.MAINNET_RPC_URL], ["", "", "", "", ""]);
    assert.equal(env.CUSTOM_SECRET, "", "dotenv keys are pre-set so dotenv cannot inject them");
    assert.equal(env.BACKRUN_ENABLED, "");
    assert.equal(env.OTHER, undefined);
    assert.equal(env.NODE_ENV, "test");
    assert.ok(!fs.existsSync(env.PAPER_ENV_FILE));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("core tests exclude fork tests; fork tests run serially only against a configured fork", () => {
  const core = coreFiles();
  for (const f of FORK_TESTS) assert.ok(!core.includes(f), f);
  assert.ok(core.includes("test/unit/backrunTestIsolation.node.test.js"));
  assert.equal(plan([], { LOCAL_BACKRUN_TEST_RPC: "http://127.0.0.1:8548" }).env.LOCAL_BACKRUN_TEST_RPC, "");
  assert.throws(() => plan(["--fork"], {}), /LOCAL_BACKRUN_TEST_RPC is required/);
  const fork = plan(["--fork"], { LOCAL_BACKRUN_TEST_RPC: "http://127.0.0.1:8548", PAPER_ONLY: "true" });
  assert.deepEqual(fork.args.slice(0, 2), ["--test", "--test-concurrency=1"]);
  assert.deepEqual(fork.args.slice(2), FORK_TESTS);
  assert.deepEqual([fork.env.LOCAL_BACKRUN_TEST_RPC, fork.env.LOCAL_BACKRUN_TEST_ENGINE, fork.env.PAPER_ONLY], ["http://127.0.0.1:8548", "anvil", ""]);
});

test("executor code hash is read from a mainnet v4 executor and compared with configuration", async () => {
  const code = "0x6080604052", iface = new utils.Interface(["function executorVersion() view returns (uint256)"]);
  const provider = version => ({ getNetwork: async () => ({ chainId: 1 }), getCode: async () => code,
    call: async () => iface.encodeFunctionResult("executorVersion", [version]), _isProvider: true, resolveName: async a => a });
  const env = { CONTRACT_ADDRESS: "0x" + "11".repeat(20) };
  const r = await codeHash(env, provider(4));
  assert.deepEqual([r.codeHash, r.matches], [utils.keccak256(code), false]);
  assert.equal((await codeHash({ ...env, EXPECTED_CONTRACT_CODE_HASH: utils.keccak256(code) }, provider(4))).matches, true);
  await assert.rejects(codeHash(env, provider(3)), /v4 required/);
  await assert.rejects(codeHash({ ...env, PRIVATE_KEY: "0x01" }, provider(4)), /PRIVATE_KEY/);
});
