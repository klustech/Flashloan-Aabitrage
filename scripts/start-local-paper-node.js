#!/usr/bin/env node
"use strict";

// Starts an isolated Hardhat mainnet fork for unsigned PAPER simulation.
// The upstream RPC is used only by Hardhat to seed the local fork. The bot
// itself will later connect only to 127.0.0.1:18545.
const { spawn } = require("child_process");
const dotenv = require("dotenv");
const { providers } = require("ethers");

dotenv.config({ override: false });

const UPSTREAM_RPC = process.env.MAINNET_RPC_URL;
const LOCAL_RPC = "http://127.0.0.1:18545";

async function main() {
  if (!UPSTREAM_RPC) throw new Error("MAINNET_RPC_URL is required in .env");
  const upstream = new providers.JsonRpcProvider(UPSTREAM_RPC);
  const network = await upstream.getNetwork();
  if (network.chainId !== 1) throw new Error("Configured upstream RPC is not Ethereum mainnet");
  const blockNumber = await upstream.getBlockNumber();
  if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
    throw new Error("Could not determine the current Ethereum block");
  }

  const env = {
    ...process.env,
    ENABLE_MAINNET_FORK: "true",
    LOCAL_PAPER_FORK: "true",
    FORK_BLOCK_NUMBER: String(blockNumber),
    LOCALHOST_RPC_URL: LOCAL_RPC,
    PAPER_ONLY: "true",
    PRIVATE_KEY: "",
    RPC_BACKUP_URLS: "",
  };

  console.log("[LOCAL PAPER] Starting isolated Ethereum fork");
  console.log("[LOCAL PAPER] Fork source: configured Ethereum RPC");
  console.log("[LOCAL PAPER] Fork block:", blockNumber);
  console.log("[LOCAL PAPER] Local endpoint:", LOCAL_RPC);
  console.log("[LOCAL PAPER] No transactions will be sent to Ethereum mainnet.");

  const child = spawn(
    "npx",
    ["hardhat", "node", "--hostname", "127.0.0.1", "--port", "18545"],
    { env, stdio: "inherit" }
  );
  child.on("error", (error) => {
    console.error("[LOCAL PAPER] Could not start Hardhat:", error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

main().catch((error) => {
  console.error("[LOCAL PAPER]", error.message);
  process.exitCode = 1;
});
