const { providers, Contract } = require("ethers");
const { Client } = require("pg");
const { productionProfile } = require("../server/config/productionProfile");
const {
  paperOnly,
  assertPaperConfiguration,
} = require("../server/config/paperPolicy");
const { startupChecks } = require("../server/bot/readiness");
const { writableRuntime } = require("../server/bot/paperHealth");
const path = require("path");
const fs = require("fs");
function loadEnvironment() {
  require("dotenv").config({
    path: process.env.PAPER_ENV_FILE || ".env.mainnet-paper",
    override: false,
  });
}
function requireValue(value, message) {
  if (!value) throw new Error(message);
}
function loopback(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}
async function websocketBlock(url, timeoutMs = 30000) {
  const ws = new providers.WebSocketProvider(url);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("WebSocket block timeout")),
        timeoutMs
      );
      // Request the network over this transport before accepting a block.
      ws.getNetwork().then((network) => {
        if (network.chainId !== 1)
          return reject(new Error("WebSocket chain ID mismatch"));
        ws.once("block", resolve);
      }, reject);
      ws.on("error", () => reject(new Error("WebSocket transport failed")));
      ws._websocket?.on("error", () =>
        reject(new Error("WebSocket transport failed"))
      );
    });
  } finally {
    clearTimeout(timer);
    await ws.destroy();
  }
}
async function checkDatabase(env) {
  for (const key of ["PG_USER", "PG_HOST", "PG_DB", "PG_PASSWORD", "PG_PORT"])
    requireValue(env[key], `${key} missing`);
  const client = new Client({
    user: env.PG_USER,
    host: env.PG_HOST,
    database: env.PG_DB,
    password: env.PG_PASSWORD,
    port: Number(env.PG_PORT),
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  try {
    await client.connect();
    await client.query(
      "SELECT id, mode, status, borrow_token, token_decimals, tx_hash, payload, updated_at FROM executions LIMIT 0"
    );
    const counts = await client.query(
      "SELECT COUNT(*)::int AS count FROM executions WHERE mode='LIVE'"
    );
    requireValue(
      counts.rows[0].count === 0,
      "Use a dedicated PAPER database without historical LIVE records"
    );
  } finally {
    await client.end();
  }
}
async function preflight({
  env = process.env,
  provider,
  contract,
  checkDb = checkDatabase,
  checkWs = websocketBlock,
  checkRuntime = writableRuntime,
  checkExecutor = startupChecks,
} = {}) {
  const checks = [],
    check = async (name, fn) => {
      try {
        const detail = await fn();
        checks.push({ name, passed: true, detail });
      } catch (_) {
        checks.push({ name, passed: false });
      }
    };
  // Keep RPC URLs, database credentials and provider error payloads out of reports.
  await check("production mode", () =>
    requireValue(env.NODE_ENV === "production", "NODE_ENV")
  );
  await check("PAPER-only / no private key", () => {
    requireValue(paperOnly(env), "PAPER_ONLY");
    assertPaperConfiguration(env);
  });
  await check("public fallback disabled", () =>
    requireValue(env.ALLOW_PUBLIC_MEMPOOL_FALLBACK === "false", "fallback")
  );
  await check("backrun order-flow configuration", () => {
    const profile = productionProfile(env);
    if (profile.backrun.enabled)
      requireValue(profile.backrun.orderflowSource !== "disabled", "BACKRUN_ORDERFLOW_SOURCE");
  });
  await check("API authentication", () =>
    requireValue(String(env.API_KEY || "").trim(), "API_KEY")
  );
  await check("host loopback bindings", () => {
    requireValue(loopback(env.API_BIND_HOST || "127.0.0.1"), "API");
    requireValue(loopback(env.DASHBOARD_BIND_HOST || "127.0.0.1"), "dashboard");
    requireValue(
      (env.DASHBOARD_ALLOWED_HOSTS || "localhost,127.0.0.1")
        .split(",")
        .every((host) => loopback(host.trim())),
      "hosts"
    );
  });
  let profile;
  await check("deterministic profile", () => {
    profile = productionProfile(env);
    requireValue(!env.CHAIN_ID || env.CHAIN_ID === "1", "CHAIN_ID");
    return {
      tokens: profile.tokenSymbols,
      borrow: profile.borrowSymbols,
      fingerprint: profile.fingerprint,
    };
  });
  await check("Ethereum HTTP / EIP-1559", async () => {
    requireValue(env.MAINNET_RPC_URL, "MAINNET_RPC_URL");
    provider ||= new providers.JsonRpcProvider({
      url: env.MAINNET_RPC_URL,
      timeout: 10000,
    });
    requireValue((await provider.getNetwork()).chainId === 1, "chainId");
    const block = await provider.getBlock("latest");
    requireValue(block?.hash && block.baseFeePerGas, "head");
    return { block: block.number };
  });
  await check("mainnet WebSocket block", async () => {
    requireValue(env.MAINNET_WEBSOCKET, "MAINNET_WEBSOCKET");
    return { block: await checkWs(env.MAINNET_WEBSOCKET) };
  });
  await check("executor / Aave / routers", async () => {
    requireValue(
      profile && provider && profile.contractAddress && profile.operatorAddress,
      "executor config"
    );
    contract ||= new Contract(
      profile.contractAddress,
      require("../server/abis/ArbitrageFlashloan.json"),
      provider
    );
    const report = await checkExecutor({
      provider,
      contract,
      profile,
      operatorAddress: profile.operatorAddress,
      requireSignerGas: false,
    });
    for (const item of report.checks || [])
      checks.push({ name: `executor ${item.name}`, passed: item.passed });
    requireValue(report.ready, "executor checks");
    for (const address of [
      profile.flashloanProvider.addressesProvider,
      profile.flashloanProvider.lendingPool,
    ])
      requireValue((await provider.getCode(address)) !== "0x", "Aave bytecode");
  });
  await check("PostgreSQL / execution schema / clean PAPER history", () =>
    checkDb(env)
  );
  await check("runtime evidence writable / clean journal", () => {
    const files = [
      env.EXECUTION_LEDGER_PATH || "runtime/executions.jsonl",
      env.PAPER_BURN_IN_PATH || "runtime/paper-burn-in.json",
      env.POOL_CACHE_PATH || "runtime/pool-topology.json",
      env.SETTINGS_FILE || "runtime/operator-settings.json",
    ];
    for (const file of files) {
      checkRuntime(path.dirname(file));
      if (fs.existsSync(file))
        fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
    }
    if (fs.existsSync(files[0]))
      for (const line of fs
        .readFileSync(files[0], "utf8")
        .split("\n")
        .filter(Boolean))
        requireValue(JSON.parse(line).mode !== "LIVE", "LIVE journal");
  });
  return { ready: checks.every((c) => c.passed), checks };
}
function printReport(report, label) {
  console.log(label);
  for (const check of report.checks)
    console.log(
      `${check.passed ? "PASS" : "FAIL"}  ${check.name}${
        check.detail ? "  " + JSON.stringify(check.detail) : ""
      }`
    );
  console.log(
    report.ready
      ? "READY FOR MAINNET PAPER"
      : `NOT READY: ${
          report.checks.filter((c) => !c.passed).length
        } blocking checks`
  );
}
if (require.main === module) {
  loadEnvironment();
  preflight()
    .then((report) => {
      printReport(report, "MAINNET PAPER PREFLIGHT — no trading started");
      process.exitCode = report.ready ? 0 : 1;
    })
    .catch(() => {
      console.error("PAPER preflight failed");
      process.exitCode = 1;
    });
}
module.exports = {
  preflight,
  checkDatabase,
  websocketBlock,
  loadEnvironment,
  printReport,
};
