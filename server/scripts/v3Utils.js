// server/scripts/v3Utils.js
const { ethers } = require("ethers");

// Inline Quoter ABI fragment:
const QuoterABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)",
];

const UNISWAP_V3_QUOTER = process.env.UNISWAP_V3_QUOTER;
// e.g. 0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6

async function getV3Quote(provider, tokenIn, tokenOut, fee, amountIn) {
  const quoter = new ethers.Contract(UNISWAP_V3_QUOTER, QuoterABI, provider);
  return await quoter.callStatic.quoteExactInputSingle(
    tokenIn,
    tokenOut,
    fee,
    amountIn,
    0
  );
}

module.exports = { getV3Quote };
