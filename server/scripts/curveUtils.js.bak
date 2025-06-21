// server/scripts/curveUtils.js
const { ethers } = require("ethers");

// Example: interacting with Curve’s StableSwap contract ABI
const CURVE_POOL_ABI = [
  /* minimal ABI: get_dy, get_dy_underlying, etc. */
];

async function getCurveQuote(provider, poolAddress, i, j, amountIn) {
  const pool = new ethers.Contract(poolAddress, CURVE_POOL_ABI, provider);
  // get dy for indices i->j
  const dy = await pool.get_dy(i, j, amountIn);
  return dy; // BigNumber
}

module.exports = { getCurveQuote };
