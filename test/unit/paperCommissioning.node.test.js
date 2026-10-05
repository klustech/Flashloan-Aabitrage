const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
const {
  readSettings,
  writeSettings,
  initialSettings,
  productionOverrides,
} = require("../../server/utils/settingsPersistence");
const { settingsDefaults } = require("../../server/utils/settingsSchema");
const { TradingStateMachine } = require("../../server/bot/stateMachine");
const { ExecutionEngine } = require("../../server/bot/executionEngine");
const { productionProfile } = require("../../server/config/productionProfile");
const { assertPaperConfiguration } = require("../../server/config/paperPolicy");
const { preflight } = require("../../scripts/paper-preflight");
const { smoke } = require("../../scripts/paper-smoke");
const A = "0x0000000000000000000000000000000000000001";
const log = { warn: () => {}, error: () => {} };
test("saved settings survive restart with metadata stripped and auto-start disabled", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "paper-settings-")),
    file = path.join(folder, "settings.json");
  try {
    const original = {
      ...settingsDefaults,
      botActive: true,
      pollingInterval: 42,
      gasPriceCeiling: 70,
    };
    assert.equal(writeSettings(file, original, log), true);
    assert.ok(JSON.parse(fs.readFileSync(file))._savedAt);
    const loaded = readSettings(file, log);
    assert.deepEqual(loaded, original);
    const restarted = initialSettings(loaded, {}, log);
    assert.equal(restarted.pollingInterval, 42);
    assert.equal(restarted.gasPriceCeiling, 70);
    assert.equal(restarted.botActive, false);
    assert.equal(restarted._savedAt, undefined);
    assert.equal(
      productionOverrides(restarted, loaded, {}).gasCeilingGwei,
      "70"
    );
    assert.deepEqual(productionOverrides(restarted, null, {}), {});
    assert.equal(
      initialSettings(loaded, { GAS_PRICE_CEILING: "90" }, log).gasPriceCeiling,
      90
    );
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
test("corrupt JSON and unknown stored settings produce explicit safe fallback", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "paper-settings-")),
    file = path.join(folder, "settings.json");
  let warnings = 0;
  try {
    for (const content of [
      "{bad",
      JSON.stringify({ ...settingsDefaults, realUnknownSetting: 1 }),
    ]) {
      fs.writeFileSync(file, content);
      assert.equal(readSettings(file, { warn: () => warnings++ }), null);
    }
    assert.equal(warnings, 2);
    assert.equal(initialSettings(null, {}, log).botActive, false);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
test("PAPER_ONLY rejects keys, invalid flags, arming, direct LIVE state and spoofed signing state", async () => {
  assert.throws(
    () =>
      assertPaperConfiguration({ PAPER_ONLY: "true", PRIVATE_KEY: "secret" }),
    /PRIVATE_KEY/
  );
  assert.throws(() => productionProfile({ PAPER_ONLY: "typo" }), /PAPER_ONLY/);
  const old = process.env.PAPER_ONLY;
  process.env.PAPER_ONLY = "true";
  try {
    const state = new TradingStateMachine();
    state.paper();
    assert.throws(() => state.arm({ ready: true }), /PAPER_ONLY/);
    assert.throws(() => state.live(), /PAPER_ONLY/);
    assert.throws(() => state.set("LIVE_RUNNING"), /PAPER_ONLY/);
    state.state = "LIVE_RUNNING";
    assert.equal(state.canSign(), false);
    let signed = 0;
    const engine = new ExecutionEngine({
      state: { canSign: () => true },
      profile: { paperOnly: true },
      wallet: { signTransaction: () => signed++ },
    });
    await assert.rejects(engine.execute({ record: {} }, {}), /PAPER_ONLY/);
    assert.equal(signed, 0);
    assert.deepEqual(engine.activity, { signatures: 0, submissions: 0 });
  } finally {
    if (old === undefined) delete process.env.PAPER_ONLY;
    else process.env.PAPER_ONLY = old;
  }
  assert.equal(productionProfile({ PAPER_ONLY: "true" }).paperOnly, true);
});
test("backrun profile is disabled by default, WETH-first and validates funding/source modes", () => {
  const profile = productionProfile({ PAPER_ONLY: "true" });
  assert.equal(profile.backrun.enabled, false);
  assert.deepEqual(profile.backrun.borrowSymbols, ["WETH", "DAI", "USDC"]);
  assert.equal(profile.backrun.fundingMode, "adaptive");
  assert.equal(profile.backrun.orderflowSource, "disabled");
  assert.throws(
    () => productionProfile({ PAPER_ONLY: "true", BACKRUN_FUNDING_MODE: "magic" }),
    /BACKRUN_FUNDING_MODE/
  );
  assert.throws(
    () => productionProfile({ PAPER_ONLY: "true", BACKRUN_ORDERFLOW_SOURCE: "mystery" }),
    /BACKRUN_ORDERFLOW_SOURCE/
  );
  assert.throws(
    () => productionProfile({
      PAPER_ONLY: "true",
      BACKRUN_ENABLED: "true",
      BACKRUN_ORDERFLOW_SOURCE: "mev_share",
    }),
    /BACKRUN_MIN_PROFIT_WETH/
  );
  const enabled = productionProfile({
    PAPER_ONLY: "true",
    BACKRUN_ENABLED: "true",
    BACKRUN_ORDERFLOW_SOURCE: "mev_share",
    BACKRUN_MIN_PROFIT_WETH: "0.00001",
    BACKRUN_MAX_AMOUNT_WETH: "1",
    BACKRUN_MIN_PROFIT_DAI: "1",
    BACKRUN_MAX_AMOUNT_DAI: "50000",
    BACKRUN_MIN_PROFIT_USDC: "1",
    BACKRUN_MAX_AMOUNT_USDC: "50000",
  });
  assert.equal(enabled.backrun.enabled, true);
  assert.equal(enabled.backrun.minimumProfitBySymbol.WETH, "0.00001");
  assert.equal(enabled.backrun.maxAmountBySymbol.WETH, "1");
});

function preflightFixture() {
  return {
    env: {
      NODE_ENV: "production",
      PAPER_ONLY: "true",
      PRIVATE_KEY: "",
      ALLOW_PUBLIC_MEMPOOL_FALLBACK: "false",
      API_KEY: "test",
      MAINNET_RPC_URL: "http://example.invalid",
      MAINNET_WEBSOCKET: "ws://example.invalid",
      CONTRACT_ADDRESS: A,
      OPERATOR_ADDRESS: A,
      PG_USER: "test",
      PG_HOST: "localhost",
      PG_DB: "paper",
      PG_PASSWORD: "test",
      PG_PORT: "5432",
      EXECUTION_LEDGER_PATH: path.join(
        os.tmpdir(),
        "nonexistent-paper-test",
        "executions.jsonl"
      ),
    },
    provider: {
      getNetwork: async () => ({ chainId: 1 }),
      getBlock: async () => ({ number: 123, hash: "0xabc", baseFeePerGas: 1 }),
      getCode: async () => "0x60",
    },
    contract: {},
    checkDb: async () => {},
    checkWs: async () => 124,
    checkRuntime: () => {},
    checkExecutor: async () => ({ ready: true }),
  };
}
test("preflight is read-only and does not require signer gas or signing", async () => {
  const f = preflightFixture();
  f.checkExecutor = async (options) => {
    assert.equal(options.requireSignerGas, false);
    return { ready: true };
  };
  const report = await preflight(f);
  assert.equal(report.ready, true);
  assert.ok(report.checks.every((c) => c.passed));
});
for (const [name, mutate, failed] of [
  [
    "wrong chain",
    (f) => (f.provider.getNetwork = async () => ({ chainId: 31337 })),
    "Ethereum HTTP / EIP-1559",
  ],
  [
    "missing executor",
    (f) => delete f.env.CONTRACT_ADDRESS,
    "executor / Aave / routers",
  ],
  [
    "bad database",
    (f) =>
      (f.checkDb = async () => {
        throw Error("secret-url");
      }),
    "PostgreSQL / execution schema / clean PAPER history",
  ],
  ["missing API key", (f) => delete f.env.API_KEY, "API authentication"],
  [
    "exposed host",
    (f) => (f.env.API_BIND_HOST = "0.0.0.0"),
    "host loopback bindings",
  ],
])
  test(`preflight detects ${name} without exposing credentials`, async () => {
    const f = preflightFixture();
    mutate(f);
    const report = await preflight(f);
    assert.equal(report.ready, false);
    assert.equal(report.checks.find((c) => c.name === failed).passed, false);
    assert.ok(!JSON.stringify(report).includes("secret-url"));
  });
function snapshot(n) {
  return {
    trading: { state: "PAPER" },
    safety: {
      paperOnly: true,
      hasPrivateKey: false,
      activity: { signatures: 0, submissions: 0 },
    },
    summary: { pending: 0 },
    executions: [],
    scanner: { received: n, scans: n, source: "http" },
    latency: {
      cache: { pools: 4, block: n, logFallbacks: 0 },
      candidates: { indexed: 8 },
    },
  };
}
test("smoke observes an actual HTTP API advancing with zero profitable simulations and no mutation requests", async () => {
  let n = 10;
  const methods = [];
  const http = require("http");
  const server = http.createServer((req, res) => {
    methods.push(req.method);
    assert.equal(req.headers["x-api-key"], "test");
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/trading") res.end(JSON.stringify(snapshot(++n)));
    else
      res.end(
        JSON.stringify({
          nodeEnv: "production",
          chainId: 1,
          block: n,
          database: true,
          runtimeWritable: true,
          liveRecords: 0,
        })
      );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const report = await smoke({
      env: {
        API_KEY: "test",
        PAPER_API_URL: `http://127.0.0.1:${server.address().port}`,
      },
      wait: async () => {},
      timeoutMs: 10,
      intervalMs: 1,
    });
    assert.equal(report.ready, true);
    assert.equal(report.checks[1].detail.profitableSimulations, 0);
    assert.ok(methods.every((m) => m === "GET"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("smoke rejects LIVE signing activity and stalled blocks", async () => {
  let data = snapshot(5);
  data.safety.activity.signatures = 1;
  const request = async (route) =>
    route.endsWith("paper-health")
      ? {
          nodeEnv: "production",
          chainId: 1,
          block: 5,
          database: true,
          runtimeWritable: true,
          liveRecords: 0,
        }
      : data;
  let report = await smoke({
    env: { API_KEY: "test" },
    request,
    wait: async () => {},
    timeoutMs: 2,
    intervalMs: 1,
  });
  assert.equal(report.ready, false);
  data = snapshot(5);
  report = await smoke({
    env: { API_KEY: "test" },
    request,
    wait: async () => {},
    timeoutMs: 2,
    intervalMs: 1,
  });
  assert.equal(report.ready, false);
  assert.match(report.checks[0].name, /progress timeout/);
});
test("backrun PAPER preflight requires a passing local validation report", async () => {
  const f = preflightFixture();
  Object.assign(f.env, { BACKRUN_ENABLED: "true", BACKRUN_ORDERFLOW_SOURCE: "mev_share",
    BACKRUN_MIN_PROFIT_WETH: "0.001", BACKRUN_MAX_AMOUNT_WETH: "1", BACKRUN_MIN_PROFIT_DAI: "1", BACKRUN_MAX_AMOUNT_DAI: "1000",
    BACKRUN_MIN_PROFIT_USDC: "1", BACKRUN_MAX_AMOUNT_USDC: "1000" });
  f.checkExecutor = async () => ({ ready: true });
  f.checkValidation = () => { throw new Error("local validation failed: gate latency not passed"); };
  let report = await preflight(f);
  assert.equal(report.ready, false);
  assert.equal(report.checks.find((c) => c.name === "local validation report").passed, false);
  f.checkValidation = () => ({ gitCommit: "abc" });
  report = await preflight(f);
  assert.equal(report.checks.find((c) => c.name === "local validation report").passed, true);
  const disabled = preflightFixture();
  disabled.checkExecutor = async () => ({ ready: true });
  disabled.checkValidation = () => { throw new Error("must not run"); };
  assert.ok(!(await preflight(disabled)).checks.some((c) => c.name === "local validation report"));
});
