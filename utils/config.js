const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
  override: true,
});
const { validateEnv } = require("./validateEnv");

function getEnv(key, defaultValue = undefined) {
  const val = process.env[key];
  return val === undefined || val === "" ? defaultValue : val;
}

function loadRequired(keys) {
  validateEnv(keys);
  const out = {};
  for (const k of keys) out[k] = process.env[k];
  return out;
}

module.exports = { getEnv, loadRequired };
