// scripts/evaluation.js

const { getSettings } = require('./settings');
const { ethers } = require('ethers');
const { executeWithRetry } = require('./retry');
const { logMessage } = require('./logging');
const { getProvider, getRouterContract } = require('./contracts');
// NEW: Import token risk calculation
const { getTokenRiskScore } = require('./tokenRisk');

/**
 * Checks if a token is a honeypot by simulating a sell using getAmountsOut.
 * Returns true if the token appears to be a honeypot, false otherwise.
 *
 * @param {string} tokenAddress
 * @returns {Promise<boolean>}
 */
async function isHoneypot(tokenAddress) {
  const settings = getSettings();
  const baseToken = settings.BASE_TOKEN_ADDRESS;
  const smallAmount = ethers.utils.parseUnits('1', 18);
  try {
    const router = getRouterContract();
    const path = [tokenAddress, baseToken];
    const amountsOut = await executeWithRetry(() => router.getAmountsOut(smallAmount, path));
    if (amountsOut && amountsOut.length > 1 && amountsOut[1].gt(0)) {
      logMessage(`getAmountsOut succeeded for ${tokenAddress}: ${ethers.utils.formatEther(amountsOut[1])} ETH output.`, {}, 'info');
      return false;
    } else {
      logMessage(`getAmountsOut returned invalid result for ${tokenAddress}.`, {}, 'error');
      return true;
    }
  } catch (err) {
    logMessage(`Honeypot check via getAmountsOut failed for ${tokenAddress}: ${err.message}`, {}, 'error');
    return true;
  }
}

/**
 * Evaluates pair liquidity and viability.
 * Returns true if the pair is viable, false otherwise.
 *
 * @param {string} pairAddress
 * @param {string} token0
 * @param {string} token1
 * @returns {Promise<boolean>}
 */
async function evaluatePair(pairAddress, token0, token1) {
  try {
    const settings = getSettings();
    const provider = getProvider();
    const pairAbi = [
      'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
    ];
    const pairContract = new ethers.Contract(pairAddress, pairAbi, provider);
    const reserves = await executeWithRetry(() => pairContract.getReserves());
    const baseToken = settings.BASE_TOKEN_ADDRESS.toLowerCase();
    let baseReserve, otherReserve;
    if (token0.toLowerCase() === baseToken) {
      baseReserve = parseFloat(ethers.utils.formatUnits(reserves.reserve0, 18));
      otherReserve = parseFloat(ethers.utils.formatUnits(reserves.reserve1, 18));
    } else {
      baseReserve = parseFloat(ethers.utils.formatUnits(reserves.reserve1, 18));
      otherReserve = parseFloat(ethers.utils.formatUnits(reserves.reserve0, 18));
    }
    logMessage(`Reserves => Base Token: ${baseReserve}, Other Token: ${otherReserve}`, {}, 'info');
    const minBaseReserve = settings.MIN_BASE_TOKEN_RESERVE;
    if (baseReserve < minBaseReserve) {
      logMessage(`Base token reserve too low: ${baseReserve} < ${minBaseReserve}`, {}, 'error');
      return false;
    }

    // NEW: Token risk calculation
    const newTokenAddress = token0.toLowerCase() === baseToken ? token1 : token0;
    const riskScore = await getTokenRiskScore(newTokenAddress, pairAddress, provider);
    const maxTokenRisk = settings.MAX_TOKEN_RISK_SCORE || 50;
    if (riskScore > maxTokenRisk) {
      logMessage(`Token risk score too high: ${riskScore} exceeds threshold ${maxTokenRisk}`, {}, 'error');
      return false;
    }

    return true;
  } catch (err) {
    logMessage(`evaluatePair error: ${err.message}`, {}, 'error');
    return false;
  }
}

module.exports = {
  isHoneypot,
  evaluatePair
};
