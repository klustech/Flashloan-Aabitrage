const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { ethers } = require("ethers");

const envPath = path.resolve(__dirname, "../.env");
if (!process.env.RUNTIME_CONFIG_LOADED) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }
  process.env.RUNTIME_CONFIG_LOADED = "true";
}

const featureWarnings = new Set();
const invalidWarnings = new Set();

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off", ""].includes(normalized)) return false;
  }
  throw new Error(`Unable to interpret "${value}" as a boolean`);
}

function parseInteger(value) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Unable to interpret "${value}" as an integer`);
  }
  return parsed;
}

function parseFloatStrict(value) {
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Unable to interpret "${value}" as a number`);
  }
  return parsed;
}

function parseAddress(value) {
  return ethers.utils.getAddress(value);
}

function warnFeature({ feature, description }) {
  if (!feature) return;
  const msg = description
    ? `[runtime-config] ${feature} disabled: ${description}`
    : `[runtime-config] ${feature} disabled – set the required variables to enable it.`;
  if (featureWarnings.has(msg)) return;
  featureWarnings.add(msg);
  console.warn(msg);
}

function warnInvalid(key, typeName, err) {
  const msg = `[runtime-config] Invalid ${typeName} for ${key}: ${err.message || err}`;
  if (invalidWarnings.has(msg)) return;
  invalidWarnings.add(msg);
  console.warn(msg);
}

function createAccessor(key, raw, { isOptional = false, feature, description, enabled = true } = {}) {
  const warnMissing = () => {
    if (!isOptional) {
      throw new Error(`Missing required environment variable ${key}`);
    }
    if (enabled) {
      warnFeature({ feature, description });
    }
  };

  const wrap = (parser, typeName, defaultValue) => {
    if (raw === undefined || raw === "") {
      if (!isOptional) {
        throw new Error(`Missing required environment variable ${key}`);
      }
      if (enabled && feature) {
        warnFeature({ feature, description });
      }
      return defaultValue;
    }
    try {
      return parser(raw);
    } catch (err) {
      if (!isOptional) {
        throw new Error(`Invalid ${typeName} for ${key}: ${err.message || err}`);
      }
      warnInvalid(key, typeName, err);
      if (enabled && feature) {
        warnFeature({ feature, description });
      }
      return defaultValue;
    }
  };

  return {
    string(defaultValue) {
      if (raw === undefined || raw === "") {
        if (!isOptional) warnMissing();
        if (enabled && feature) {
          warnFeature({ feature, description });
        }
        return defaultValue;
      }
      return raw;
    },
    integer(defaultValue) {
      return wrap(parseInteger, "integer", defaultValue);
    },
    float(defaultValue) {
      return wrap(parseFloatStrict, "number", defaultValue);
    },
    boolean(defaultValue = false) {
      return wrap(parseBoolean, "boolean", defaultValue ?? false);
    },
    address(defaultValue) {
      return wrap(parseAddress, "address", defaultValue);
    },
  };
}

function optional(key, options = {}) {
  return createAccessor(key, process.env[key], { ...options, isOptional: true });
}

function required(key, options = {}) {
  return createAccessor(key, process.env[key], options);
}

const env = {
  PRIVATE_KEY: required("PRIVATE_KEY").string(),
  MAINNET_RPC_URL: required("MAINNET_RPC_URL").string(),
  CONTRACT_ADDRESS: required("CONTRACT_ADDRESS").address(),
  AAVE_LENDING_POOL_ADDRESS_PROVIDER: required(
    "AAVE_LENDING_POOL_ADDRESS_PROVIDER"
  ).string(),
  TOKENS_DAI: required("TOKENS_DAI").string(),
  TOKENS_WETH: required("TOKENS_WETH").string(),
  UNISWAP_ROUTER_ADDRESS: required("UNISWAP_ROUTER_ADDRESS").string(),
  SUSHISWAP_ROUTER_ADDRESS: required("SUSHISWAP_ROUTER_ADDRESS").string(),
};

const includeBalancer = optional("INCLUDE_BALANCER").boolean(false);
const includeCurve = optional("INCLUDE_CURVE").boolean(false);
const includeReinforcementLearning = optional("ENABLE_RL").boolean(false);

const balancerRpcUrl = includeBalancer
  ? optional("ETH_RPC_URL", {
      feature: "Balancer routing",
      enabled: includeBalancer,
      description: "Set ETH_RPC_URL or reuse MAINNET_RPC_URL when INCLUDE_BALANCER=true.",
    }).string(env.MAINNET_RPC_URL)
  : undefined;

if (balancerRpcUrl && !process.env.ETH_RPC_URL) {
  process.env.ETH_RPC_URL = balancerRpcUrl;
}

const features = {
  balancer: includeBalancer && Boolean(balancerRpcUrl),
  curve: includeCurve,
  reinforcementLearning: includeReinforcementLearning,
};

module.exports = {
  env,
  optional,
  required,
  features,
};
