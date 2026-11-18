#!/usr/bin/env node
"use strict";

// Deploys the v4 executor and a local governance timelock onto the local
// Hardhat fork. It refuses non-local endpoints and never uses a private key.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers, network } = hre;
const { productionProfile } = require("../server/config/productionProfile");

async function main() {
  process.env.PAPER_ONLY = "true";
  process.env.PRIVATE_KEY = "";

  if (network.name !== "localhost" || process.env.LOCAL_PAPER_FORK !== "true") {
    throw new Error("Refusing deployment: use the dedicated local-paper localhost network");
  }
  if (process.env.ENABLE_MAINNET_FORK !== "true") {
    throw new Error("Refusing deployment: LOCAL_PAPER_FORK requires ENABLE_MAINNET_FORK=true");
  }
  const localUrl = process.env.LOCALHOST_RPC_URL || "http://127.0.0.1:18545";
  const parsedUrl = new URL(localUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsedUrl.hostname)) {
    throw new Error("Refusing deployment: local RPC must bind to loopback");
  }

  // Use a plain JSON-RPC provider for the running Hardhat node. The
  // Hardhat-extended provider can report zero signers when localhost.accounts
  // is empty, even though the node itself exposes its unlocked accounts.
  const provider = new ethers.providers.JsonRpcProvider(localUrl);
  const chain = await provider.getNetwork();
  if (chain.chainId !== 1) throw new Error("Local fork must report Ethereum chain ID 1");

  const apiKey = process.env.API_KEY;
  if (!apiKey) throw new Error("API_KEY must already be configured in the repository .env");

  // Use canonical Ethereum mainnet addresses on the fork, not stale local .env overrides.
  for (const key of [
    "AAVE_LENDING_POOL_ADDRESS_PROVIDER", "AAVE_V2_LENDING_POOL",
    "UNISWAP_ROUTER_ADDRESS", "SUSHISWAP_ROUTER_ADDRESS",
    "UNISWAP_V3_ROUTER", "UNISWAP_V3_QUOTER",
    "PANCAKE_V3_ROUTER", "PANCAKE_V3_FACTORY", "PANCAKE_V3_QUOTER",
    "TOKENS_DAI", "TOKENS_WETH", "TOKENS_USDC", "TOKENS_USDT", "TOKENS_WBTC",
  ]) delete process.env[key];
  const profile = productionProfile();
  const accounts = await provider.listAccounts();
  if (accounts.length < 4) throw new Error("Hardhat node must expose at least four unlocked local accounts");

  const deployer = provider.getSigner(accounts[0]);
  const operator = provider.getSigner(accounts[1]);
  const recipient = provider.getSigner(accounts[2]);
  const governance = provider.getSigner(accounts[3]);
  const [deployerAddress, operatorAddress, recipientAddress, governanceAddress] =
    await Promise.all([deployer.getAddress(), operator.getAddress(), recipient.getAddress(), governance.getAddress()]);

  const externalAddresses = [
    profile.flashloanProvider.addressesProvider,
    profile.flashloanProvider.lendingPool,
    ...Object.values(profile.routers).map((item) => item.router),
  ];
  for (const address of [...new Set(externalAddresses)]) {
    if ((await provider.getCode(address)) === "0x") {
      throw new Error("Fork is missing required mainnet contract bytecode: " + address);
    }
  }

  console.log("[LOCAL PAPER] Deploying governance timelock locally...");
  const Timelock = await ethers.getContractFactory("ArbitrageTimelock", deployer);
  const timelock = await Timelock.deploy(
    0,
    [governanceAddress],
    [governanceAddress],
    ethers.constants.AddressZero
  );
  await timelock.deployed();

  const routers = [...new Set(
    Object.values(profile.routers)
      .map((item) => item.router)
      .filter(Boolean)
      .map((address) => ethers.utils.getAddress(address))
  )];

  console.log("[LOCAL PAPER] Deploying v4 flashloan executor locally...");
  const Executor = await ethers.getContractFactory("ArbitrageFlashloan", deployer);
  const executor = await Executor.deploy(
    profile.flashloanProvider.addressesProvider,
    recipientAddress,
    timelock.address,
    operatorAddress,
    routers
  );
  await executor.deployed();

  const [version, role, admin, profitRecipient, providerAddress, lendingPool] =
    await Promise.all([
      executor.executorVersion(),
      executor.executors(operatorAddress),
      executor.admin(),
      executor.profitRecipient(),
      executor.provider(),
      executor.lendingPool(),
    ]);
  if (version.toNumber() !== 4) throw new Error("Deployed executor is not version 4");
  if (!role) throw new Error("Local operator was not granted the executor role");
  if (ethers.utils.getAddress(admin) !== ethers.utils.getAddress(timelock.address)) {
    throw new Error("Local timelock is not the executor admin");
  }
  if (ethers.utils.getAddress(profitRecipient) !== ethers.utils.getAddress(recipientAddress)) {
    throw new Error("Local profit recipient verification failed");
  }
  if (ethers.utils.getAddress(providerAddress) !== ethers.utils.getAddress(profile.flashloanProvider.addressesProvider) ||
      ethers.utils.getAddress(lendingPool) !== ethers.utils.getAddress(profile.flashloanProvider.lendingPool)) {
    throw new Error("Local executor Aave V2 wiring verification failed");
  }
  for (const router of routers) {
    if (!(await executor.approvedRouters(router))) {
      throw new Error("Router was not allowlisted: " + router);
    }
  }

  const runtimeCode = await provider.getCode(executor.address);
  const runtimeCodeHash = ethers.utils.keccak256(runtimeCode);
  const localEnv = {
    LOCAL_PAPER_MODE: "true",
    NODE_ENV: "development",
    PAPER_ONLY: "true",
    PRIVATE_KEY: "",
    MAINNET_RPC_URL: localUrl,
    RPC_BACKUP_URLS: "",
    MAINNET_WEBSOCKET: "",
    LOCALHOST_RPC_URL: localUrl,
    API_KEY: apiKey,
    PORT: "3001",
    API_BIND_HOST: "127.0.0.1",
    CORS_ORIGIN: "",
    CONTRACT_ADDRESS: executor.address,
    OPERATOR_ADDRESS: operatorAddress,
    EXPECTED_ADMIN: timelock.address,
    EXPECTED_PROFIT_RECIPIENT: recipientAddress,
    EXPECTED_CONTRACT_CODE_HASH: runtimeCodeHash,
    AAVE_LENDING_POOL_ADDRESS_PROVIDER: profile.flashloanProvider.addressesProvider,
    AAVE_V2_LENDING_POOL: profile.flashloanProvider.lendingPool,
    UNISWAP_ROUTER_ADDRESS: profile.routers.uniswap_v2.router,
    SUSHISWAP_ROUTER_ADDRESS: profile.routers.sushiswap_v2.router,
    UNISWAP_V3_ROUTER: profile.routers.uniswap_v3.router,
    UNISWAP_V3_QUOTER: profile.routers.uniswap_v3.quoter,
    PANCAKE_V3_ROUTER: profile.routers.pancake_v3.router,
    PANCAKE_V3_FACTORY: profile.routers.pancake_v3.factory,
    PANCAKE_V3_QUOTER: profile.routers.pancake_v3.quoter,
    TOKENS_DAI: profile.tokens.DAI,
    TOKENS_WETH: profile.tokens.WETH,
    TOKENS_USDC: profile.tokens.USDC,
    TOKENS_USDT: profile.tokens.USDT,
    TOKENS_WBTC: profile.tokens.WBTC,
    SCAN_TOKENS: "DAI,WETH,USDC,USDT,WBTC",
    BORROW_TOKENS: "DAI,WETH",
    MIN_BORROW_AMOUNT: "1",
    MAX_BORROW_AMOUNT: "10000",
    MIN_PROFIT_TOKEN: "0.01",
    MAX_SINGLE_TRADE_GAS: "1500000",
    GAS_PRICE_CEILING_GWEI: "100",
    SCAN_BUDGET_MS: "5000",
    BLOCK_POLL_INTERVAL_MS: "1000",
    ALLOW_PUBLIC_MEMPOOL_FALLBACK: "false",
    BACKRUN_ENABLED: "false",
    BOT_AUTO_START: "false",
    TIMELOCK_ADDRESS: "",
    CONNEXT_ADAPTER_ADDRESS: "",
    RELAY_AUTH_PRIVATE_KEY: "",
    FLASHBOTS_AUTH_KEY: "",
    PG_USER: "",
    PG_HOST: "",
    PG_DB: "",
    PG_PASSWORD: "",
    PG_PORT: "",
    DATABASE_URL: "",
    EXECUTION_LEDGER_PATH: "runtime/local-paper-executions.jsonl",
    SETTINGS_FILE: "runtime/local-paper-settings.json",
    PAPER_ENV_FILE: "runtime/local-paper.env",
  };

  const envText = Object.entries(localEnv)
    .map(([key, value]) => key + "=" + JSON.stringify(String(value)))
    .join("\n") + "\n";
  fs.mkdirSync("runtime", { recursive: true, mode: 0o700 });
  fs.writeFileSync("runtime/local-paper.env", envText, { mode: 0o600 });
  fs.writeFileSync(
    "runtime/local-paper-deployment.json",
    JSON.stringify({
      chainId: 1,
      localRpc: localUrl,
      forkBlock: await provider.getBlockNumber(),
      deployer: deployerAddress,
      operator: operatorAddress,
      profitRecipient: recipientAddress,
      governanceTimelock: timelock.address,
      executor: executor.address,
      executorVersion: version.toString(),
      runtimeCodeHash,
      routers,
    }, null, 2) + "\n",
    { mode: 0o600 }
  );

  // Produce fresh local blocks so the existing block-driven scanner continues
  // to run while the UI is in PAPER mode.
  try {
    await provider.send("evm_setIntervalMining", [1000]);
  } catch (_) {
    console.warn("[LOCAL PAPER] Interval mining unavailable; scanner will use provider polling.");
  }

  console.log("");
  console.log("[LOCAL PAPER] Deployment verified.");
  console.log("Executor:", executor.address);
  console.log("Operator:", operatorAddress);
  console.log("Timelock:", timelock.address);
  console.log("Profit recipient:", recipientAddress);
  console.log("Runtime hash:", runtimeCodeHash);
  console.log("Local API environment written to runtime/local-paper.env");
  console.log("No private key was written. PAPER_ONLY is enabled.");
}

main().catch((error) => {
  console.error("[LOCAL PAPER] Deployment failed:", error.message);
  process.exitCode = 1;
});
