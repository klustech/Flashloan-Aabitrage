const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
  override: false,
});

function getEnv(key, defaultValue = undefined) {
  const val = process.env[key];
  return val === undefined || val === "" ? defaultValue : val;
}

function loadRequired(keys) {
  const missing = keys.filter((k) => typeof process.env[k] === "undefined");
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  const out = {};
  for (const k of keys) out[k] = process.env[k];
  return out;
}

module.exports = { getEnv, loadRequired };

