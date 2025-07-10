const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
  override: true,
});

// Early sanity check so missing vars are obvious during startup
console.log("ENV \u2713", {
  MAINNET_RPC_URL: process.env.MAINNET_RPC_URL,
  CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS,
});

function getEnv(key, defaultValue = undefined) {
  const val = process.env[key];
  return val === undefined || val === "" ? defaultValue : val;
}

function loadRequired(keys) {
  const missing = keys.filter((k) => typeof process.env[k] === "undefined");
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  const out = {};
  for (const k of keys) out[k] = process.env[k];
  return out;
}

module.exports = { getEnv, loadRequired };
