#!/usr/bin/env node

const { loadRequired } = require("../utils/config");

const groups = [
  {
    label: "Core bot",
    keys: [
      "PRIVATE_KEY",
      "CONTRACT_ADDRESS",
      "AAVE_LENDING_POOL_ADDRESS_PROVIDER",
      "MAINNET_RPC_URL",
    ],
  },
  {
    label: "DEX routing",
    keys: [
      "UNISWAP_ROUTER_ADDRESS",
      "SUSHISWAP_ROUTER_ADDRESS",
      "TOKENS_DAI",
      "TOKENS_WETH",
    ],
  },
];

const missing = new Set();

for (const { label, keys } of groups) {
  const absent = keys.filter((key) => {
    const value = process.env[key];
    return typeof value === "undefined" || value === "";
  });
  if (absent.length) {
    absent.forEach((key) => missing.add(key));
    console.error(`✖ ${label}: ${absent.join(", ")}`);
    continue;
  }

  loadRequired(keys);
  console.log(`✔ ${label}: all ${keys.length} vars present`);
}

if (missing.size) {
  console.error(
    `Missing required environment variables: ${Array.from(missing).join(", ")}`
  );
  process.exit(1);
}

console.log("Environment variables look good ✅");

