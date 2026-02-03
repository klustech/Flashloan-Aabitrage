// server/scripts/v3Utils.js
/**
 * Uniswap V3 Utilities for Flash Loan Arbitrage Bot
 * Supports QuoterV1, QuoterV2, and multi-hop paths
 */

const { ethers } = require("ethers");

// Quoter V1 ABI (legacy)
const QuoterV1ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
  "function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut)",
];

// Quoter V2 ABI (recommended for gas efficiency)
const QuoterV2ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
];

// V3 Pool ABI for direct pool queries
const V3PoolABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
];

// V3 Factory ABI for pool lookup
const V3FactoryABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

// Contract addresses (mainnet defaults)
const UNISWAP_V3_QUOTER = process.env.UNISWAP_V3_QUOTER || "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const UNISWAP_V3_QUOTER_V2 = process.env.UNISWAP_V3_QUOTER_V2 || "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const UNISWAP_V3_FACTORY = process.env.UNISWAP_V3_FACTORY || "0x1F98431c8aD98523631AE4a59f267346ea31F984";

// Standard fee tiers (in hundredths of a bip)
const FEE_TIERS = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%

/**
 * Get a quote for a single-hop V3 swap using QuoterV1
 * @param {Object} provider - Ethers provider
 * @param {string} tokenIn - Input token address
 * @param {string} tokenOut - Output token address
 * @param {number} fee - Fee tier (100, 500, 3000, or 10000)
 * @param {BigNumber} amountIn - Amount of input token
 * @returns {BigNumber} - Expected output amount
 */
async function getV3Quote(provider, tokenIn, tokenOut, fee, amountIn) {
  const quoter = new ethers.Contract(UNISWAP_V3_QUOTER, QuoterV1ABI, provider);
  try {
    return await quoter.callStatic.quoteExactInputSingle(
      tokenIn,
      tokenOut,
      fee,
      amountIn,
      0
    );
  } catch (err) {
    // If QuoterV1 fails, try QuoterV2
    return getV3QuoteV2(provider, tokenIn, tokenOut, fee, amountIn);
  }
}

/**
 * Get a quote using QuoterV2 (more gas efficient, returns additional data)
 * @param {Object} provider - Ethers provider
 * @param {string} tokenIn - Input token address
 * @param {string} tokenOut - Output token address
 * @param {number} fee - Fee tier
 * @param {BigNumber} amountIn - Amount of input token
 * @returns {BigNumber} - Expected output amount
 */
async function getV3QuoteV2(provider, tokenIn, tokenOut, fee, amountIn) {
  const quoter = new ethers.Contract(UNISWAP_V3_QUOTER_V2, QuoterV2ABI, provider);
  const params = {
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0,
  };
  const result = await quoter.callStatic.quoteExactInputSingle(params);
  return result.amountOut;
}

/**
 * Get a multi-hop V3 quote
 * @param {Object} provider - Ethers provider
 * @param {Array} path - Array of {token, fee} objects defining the path
 * @param {BigNumber} amountIn - Amount of input token
 * @returns {BigNumber} - Expected output amount
 */
async function getV3MultiHopQuote(provider, path, amountIn) {
  if (!path || path.length < 2) {
    throw new Error("Path must contain at least 2 tokens");
  }

  // Encode the path for V3 quoter
  const encodedPath = encodeV3Path(path);
  const quoter = new ethers.Contract(UNISWAP_V3_QUOTER, QuoterV1ABI, provider);

  try {
    return await quoter.callStatic.quoteExactInput(encodedPath, amountIn);
  } catch (err) {
    // Fallback to sequential single-hop quotes
    let currentAmount = amountIn;
    for (let i = 0; i < path.length - 1; i++) {
      currentAmount = await getV3Quote(
        provider,
        path[i].token,
        path[i + 1].token,
        path[i].fee || 3000,
        currentAmount
      );
    }
    return currentAmount;
  }
}

/**
 * Encode a path for V3 multi-hop swaps
 * Path format: token0 + fee0 + token1 + fee1 + token2 ...
 * @param {Array} path - Array of {token, fee} objects
 * @returns {string} - Encoded path bytes
 */
function encodeV3Path(path) {
  let encoded = "0x";
  for (let i = 0; i < path.length; i++) {
    // Add token address (20 bytes)
    encoded += path[i].token.slice(2).toLowerCase();
    // Add fee if not the last token (3 bytes)
    if (i < path.length - 1) {
      const fee = path[i].fee || 3000;
      encoded += fee.toString(16).padStart(6, "0");
    }
  }
  return encoded;
}

/**
 * Find the best fee tier for a token pair
 * @param {Object} provider - Ethers provider
 * @param {string} tokenA - First token address
 * @param {string} tokenB - Second token address
 * @param {BigNumber} amountIn - Amount for quote comparison
 * @returns {Object} - { fee, amountOut, poolAddress }
 */
async function findBestV3Pool(provider, tokenA, tokenB, amountIn) {
  const factory = new ethers.Contract(UNISWAP_V3_FACTORY, V3FactoryABI, provider);
  let bestFee = 3000;
  let bestOut = ethers.BigNumber.from(0);
  let bestPool = null;

  for (const fee of FEE_TIERS) {
    try {
      const poolAddress = await factory.getPool(tokenA, tokenB, fee);
      if (poolAddress === ethers.constants.AddressZero) continue;

      const quote = await getV3Quote(provider, tokenA, tokenB, fee, amountIn);
      if (quote.gt(bestOut)) {
        bestOut = quote;
        bestFee = fee;
        bestPool = poolAddress;
      }
    } catch (err) {
      // Pool doesn't exist or has no liquidity
      continue;
    }
  }

  return { fee: bestFee, amountOut: bestOut, poolAddress: bestPool };
}

/**
 * Get pool information for V3 pool
 * @param {Object} provider - Ethers provider
 * @param {string} poolAddress - V3 pool address
 * @returns {Object} - Pool state information
 */
async function getV3PoolInfo(provider, poolAddress) {
  const pool = new ethers.Contract(poolAddress, V3PoolABI, provider);

  const [slot0, liquidity, token0, token1, fee] = await Promise.all([
    pool.slot0(),
    pool.liquidity(),
    pool.token0(),
    pool.token1(),
    pool.fee(),
  ]);

  return {
    sqrtPriceX96: slot0.sqrtPriceX96,
    tick: slot0.tick,
    liquidity,
    token0,
    token1,
    fee,
    unlocked: slot0.unlocked,
  };
}

/**
 * Calculate price from sqrtPriceX96
 * @param {BigNumber} sqrtPriceX96 - Square root price from slot0
 * @param {number} decimals0 - Decimals of token0
 * @param {number} decimals1 - Decimals of token1
 * @returns {number} - Price of token0 in terms of token1
 */
function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0 = 18, decimals1 = 18) {
  const price = sqrtPriceX96.pow(2).mul(ethers.BigNumber.from(10).pow(decimals0))
    .div(ethers.BigNumber.from(2).pow(192))
    .div(ethers.BigNumber.from(10).pow(decimals1));
  return parseFloat(ethers.utils.formatUnits(price, 0));
}

/**
 * Get all V3 pools for a token pair across all fee tiers
 * @param {Object} provider - Ethers provider
 * @param {string} tokenA - First token address
 * @param {string} tokenB - Second token address
 * @returns {Array} - Array of pool objects with addresses and fees
 */
async function getAllV3Pools(provider, tokenA, tokenB) {
  const factory = new ethers.Contract(UNISWAP_V3_FACTORY, V3FactoryABI, provider);
  const pools = [];

  for (const fee of FEE_TIERS) {
    try {
      const poolAddress = await factory.getPool(tokenA, tokenB, fee);
      if (poolAddress !== ethers.constants.AddressZero) {
        pools.push({
          address: poolAddress,
          fee,
          token0: tokenA < tokenB ? tokenA : tokenB,
          token1: tokenA < tokenB ? tokenB : tokenA,
        });
      }
    } catch (err) {
      continue;
    }
  }

  return pools;
}

module.exports = {
  getV3Quote,
  getV3QuoteV2,
  getV3MultiHopQuote,
  encodeV3Path,
  findBestV3Pool,
  getV3PoolInfo,
  getAllV3Pools,
  sqrtPriceX96ToPrice,
  V3PoolABI,
  FEE_TIERS,
  UNISWAP_V3_QUOTER,
  UNISWAP_V3_QUOTER_V2,
  UNISWAP_V3_FACTORY,
};
