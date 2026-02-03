/**
 * server/scripts/flashbotsUtils.js
 *
 * Flashbots Bundle Submission Utilities
 * - Redundant relay support with fallback
 * - Gas price safety mechanisms
 * - Bundle simulation and validation
 * - Retry logic with exponential backoff
 */

const { ethers, BigNumber } = require("ethers");
const { FlashbotsBundleProvider } = require("@flashbots/ethers-provider-bundle");

// Flashbots relay endpoints
const FLASHBOTS_RELAYS = {
  mainnet: {
    primary: "https://relay.flashbots.net",
    backup: [
      "https://rpc.flashbots.net",
      "https://relay-goerli.flashbots.net", // For testing
    ],
  },
  goerli: {
    primary: "https://relay-goerli.flashbots.net",
    backup: [],
  },
  sepolia: {
    primary: "https://relay-sepolia.flashbots.net",
    backup: [],
  },
};

// Additional MEV relays (optional, can be enabled via env)
const MEV_RELAYS = {
  bloxroute: process.env.BLOXROUTE_RELAY_URL,
  eden: process.env.EDEN_RELAY_URL,
  manifold: process.env.MANIFOLD_RELAY_URL,
};

// Gas safety configuration
const GAS_SAFETY_CONFIG = {
  maxBaseFeeMultiplier: 2.5,      // Max base fee multiplier
  maxPriorityFee: ethers.utils.parseUnits("50", "gwei"),
  minProfitAfterGas: ethers.utils.parseUnits("0.5", 18), // 0.5 DAI minimum
  maxGasPrice: ethers.utils.parseUnits("500", "gwei"),
  baseFeeBuffer: 1.25,           // 25% buffer on base fee
};

// Bundle submission state
let flashbotsProviders = new Map();
let bundleStats = {
  submitted: 0,
  included: 0,
  failed: 0,
  simulated: 0,
  lastInclusionBlock: 0,
};

/**
 * Initialize Flashbots provider for a network
 * @param {Object} provider - Ethers provider
 * @param {Object} signer - Signing wallet
 * @param {string} network - Network name (mainnet, goerli, sepolia)
 * @returns {Object} - Flashbots provider
 */
async function initFlashbotsProvider(provider, signer, network = "mainnet") {
  const cacheKey = `${network}-${signer.address}`;

  if (flashbotsProviders.has(cacheKey)) {
    return flashbotsProviders.get(cacheKey);
  }

  const relayConfig = FLASHBOTS_RELAYS[network] || FLASHBOTS_RELAYS.mainnet;

  try {
    const fbProvider = await FlashbotsBundleProvider.create(
      provider,
      signer,
      relayConfig.primary
    );
    flashbotsProviders.set(cacheKey, fbProvider);
    return fbProvider;
  } catch (err) {
    console.warn(`[flashbotsUtils] Primary relay failed: ${err.message}`);

    // Try backup relays
    for (const backupUrl of relayConfig.backup) {
      try {
        const fbProvider = await FlashbotsBundleProvider.create(
          provider,
          signer,
          backupUrl
        );
        flashbotsProviders.set(cacheKey, fbProvider);
        return fbProvider;
      } catch (backupErr) {
        console.warn(`[flashbotsUtils] Backup relay ${backupUrl} failed: ${backupErr.message}`);
      }
    }

    throw new Error("All Flashbots relays failed to connect");
  }
}

/**
 * Calculate safe gas parameters for bundle submission
 * @param {Object} provider - Ethers provider
 * @param {BigNumber} estimatedGas - Estimated gas for transaction
 * @param {BigNumber} expectedProfit - Expected profit in wei
 * @returns {Object} - { maxFeePerGas, maxPriorityFeePerGas, isViable }
 */
async function calculateSafeGasParams(provider, estimatedGas, expectedProfit) {
  // Get current fee data
  const feeData = await provider.getFeeData();
  const block = await provider.getBlock("latest");
  const baseFee = block.baseFeePerGas || feeData.gasPrice;

  // Get fee history for better estimation
  let feeHistory;
  try {
    feeHistory = await provider.send("eth_feeHistory", [5, "latest", [25, 50, 75]]);
  } catch {
    feeHistory = null;
  }

  // Calculate next block base fee (increases by up to 12.5% per block)
  const nextBaseFee = baseFee.mul(1125).div(1000);

  // Apply safety buffer
  const bufferedBaseFee = nextBaseFee.mul(Math.floor(GAS_SAFETY_CONFIG.baseFeeBuffer * 100)).div(100);

  // Calculate priority fee based on expected profit
  // Use a portion of profit as miner tip (5-15% depending on competition)
  let priorityFee = expectedProfit.mul(10).div(100).div(estimatedGas);

  // Cap priority fee
  if (priorityFee.gt(GAS_SAFETY_CONFIG.maxPriorityFee)) {
    priorityFee = GAS_SAFETY_CONFIG.maxPriorityFee;
  }

  // Ensure minimum priority fee
  const minPriority = ethers.utils.parseUnits("1", "gwei");
  if (priorityFee.lt(minPriority)) {
    priorityFee = minPriority;
  }

  const maxFeePerGas = bufferedBaseFee.add(priorityFee);

  // Safety check: ensure total gas cost doesn't exceed profit
  const totalGasCost = maxFeePerGas.mul(estimatedGas);
  const profitAfterGas = expectedProfit.sub(totalGasCost);

  // Viability check
  const isViable = profitAfterGas.gt(GAS_SAFETY_CONFIG.minProfitAfterGas) &&
                   maxFeePerGas.lt(GAS_SAFETY_CONFIG.maxGasPrice);

  return {
    maxFeePerGas,
    maxPriorityFeePerGas: priorityFee,
    baseFee: bufferedBaseFee,
    totalGasCost,
    profitAfterGas,
    isViable,
    gasEstimate: estimatedGas,
  };
}

/**
 * Simulate bundle before submission
 * @param {Object} fbProvider - Flashbots provider
 * @param {Array} signedBundle - Signed bundle transactions
 * @param {number} blockNumber - Target block number
 * @returns {Object} - Simulation result
 */
async function simulateBundle(fbProvider, signedBundle, blockNumber) {
  try {
    const simulation = await fbProvider.simulate(signedBundle, blockNumber);
    bundleStats.simulated++;

    if (simulation.firstRevert) {
      return {
        success: false,
        error: `Revert at tx ${simulation.firstRevert}: ${simulation.results?.[simulation.firstRevert]?.error}`,
        gasUsed: simulation.totalGasUsed,
        results: simulation.results,
      };
    }

    return {
      success: true,
      gasUsed: simulation.totalGasUsed,
      results: simulation.results,
      coinbaseDiff: simulation.coinbaseDiff,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * Submit bundle with retry logic
 * @param {Object} params - Bundle parameters
 * @returns {Object} - Submission result
 */
async function submitBundleWithRetry(params) {
  const {
    provider,
    signer,
    transactions,
    targetBlock,
    maxRetries = 3,
    tipMultiplier = 1.2,
    network = "mainnet",
  } = params;

  const fbProvider = await initFlashbotsProvider(provider, signer, network);

  let currentTip = null;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Adjust transactions with current tip
      const bundleTxs = await Promise.all(
        transactions.map(async (tx) => {
          const adjustedTx = { ...tx };

          if (currentTip && attempt > 0) {
            // Increase tip for retry attempts
            adjustedTx.maxPriorityFeePerGas = currentTip;
            adjustedTx.maxFeePerGas = adjustedTx.maxFeePerGas.add(
              currentTip.sub(tx.maxPriorityFeePerGas || 0)
            );
          }

          return {
            signer,
            transaction: adjustedTx,
          };
        })
      );

      // Sign the bundle
      const signedBundle = await fbProvider.signBundle(bundleTxs);

      // Simulate first
      const simulation = await simulateBundle(fbProvider, signedBundle, targetBlock);
      if (!simulation.success) {
        throw new Error(`Simulation failed: ${simulation.error}`);
      }

      // Submit to target block and next few blocks
      const targetBlocks = [targetBlock, targetBlock + 1, targetBlock + 2];
      const submissions = await Promise.all(
        targetBlocks.map(block => fbProvider.sendRawBundle(signedBundle, block))
      );

      bundleStats.submitted++;

      // Wait for inclusion
      const result = await Promise.race(
        submissions.map(async (submission, idx) => {
          const waitResult = await submission.wait();
          return { waitResult, block: targetBlocks[idx], submission };
        })
      );

      if (result.waitResult === 0) {
        bundleStats.included++;
        bundleStats.lastInclusionBlock = result.block;

        return {
          success: true,
          includedBlock: result.block,
          bundleHash: result.submission.bundleHash,
          simulation,
        };
      } else {
        // Not included, prepare for retry
        currentTip = transactions[0].maxPriorityFeePerGas
          .mul(Math.floor(tipMultiplier * 100))
          .div(100);
        lastError = `Bundle not included after block ${result.block}`;
      }
    } catch (err) {
      lastError = err.message;

      if (attempt < maxRetries) {
        // Exponential backoff
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 100));

        // Increase tip for next attempt
        if (currentTip) {
          currentTip = currentTip.mul(Math.floor(tipMultiplier * 100)).div(100);
        }
      }
    }
  }

  bundleStats.failed++;

  return {
    success: false,
    error: lastError,
    attempts: maxRetries + 1,
  };
}

/**
 * Submit to multiple relays in parallel
 * @param {Object} params - Bundle parameters
 * @returns {Object} - Best result from all relays
 */
async function submitToMultipleRelays(params) {
  const {
    provider,
    signer,
    transactions,
    targetBlock,
    network = "mainnet",
  } = params;

  const relayConfig = FLASHBOTS_RELAYS[network] || FLASHBOTS_RELAYS.mainnet;
  const allRelays = [relayConfig.primary, ...relayConfig.backup];

  // Add MEV relays if configured
  Object.values(MEV_RELAYS).forEach(url => {
    if (url) allRelays.push(url);
  });

  const submissions = await Promise.allSettled(
    allRelays.map(async (relayUrl) => {
      try {
        const fbProvider = await FlashbotsBundleProvider.create(
          provider,
          signer,
          relayUrl
        );

        const bundleTxs = transactions.map(tx => ({
          signer,
          transaction: tx,
        }));

        const signedBundle = await fbProvider.signBundle(bundleTxs);
        const simulation = await fbProvider.simulate(signedBundle, targetBlock);

        if (simulation.firstRevert) {
          throw new Error(`Simulation reverted: ${simulation.firstRevert}`);
        }

        const submission = await fbProvider.sendRawBundle(signedBundle, targetBlock);
        const waitResult = await submission.wait();

        return {
          relay: relayUrl,
          success: waitResult === 0,
          bundleHash: submission.bundleHash,
          simulation,
        };
      } catch (err) {
        return {
          relay: relayUrl,
          success: false,
          error: err.message,
        };
      }
    })
  );

  // Find first successful inclusion
  const successful = submissions.find(
    s => s.status === "fulfilled" && s.value.success
  );

  if (successful) {
    bundleStats.included++;
    return {
      success: true,
      ...successful.value,
    };
  }

  bundleStats.failed++;
  return {
    success: false,
    relayResults: submissions.map(s =>
      s.status === "fulfilled" ? s.value : { error: s.reason?.message }
    ),
  };
}

/**
 * Build optimized transaction for bundle
 * @param {Object} params - Transaction parameters
 * @returns {Object} - Optimized transaction object
 */
function buildBundleTransaction(params) {
  const {
    to,
    data,
    value = 0,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce,
    chainId = 1,
  } = params;

  return {
    to,
    data,
    value: BigNumber.from(value),
    gasLimit: BigNumber.from(gasLimit),
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce,
    chainId,
    type: 2, // EIP-1559
  };
}

/**
 * Get bundle submission statistics
 * @returns {Object} - Statistics
 */
function getBundleStats() {
  return {
    ...bundleStats,
    successRate: bundleStats.submitted > 0
      ? (bundleStats.included / bundleStats.submitted * 100).toFixed(2) + "%"
      : "0%",
  };
}

/**
 * Reset bundle statistics
 */
function resetBundleStats() {
  bundleStats = {
    submitted: 0,
    included: 0,
    failed: 0,
    simulated: 0,
    lastInclusionBlock: 0,
  };
}

/**
 * Check if Flashbots is available for the network
 * @param {string} network - Network name
 * @returns {boolean}
 */
function isFlashbotsAvailable(network) {
  return network in FLASHBOTS_RELAYS;
}

/**
 * Clear provider cache (useful for testing)
 */
function clearProviderCache() {
  flashbotsProviders.clear();
}

module.exports = {
  initFlashbotsProvider,
  calculateSafeGasParams,
  simulateBundle,
  submitBundleWithRetry,
  submitToMultipleRelays,
  buildBundleTransaction,
  getBundleStats,
  resetBundleStats,
  isFlashbotsAvailable,
  clearProviderCache,
  FLASHBOTS_RELAYS,
  GAS_SAFETY_CONFIG,
};
