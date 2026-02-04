/**
 * server/scripts/mlScorer.js
 *
 * ML scoring utility for route ranking with local heuristic fallback.
 * When ML_MODEL_ENDPOINT is unavailable, uses a heuristic-based scorer.
 */

const axios = require("axios");

// Heuristic scoring weights (tuned for arbitrage route ranking)
const HEURISTIC_WEIGHTS = {
  hops: -0.15,          // Fewer hops = better (less slippage)
  liquidity: 0.25,      // Higher liquidity = better
  fee: -0.10,           // Lower fees = better
  volatility: -0.15,    // Lower volatility = more predictable
  gasCost: -0.20,       // Lower gas = better profit margin
  historySuccess: 0.15, // More successful history = better
};

// Normalization bounds (for feature scaling)
const FEATURE_BOUNDS = {
  hops: { min: 2, max: 6 },
  liquidity: { min: 10000, max: 10000000 }, // $10K to $10M
  fee: { min: 100, max: 10000 },            // 0.01% to 1%
  volatility: { min: 0, max: 10 },          // 0% to 10%
  gasCost: { min: 50000, max: 500000 },     // gas units
  historySuccess: { min: 0, max: 100 },     // count
};

/**
 * Normalize a feature to [0, 1] range using min-max scaling
 * @param {number} value - Raw feature value
 * @param {object} bounds - { min, max } bounds
 * @returns {number} - Normalized value in [0, 1]
 */
function normalize(value, bounds) {
  const { min, max } = bounds;
  if (max === min) return 0.5;
  const clamped = Math.max(min, Math.min(max, value));
  return (clamped - min) / (max - min);
}

/**
 * Compute heuristic score for a single route
 * @param {number[]} features - [hops, liquidity, fee, volatility, gasCost, historySuccess]
 * @returns {number} - Score in [0, 1] range
 */
function computeHeuristicScore(features) {
  const [hops, liquidity, fee, volatility, gasCost, historySuccess] = features;

  // Normalize all features
  const normHops = normalize(hops, FEATURE_BOUNDS.hops);
  const normLiquidity = normalize(liquidity, FEATURE_BOUNDS.liquidity);
  const normFee = normalize(fee, FEATURE_BOUNDS.fee);
  const normVolatility = normalize(volatility, FEATURE_BOUNDS.volatility);
  const normGasCost = normalize(gasCost, FEATURE_BOUNDS.gasCost);
  const normHistory = normalize(historySuccess, FEATURE_BOUNDS.historySuccess);

  // Weighted sum
  const score =
    HEURISTIC_WEIGHTS.hops * normHops +
    HEURISTIC_WEIGHTS.liquidity * normLiquidity +
    HEURISTIC_WEIGHTS.fee * normFee +
    HEURISTIC_WEIGHTS.volatility * normVolatility +
    HEURISTIC_WEIGHTS.gasCost * normGasCost +
    HEURISTIC_WEIGHTS.historySuccess * normHistory;

  // Map from weighted sum range to [0, 1]
  // With current weights sum is roughly [-0.55, 0.55], map to [0, 1]
  return Math.max(0, Math.min(1, (score + 0.55) / 1.1));
}

/**
 * Score routes using ML endpoint with heuristic fallback
 * @param {number[][]} features - Array of feature vectors
 * @returns {Promise<number[]>} - Array of scores in [0, 1]
 */
async function score(features) {
  const endpoint = process.env.ML_MODEL_ENDPOINT;

  if (endpoint) {
    try {
      const { data } = await axios.post(endpoint, { features }, { timeout: 2000 });
      if (data.probabilities && Array.isArray(data.probabilities)) {
        return data.probabilities;
      }
    } catch (err) {
      console.warn(`[mlScorer] ML endpoint error: ${err.message}. Using heuristic fallback.`);
    }
  }

  // Heuristic fallback
  return features.map((f) => computeHeuristicScore(f));
}

/**
 * Get heuristic scores only (for testing or when ML is explicitly disabled)
 * @param {number[][]} features - Array of feature vectors
 * @returns {number[]} - Array of heuristic scores
 */
function getHeuristicScores(features) {
  return features.map((f) => computeHeuristicScore(f));
}

module.exports = score;
module.exports.score = score;
module.exports.getHeuristicScores = getHeuristicScores;
module.exports.computeHeuristicScore = computeHeuristicScore;
module.exports.HEURISTIC_WEIGHTS = HEURISTIC_WEIGHTS;
module.exports.FEATURE_BOUNDS = FEATURE_BOUNDS;
