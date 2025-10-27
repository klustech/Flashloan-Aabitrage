// server/scripts/curveUtils.js
const { ethers } = require("ethers");

// Example: interacting with Curve’s StableSwap contract ABI.
// All pools are expected to implement the read-only quoting helpers below in
// addition to the common metadata views used during route discovery. Meta
// pools and lending pools expose `get_dy_underlying` while plain pools only
// expose `get_dy`.
const CURVE_POOL_ABI = [
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function coins(uint256 index) view returns (address)",
  "function underlying_coins(uint256 index) view returns (address)",
  "function balances(int128 index) view returns (uint256)",
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
];

async function getCurveQuote(
  provider,
  poolAddress,
  i,
  j,
  amountIn,
  { useUnderlying = false } = {}
) {
  const pool = new ethers.Contract(poolAddress, CURVE_POOL_ABI, provider);
  const method = useUnderlying ? "get_dy_underlying" : "get_dy";

  if (typeof pool[method] !== "function") {
    throw new Error(
      `Curve pool ${poolAddress} does not implement ${method} required for quoting`
    );
  }

  try {
    const dy = await pool[method](i, j, amountIn);
    return ethers.BigNumber.from(dy);
  } catch (error) {
    const reason =
      error?.error?.message ||
      error?.reason ||
      error?.data?.message ||
      error?.message ||
      "unknown error";
    throw new Error(
      `Curve pool quote failed for ${poolAddress} using ${method}(${i}, ${j}) with amount ${amountIn}: ${reason}`,
      { cause: error }
    );
  }
}

module.exports = { getCurveQuote, CURVE_POOL_ABI };
