/**
 * server/scripts/tipCalculator.js
 *
 * Dynamic tip calculation for competitive MEV bundle submission.
 * Calculates optimal tips based on expected profit, gas conditions,
 * competition level, and historical inclusion rates.
 */

const { ethers, BigNumber } = require("ethers");
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
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const TIP_CONFIG = {
  // Minimum tip percentage of profit (basis points)
  MIN_TIP_BPS: parseInt(process.env.MIN_TIP_BPS || "500", 10), // 5%

  // Maximum tip percentage of profit (basis points)
  MAX_TIP_BPS: parseInt(process.env.MAX_TIP_BPS || "9000", 10), // 90%

  // Default tip percentage when no competition data (basis points)
  DEFAULT_TIP_BPS: parseInt(process.env.DEFAULT_TIP_BPS || "2500", 10), // 25%

  // Minimum absolute tip in wei
  MIN_TIP_WEI: ethers.utils.parseUnits(process.env.MIN_TIP_GWEI || "0.1", "gwei"),

  // Maximum absolute tip in ETH
  MAX_TIP_ETH: ethers.utils.parseEther(process.env.MAX_TIP_ETH || "0.5"),

  // Tip variants for multi-bundle submission (multipliers)
  TIP_VARIANTS: [0.8, 1.0, 1.2, 1.5],

  // Competition level adjustments
  COMPETITION_MULTIPLIERS: {
    low: 0.7,      // Few competitors, can bid lower
    medium: 1.0,   // Normal competition
    high: 1.3,     // High competition, bid higher
    extreme: 1.8,  // Very competitive, aggressive bidding
  },

  // Time pressure adjustments (blocks until target)
  TIME_PRESSURE_MULTIPLIERS: {
    1: 1.5,   // Next block - urgent
    2: 1.2,   // 2 blocks away
    3: 1.0,   // 3+ blocks - normal
  },
};

// Historical data for learning
const inclusionHistory = {
  tips: [],          // Array of { tip, profit, included, timestamp }
  maxSize: 1000,     // Keep last 1000 records
  windowMs: 3600000, // 1 hour window for analysis
};

// ─────────────────────────────────────────────────────────────────────────────
// Core Tip Calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the optimal tip for a bundle
 * @param {Object} params - Calculation parameters
 * @returns {Object} Tip calculation result
 */
function calculateOptimalTip(params) {
  const {
    expectedProfitWei,
    gasUsed,
    baseFeePerGas,
    competitionLevel = "medium",
    blocksUntilTarget = 2,
    urgency = "normal",
  } = params;

  const expectedProfit = BigNumber.from(expectedProfitWei);

  // Start with base tip as percentage of profit
  let tipBps = TIP_CONFIG.DEFAULT_TIP_BPS;

  // Adjust for competition level
  const competitionMultiplier = TIP_CONFIG.COMPETITION_MULTIPLIERS[competitionLevel] || 1.0;
  tipBps = Math.floor(tipBps * competitionMultiplier);

  // Adjust for time pressure
  const timePressure = TIP_CONFIG.TIME_PRESSURE_MULTIPLIERS[blocksUntilTarget] || 1.0;
  tipBps = Math.floor(tipBps * timePressure);

  // Adjust for urgency
  if (urgency === "high") {
    tipBps = Math.floor(tipBps * 1.3);
  } else if (urgency === "critical") {
    tipBps = Math.floor(tipBps * 1.6);
  }

  // Apply historical learning adjustment
  const historicalAdjustment = calculateHistoricalAdjustment();
  tipBps = Math.floor(tipBps * historicalAdjustment);

  // Clamp to min/max
  tipBps = Math.max(TIP_CONFIG.MIN_TIP_BPS, Math.min(TIP_CONFIG.MAX_TIP_BPS, tipBps));

  // Calculate tip amount
  let tipWei = expectedProfit.mul(tipBps).div(10000);

  // Apply absolute min/max
  if (tipWei.lt(TIP_CONFIG.MIN_TIP_WEI)) {
    tipWei = TIP_CONFIG.MIN_TIP_WEI;
  }
  if (tipWei.gt(TIP_CONFIG.MAX_TIP_ETH)) {
    tipWei = TIP_CONFIG.MAX_TIP_ETH;
  }

  // Calculate priority fee per gas
  const priorityFeePerGas = gasUsed.gt(0) ? tipWei.div(gasUsed) : BigNumber.from(0);

  // Ensure priority fee is reasonable (at least 1 gwei, at most 500 gwei)
  const minPriorityFee = ethers.utils.parseUnits("1", "gwei");
  const maxPriorityFee = ethers.utils.parseUnits("500", "gwei");

  let finalPriorityFee = priorityFeePerGas;
  if (finalPriorityFee.lt(minPriorityFee)) {
    finalPriorityFee = minPriorityFee;
    tipWei = finalPriorityFee.mul(gasUsed);
  }
  if (finalPriorityFee.gt(maxPriorityFee)) {
    finalPriorityFee = maxPriorityFee;
    tipWei = finalPriorityFee.mul(gasUsed);
  }

  // Calculate net profit after tip
  const netProfitWei = expectedProfit.sub(tipWei);

  // Log the calculation
  logger.info(
    `Tip calculation: profit=${ethers.utils.formatEther(expectedProfit)} ETH, ` +
    `tip=${ethers.utils.formatEther(tipWei)} ETH (${tipBps / 100}%), ` +
    `priorityFee=${ethers.utils.formatUnits(finalPriorityFee, "gwei")} gwei, ` +
    `net=${ethers.utils.formatEther(netProfitWei)} ETH`
  );

  return {
    tipWei,
    tipBps,
    priorityFeePerGas: finalPriorityFee,
    maxFeePerGas: baseFeePerGas.add(finalPriorityFee),
    netProfitWei,
    profitAfterTipBps: netProfitWei.mul(10000).div(expectedProfit).toNumber(),
    factors: {
      competitionLevel,
      competitionMultiplier,
      timePressure,
      urgency,
      historicalAdjustment,
    },
  };
}

/**
 * Generate multiple tip variants for parallel submission
 */
function generateTipVariants(baseTip, expectedProfitWei, gasUsed) {
  const expectedProfit = BigNumber.from(expectedProfitWei);
  const variants = [];

  for (const multiplier of TIP_CONFIG.TIP_VARIANTS) {
    let variantTip = baseTip.tipWei.mul(Math.floor(multiplier * 100)).div(100);

    // Ensure we don't exceed max tip
    const maxTip = expectedProfit.mul(TIP_CONFIG.MAX_TIP_BPS).div(10000);
    if (variantTip.gt(maxTip)) {
      variantTip = maxTip;
    }

    // Calculate priority fee for this variant
    const priorityFee = gasUsed.gt(0) ? variantTip.div(gasUsed) : BigNumber.from(0);

    variants.push({
      multiplier,
      tipWei: variantTip,
      priorityFeePerGas: priorityFee,
      netProfitWei: expectedProfit.sub(variantTip),
    });
  }

  return variants;
}

// ─────────────────────────────────────────────────────────────────────────────
// Competition Analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimate competition level based on opportunity characteristics
 */
function estimateCompetitionLevel(params) {
  const {
    tokenPair,
    profitUsd,
    isPopularPair = false,
    recentBlockActivity = 0,
  } = params;

  // Popular pairs (ETH/USDC, ETH/DAI, etc.) have high competition
  const popularPairs = [
    "WETH-USDC", "WETH-DAI", "WETH-USDT",
    "USDC-DAI", "USDC-USDT", "DAI-USDT",
  ];

  let score = 0;

  // Check if popular pair
  if (isPopularPair || popularPairs.includes(tokenPair)) {
    score += 3;
  }

  // High profit opportunities attract more competition
  if (profitUsd > 1000) score += 3;
  else if (profitUsd > 100) score += 2;
  else if (profitUsd > 10) score += 1;

  // Recent block activity indicates competition
  if (recentBlockActivity > 10) score += 2;
  else if (recentBlockActivity > 5) score += 1;

  // Map score to level
  if (score >= 7) return "extreme";
  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

/**
 * Analyze recent gas prices to gauge network competition
 */
async function analyzeGasCompetition(provider) {
  try {
    const feeHistory = await provider.send("eth_feeHistory", [10, "latest", [25, 50, 75]]);

    const recentBaseFees = feeHistory.baseFeePerGas.map((f) => BigNumber.from(f));
    const avgBaseFee = recentBaseFees.reduce((a, b) => a.add(b)).div(recentBaseFees.length);

    // Calculate priority fee percentiles
    const priorityFees = feeHistory.reward.flat().map((f) => BigNumber.from(f));
    priorityFees.sort((a, b) => (a.lt(b) ? -1 : 1));

    const p25 = priorityFees[Math.floor(priorityFees.length * 0.25)];
    const p50 = priorityFees[Math.floor(priorityFees.length * 0.5)];
    const p75 = priorityFees[Math.floor(priorityFees.length * 0.75)];

    // High p75 indicates competitive environment
    const competitionScore = p75.div(ethers.utils.parseUnits("1", "gwei")).toNumber();

    let level = "low";
    if (competitionScore > 50) level = "extreme";
    else if (competitionScore > 20) level = "high";
    else if (competitionScore > 5) level = "medium";

    return {
      level,
      avgBaseFee,
      priorityFees: {
        p25,
        p50,
        p75,
      },
      recommendedPriorityFee: p75,
    };
  } catch (error) {
    logger.warn(`Gas competition analysis failed: ${error.message}`);
    return {
      level: "medium",
      avgBaseFee: ethers.utils.parseUnits("30", "gwei"),
      priorityFees: {
        p25: ethers.utils.parseUnits("1", "gwei"),
        p50: ethers.utils.parseUnits("2", "gwei"),
        p75: ethers.utils.parseUnits("5", "gwei"),
      },
      recommendedPriorityFee: ethers.utils.parseUnits("5", "gwei"),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Historical Learning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a tip outcome for learning
 */
function recordTipOutcome(tip, profit, included, metadata = {}) {
  inclusionHistory.tips.push({
    tip: tip.toString(),
    profit: profit.toString(),
    included,
    timestamp: Date.now(),
    ...metadata,
  });

  // Trim to max size
  if (inclusionHistory.tips.length > inclusionHistory.maxSize) {
    inclusionHistory.tips = inclusionHistory.tips.slice(-inclusionHistory.maxSize);
  }
}

/**
 * Calculate adjustment factor based on historical outcomes
 */
function calculateHistoricalAdjustment() {
  const now = Date.now();
  const recentTips = inclusionHistory.tips.filter(
    (t) => now - t.timestamp < inclusionHistory.windowMs
  );

  if (recentTips.length < 10) {
    return 1.0; // Not enough data
  }

  // Calculate inclusion rate
  const included = recentTips.filter((t) => t.included).length;
  const inclusionRate = included / recentTips.length;

  // Adjust based on inclusion rate target (aim for 30-50% inclusion)
  if (inclusionRate < 0.1) {
    return 1.5; // Very low inclusion, increase tips significantly
  } else if (inclusionRate < 0.3) {
    return 1.2; // Low inclusion, increase tips
  } else if (inclusionRate > 0.7) {
    return 0.8; // High inclusion, we're overpaying
  } else if (inclusionRate > 0.5) {
    return 0.9; // Slightly high, reduce a bit
  }

  return 1.0; // Optimal range
}

/**
 * Get historical statistics
 */
function getHistoricalStats() {
  const now = Date.now();
  const recentTips = inclusionHistory.tips.filter(
    (t) => now - t.timestamp < inclusionHistory.windowMs
  );

  if (recentTips.length === 0) {
    return {
      totalRecords: 0,
      recentRecords: 0,
      inclusionRate: 0,
      avgTipBps: 0,
    };
  }

  const included = recentTips.filter((t) => t.included).length;
  const inclusionRate = included / recentTips.length;

  // Calculate average tip percentage
  const tipBpsValues = recentTips.map((t) => {
    const tip = BigNumber.from(t.tip);
    const profit = BigNumber.from(t.profit);
    return profit.gt(0) ? tip.mul(10000).div(profit).toNumber() : 0;
  });
  const avgTipBps = tipBpsValues.reduce((a, b) => a + b, 0) / tipBpsValues.length;

  return {
    totalRecords: inclusionHistory.tips.length,
    recentRecords: recentTips.length,
    inclusionRate: (inclusionRate * 100).toFixed(2) + "%",
    avgTipBps: avgTipBps.toFixed(0),
    adjustment: calculateHistoricalAdjustment(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Coinbase Transfer Tip (Direct to Block Builder)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a coinbase transfer transaction for direct builder tip
 * This sends ETH directly to the block builder as an additional incentive
 */
function createCoinbaseTransfer(wallet, tipWei, nonce, chainId = 1) {
  // Builder address will be filled by the builder
  // Use a placeholder that gets replaced
  const COINBASE_PLACEHOLDER = "0x0000000000000000000000000000000000000000";

  return {
    to: COINBASE_PLACEHOLDER, // Will be replaced with actual coinbase
    value: tipWei,
    data: "0x", // Empty data
    nonce,
    chainId,
    type: 2, // EIP-1559
    maxFeePerGas: ethers.utils.parseUnits("0", "gwei"), // No gas fee for coinbase transfer
    maxPriorityFeePerGas: ethers.utils.parseUnits("0", "gwei"),
    gasLimit: 21000, // Simple transfer
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Core calculation
  calculateOptimalTip,
  generateTipVariants,

  // Competition analysis
  estimateCompetitionLevel,
  analyzeGasCompetition,

  // Historical learning
  recordTipOutcome,
  getHistoricalStats,

  // Coinbase transfer
  createCoinbaseTransfer,

  // Config access
  TIP_CONFIG,
};
