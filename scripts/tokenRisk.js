// scripts/tokenRisk.js

const { ethers } = require("ethers");
const { logMessage } = require("./logging");
const { getSettings } = require("./settings");

// Minimal Uniswap Pair ABI snippet to get reserves
const PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)"
];

/**
 * Checks the liquidity ratio of a token pair.
 * Returns a risk score (lower is better).
 */
async function checkLiquidityRatio(pairAddress, baseTokenAddress, provider) {
  try {
    const pairContract = new ethers.Contract(pairAddress, PAIR_ABI, provider);
    // Determine token order; this example assumes token0 is base if it matches.
    const token0 = await pairContract.token0();
    const reserves = await pairContract.getReserves();
    let baseReserve, tokenReserve;
    if (baseTokenAddress.toLowerCase() === token0.toLowerCase()) {
      baseReserve = parseFloat(ethers.utils.formatUnits(reserves.reserve0, 18));
      tokenReserve = parseFloat(ethers.utils.formatUnits(reserves.reserve1, 18));
    } else {
      baseReserve = parseFloat(ethers.utils.formatUnits(reserves.reserve1, 18));
      tokenReserve = parseFloat(ethers.utils.formatUnits(reserves.reserve0, 18));
    }
    // Compute a simple ratio. For example, if ratio is outside the range [0.1, 10], assign high risk.
    const ratio = baseReserve / tokenReserve;
    if (ratio < 0.1 || ratio > 10) {
      logMessage(`Liquidity ratio abnormal: ${ratio}`, {}, 'warn');
      return 50; // High risk score.
    }
    return 0;
  } catch (err) {
    logMessage(`Error in liquidity ratio check: ${err.message}`, {}, 'error');
    return 100; // Very high risk if check fails.
  }
}

/**
 * Placeholder for fee analysis (if needed).
 */
async function checkTokenFees(tokenAddress, provider) {
  // Implement fee checks as needed.
  return 0;
}

/**
 * Combines risk factors into a risk score.
 */
async function getTokenRiskScore(tokenAddress, pairAddress, provider) {
  const settings = getSettings();
  const baseTokenAddress = settings.BASE_TOKEN_ADDRESS;
  let riskScore = 0;
  riskScore += await checkLiquidityRatio(pairAddress, baseTokenAddress, provider);
  riskScore += await checkTokenFees(tokenAddress, provider);
  logMessage(`Calculated risk score for token ${tokenAddress}: ${riskScore}`, {}, 'info');
  return riskScore;
}

module.exports = { getTokenRiskScore };
