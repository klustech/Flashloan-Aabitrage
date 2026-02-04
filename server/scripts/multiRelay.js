/**
 * server/scripts/multiRelay.js
 *
 * Multi-relay bundle submission for improved inclusion rates.
 * Supports Flashbots, bloXroute, Eden Network, and other MEV relays.
 */

const { ethers } = require("ethers");
const axios = require("axios");
const winston = require("winston");

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [new winston.transports.Console()],
});

// ─────────────────────────────────────────────────────────────────────────────
// Relay Configuration
// ─────────────────────────────────────────────────────────────────────────────

const RELAY_CONFIGS = {
  flashbots: {
    name: "Flashbots",
    url: "https://relay.flashbots.net",
    chainId: 1,
    enabled: true,
    priority: 1,
    authRequired: true,
    method: "eth_sendBundle",
  },
  bloxroute: {
    name: "bloXroute",
    url: "https://mev.api.blxrbdn.com",
    chainId: 1,
    enabled: true,
    priority: 2,
    authRequired: true,
    authHeader: "Authorization",
    method: "blxr_submit_bundle",
  },
  eden: {
    name: "Eden Network",
    url: "https://api.edennetwork.io/v1/bundle",
    chainId: 1,
    enabled: true,
    priority: 3,
    authRequired: false,
    method: "eth_sendBundle",
  },
  beaver: {
    name: "Beaver Build",
    url: "https://rpc.beaverbuild.org",
    chainId: 1,
    enabled: true,
    priority: 4,
    authRequired: false,
    method: "eth_sendBundle",
  },
  titanBuilder: {
    name: "Titan Builder",
    url: "https://rpc.titanbuilder.xyz",
    chainId: 1,
    enabled: true,
    priority: 5,
    authRequired: false,
    method: "eth_sendBundle",
  },
  rsync: {
    name: "rsync Builder",
    url: "https://rsync-builder.xyz",
    chainId: 1,
    enabled: true,
    priority: 6,
    authRequired: false,
    method: "eth_sendBundle",
  },
};

// Track relay performance
const relayStats = new Map();

// Initialize stats for each relay
Object.keys(RELAY_CONFIGS).forEach((key) => {
  relayStats.set(key, {
    submissions: 0,
    inclusions: 0,
    errors: 0,
    avgLatency: 0,
    lastSuccess: null,
    lastError: null,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bundle Signing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sign a bundle payload for Flashbots-style relays
 */
async function signBundle(wallet, payload) {
  const body = JSON.stringify(payload);
  const signature = await wallet.signMessage(ethers.utils.id(body));
  return `${wallet.address}:${signature}`;
}

/**
 * Create the bundle payload in Flashbots format
 */
function createBundlePayload(signedTxs, targetBlock, options = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendBundle",
    params: [
      {
        txs: signedTxs,
        blockNumber: ethers.utils.hexValue(targetBlock),
        minTimestamp: options.minTimestamp || 0,
        maxTimestamp: options.maxTimestamp || Math.floor(Date.now() / 1000) + 120,
        revertingTxHashes: options.revertingTxHashes || [],
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Relay Submission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Submit bundle to a single relay
 */
async function submitToRelay(relayKey, wallet, signedTxs, targetBlock, options = {}) {
  const relay = RELAY_CONFIGS[relayKey];
  if (!relay || !relay.enabled) {
    return { relay: relayKey, success: false, error: "Relay disabled or not found" };
  }

  const stats = relayStats.get(relayKey);
  const startTime = Date.now();

  try {
    let payload;
    let headers = {
      "Content-Type": "application/json",
    };

    // Handle different relay formats
    if (relay.method === "blxr_submit_bundle") {
      // bloXroute format
      payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "blxr_submit_bundle",
        params: {
          transaction: signedTxs,
          block_number: ethers.utils.hexValue(targetBlock),
          min_timestamp: options.minTimestamp || 0,
          max_timestamp: options.maxTimestamp || Math.floor(Date.now() / 1000) + 120,
          reverting_hashes: options.revertingTxHashes || [],
        },
      };
      if (process.env.BLOXROUTE_AUTH_HEADER) {
        headers["Authorization"] = process.env.BLOXROUTE_AUTH_HEADER;
      }
    } else {
      // Standard Flashbots format
      payload = createBundlePayload(signedTxs, targetBlock, options);
    }

    // Sign for Flashbots-style auth
    if (relay.authRequired && relay.method === "eth_sendBundle") {
      const signature = await signBundle(wallet, payload);
      headers["X-Flashbots-Signature"] = signature;
    }

    const response = await axios.post(relay.url, payload, {
      headers,
      timeout: options.timeout || 5000,
    });

    const latency = Date.now() - startTime;
    stats.submissions++;
    stats.avgLatency = (stats.avgLatency * (stats.submissions - 1) + latency) / stats.submissions;
    stats.lastSuccess = Date.now();

    logger.info(`[${relay.name}] Bundle submitted successfully (${latency}ms)`);

    return {
      relay: relayKey,
      success: true,
      response: response.data,
      latency,
      bundleHash: response.data?.result?.bundleHash,
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    stats.errors++;
    stats.lastError = {
      time: Date.now(),
      message: error.message,
    };

    logger.warn(`[${relay.name}] Bundle submission failed: ${error.message}`);

    return {
      relay: relayKey,
      success: false,
      error: error.message,
      latency,
    };
  }
}

/**
 * Submit bundle to all enabled relays in parallel
 */
async function submitToAllRelays(wallet, signedTxs, targetBlock, options = {}) {
  const enabledRelays = Object.keys(RELAY_CONFIGS).filter(
    (key) => RELAY_CONFIGS[key].enabled
  );

  logger.info(`Submitting bundle to ${enabledRelays.length} relays for block ${targetBlock}`);

  const results = await Promise.allSettled(
    enabledRelays.map((relayKey) =>
      submitToRelay(relayKey, wallet, signedTxs, targetBlock, options)
    )
  );

  const summary = {
    totalRelays: enabledRelays.length,
    successful: 0,
    failed: 0,
    results: [],
  };

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      summary.results.push(result.value);
      if (result.value.success) {
        summary.successful++;
      } else {
        summary.failed++;
      }
    } else {
      summary.failed++;
      summary.results.push({
        relay: enabledRelays[index],
        success: false,
        error: result.reason?.message || "Unknown error",
      });
    }
  });

  logger.info(
    `Bundle submission complete: ${summary.successful}/${summary.totalRelays} relays succeeded`
  );

  return summary;
}

/**
 * Submit bundle variants with different tips to maximize inclusion
 */
async function submitBundleVariants(wallet, baseTx, targetBlock, tipVariants, options = {}) {
  const variants = [];

  for (const tipMultiplier of tipVariants) {
    // Clone and modify the transaction with different tip
    const variantTx = {
      ...baseTx,
      maxPriorityFeePerGas: baseTx.maxPriorityFeePerGas
        ? ethers.BigNumber.from(baseTx.maxPriorityFeePerGas)
            .mul(Math.floor(tipMultiplier * 100))
            .div(100)
        : undefined,
    };

    // Sign the variant
    const signedTx = await wallet.signTransaction(variantTx);
    variants.push({
      tipMultiplier,
      signedTx,
    });
  }

  // Submit all variants to all relays
  const results = await Promise.allSettled(
    variants.map(async (variant) => {
      const relayResults = await submitToAllRelays(
        wallet,
        [variant.signedTx],
        targetBlock,
        options
      );
      return {
        tipMultiplier: variant.tipMultiplier,
        ...relayResults,
      };
    })
  );

  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { tipMultiplier: tipVariants[i], error: r.reason?.message }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundle Status Checking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a bundle was included via Flashbots
 */
async function checkBundleStatus(bundleHash, wallet, targetBlock) {
  try {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "flashbots_getBundleStats",
      params: [{ bundleHash, blockNumber: ethers.utils.hexValue(targetBlock) }],
    };

    const signature = await signBundle(wallet, payload);

    const response = await axios.post(RELAY_CONFIGS.flashbots.url, payload, {
      headers: {
        "Content-Type": "application/json",
        "X-Flashbots-Signature": signature,
      },
      timeout: 5000,
    });

    return {
      success: true,
      status: response.data?.result,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Wait for bundle inclusion with polling
 */
async function waitForInclusion(bundleHash, wallet, targetBlock, maxBlocks = 3) {
  const provider = new ethers.providers.JsonRpcProvider(process.env.MAINNET_RPC_URL);

  for (let i = 0; i < maxBlocks; i++) {
    const currentBlock = await provider.getBlockNumber();

    if (currentBlock > targetBlock + i) {
      const status = await checkBundleStatus(bundleHash, wallet, targetBlock + i);

      if (status.success && status.status?.isSimulated) {
        // Bundle was simulated, check if included
        if (status.status?.isHighPriority || status.status?.consideredByBuildersAt?.length > 0) {
          logger.info(`Bundle ${bundleHash} was considered by builders`);
        }
      }
    }

    // Wait for next block
    await new Promise((resolve) => setTimeout(resolve, 12000));
  }

  return { included: false, bundleHash };
}

// ─────────────────────────────────────────────────────────────────────────────
// Relay Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get relay statistics
 */
function getRelayStats() {
  const stats = {};
  relayStats.forEach((value, key) => {
    stats[key] = {
      ...value,
      inclusionRate: value.submissions > 0
        ? ((value.inclusions / value.submissions) * 100).toFixed(2) + "%"
        : "N/A",
      config: RELAY_CONFIGS[key],
    };
  });
  return stats;
}

/**
 * Enable/disable a relay
 */
function setRelayEnabled(relayKey, enabled) {
  if (RELAY_CONFIGS[relayKey]) {
    RELAY_CONFIGS[relayKey].enabled = enabled;
    logger.info(`Relay ${relayKey} ${enabled ? "enabled" : "disabled"}`);
    return true;
  }
  return false;
}

/**
 * Add a custom relay
 */
function addRelay(key, config) {
  RELAY_CONFIGS[key] = {
    ...config,
    enabled: config.enabled !== false,
    priority: config.priority || Object.keys(RELAY_CONFIGS).length + 1,
  };
  relayStats.set(key, {
    submissions: 0,
    inclusions: 0,
    errors: 0,
    avgLatency: 0,
    lastSuccess: null,
    lastError: null,
  });
  logger.info(`Added custom relay: ${key}`);
}

/**
 * Record an inclusion for stats tracking
 */
function recordInclusion(relayKey) {
  const stats = relayStats.get(relayKey);
  if (stats) {
    stats.inclusions++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Core submission
  submitToRelay,
  submitToAllRelays,
  submitBundleVariants,

  // Status checking
  checkBundleStatus,
  waitForInclusion,

  // Bundle creation
  createBundlePayload,
  signBundle,

  // Relay management
  getRelayStats,
  setRelayEnabled,
  addRelay,
  recordInclusion,

  // Constants
  RELAY_CONFIGS,
};
