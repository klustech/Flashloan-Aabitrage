// server/scripts/curveUtils.js
/**
 * Curve Finance Utilities for Flash Loan Arbitrage Bot
 * Supports StableSwap, CryptoSwap, and Meta pools
 */

const { ethers } = require("ethers");

// Curve Pool ABI - comprehensive version supporting different pool types
const CURVE_POOL_ABI = [
  // Quoting functions
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
  // Uint256 index variants (CryptoSwap pools)
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
  // Token information
  "function coins(uint256 index) view returns (address)",
  "function coins(int128 index) view returns (address)",
  "function underlying_coins(uint256 index) view returns (address)",
  "function underlying_coins(int128 index) view returns (address)",
  // Pool state
  "function balances(uint256 index) view returns (uint256)",
  "function balances(int128 index) view returns (uint256)",
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function get_virtual_price() view returns (uint256)",
  // Exchange functions
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
  "function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
  // CryptoSwap exchange
  "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) returns (uint256)",
  // Events
  "event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)",
  "event TokenExchangeUnderlying(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)",
];

// Curve Registry ABI for pool discovery
const CURVE_REGISTRY_ABI = [
  "function pool_count() view returns (uint256)",
  "function pool_list(uint256 index) view returns (address)",
  "function get_pool_from_lp_token(address lp_token) view returns (address)",
  "function get_lp_token(address pool) view returns (address)",
  "function get_n_coins(address pool) view returns (uint256[2])",
  "function get_coins(address pool) view returns (address[8])",
  "function get_underlying_coins(address pool) view returns (address[8])",
  "function get_decimals(address pool) view returns (uint256[8])",
  "function get_balances(address pool) view returns (uint256[8])",
  "function get_pool_asset_type(address pool) view returns (uint256)",
  "function is_meta(address pool) view returns (bool)",
  "function find_pool_for_coins(address from, address to) view returns (address)",
  "function find_pool_for_coins(address from, address to, uint256 i) view returns (address)",
];

// Curve Address Provider for discovering registries
const ADDRESS_PROVIDER_ABI = [
  "function get_registry() view returns (address)",
  "function get_address(uint256 id) view returns (address)",
];

// Contract addresses (mainnet)
const CURVE_ADDRESS_PROVIDER = process.env.CURVE_ADDRESS_PROVIDER || "0x0000000022D53366457F9d5E68Ec105046FC4383";
const CURVE_REGISTRY = process.env.CURVE_REGISTRY || "0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5";
const CURVE_FACTORY_REGISTRY = process.env.CURVE_FACTORY_REGISTRY || "0xB9fC157394Af804a3578134A6585C0dc9cc990d4";
const CURVE_CRYPTO_REGISTRY = process.env.CURVE_CRYPTO_REGISTRY || "0x8F942C20D02bEfc377D41445793068908E2250D0";

// Common Curve pool addresses for quick lookup
const KNOWN_POOLS = {
  "3pool": "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7", // DAI/USDC/USDT
  "steth": "0xDC24316b9AE028F1497c275EB9192a3Ea0f67022", // ETH/stETH
  "tricrypto2": "0xD51a44d3FaE010294C616388b506AcdA1bfAAE46", // USDT/WBTC/WETH
  "frax": "0xd632f22692FaC7611d2AA1C0D552930D43CAEd3B", // FRAX/3CRV
  "susd": "0xA5407eAE9Ba41422680e2e00537571bcC53efBfD", // DAI/USDC/USDT/sUSD
};

// Cache for pool coin indices
const coinIndexCache = new Map();

/**
 * Get a quote for a Curve swap
 * @param {Object} provider - Ethers provider
 * @param {string} poolAddress - Pool address
 * @param {number} i - Input coin index
 * @param {number} j - Output coin index
 * @param {BigNumber} amountIn - Amount of input token
 * @param {Object} options - { useUnderlying: boolean, isCryptoPool: boolean }
 * @returns {BigNumber} - Expected output amount
 */
async function getCurveQuote(
  provider,
  poolAddress,
  i,
  j,
  amountIn,
  { useUnderlying = false, isCryptoPool = false } = {}
) {
  const pool = new ethers.Contract(poolAddress, CURVE_POOL_ABI, provider);

  // Try different method signatures based on pool type
  const methods = [];

  if (useUnderlying) {
    methods.push({ name: "get_dy_underlying", args: [i, j, amountIn] });
  } else if (isCryptoPool) {
    // CryptoSwap pools use uint256 indices
    methods.push({ name: "get_dy", args: [ethers.BigNumber.from(i), ethers.BigNumber.from(j), amountIn] });
  } else {
    methods.push({ name: "get_dy", args: [i, j, amountIn] });
  }

  // Fallback methods
  if (!useUnderlying && !isCryptoPool) {
    methods.push({ name: "get_dy", args: [ethers.BigNumber.from(i), ethers.BigNumber.from(j), amountIn] });
  }

  let lastError = null;
  for (const method of methods) {
    try {
      const dy = await pool[method.name](...method.args);
      return ethers.BigNumber.from(dy);
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  const reason =
    lastError?.error?.message ||
    lastError?.reason ||
    lastError?.data?.message ||
    lastError?.message ||
    "unknown error";
  throw new Error(
    `Curve pool quote failed for ${poolAddress} using ${methods[0].name}(${i}, ${j}) with amount ${amountIn}: ${reason}`,
    { cause: lastError }
  );
}

/**
 * Get coin index for a token in a pool
 * @param {Object} provider - Ethers provider
 * @param {string} poolAddress - Pool address
 * @param {string} tokenAddress - Token to find
 * @param {boolean} useUnderlying - Check underlying coins instead
 * @returns {number} - Coin index or -1 if not found
 */
async function getCoinIndex(provider, poolAddress, tokenAddress, useUnderlying = false) {
  const cacheKey = `${poolAddress}-${tokenAddress}-${useUnderlying}`;
  if (coinIndexCache.has(cacheKey)) {
    return coinIndexCache.get(cacheKey);
  }

  const pool = new ethers.Contract(poolAddress, CURVE_POOL_ABI, provider);
  const method = useUnderlying ? "underlying_coins" : "coins";

  for (let i = 0; i < 8; i++) {
    try {
      let coin;
      try {
        coin = await pool[method](i);
      } catch {
        coin = await pool[method](ethers.BigNumber.from(i));
      }

      if (coin.toLowerCase() === tokenAddress.toLowerCase()) {
        coinIndexCache.set(cacheKey, i);
        return i;
      }
    } catch {
      // Reached end of coins array
      break;
    }
  }

  coinIndexCache.set(cacheKey, -1);
  return -1;
}

/**
 * Get all coins in a pool
 * @param {Object} provider - Ethers provider
 * @param {string} poolAddress - Pool address
 * @param {boolean} useUnderlying - Get underlying coins instead
 * @returns {Array} - Array of coin addresses
 */
async function getPoolCoins(provider, poolAddress, useUnderlying = false) {
  const pool = new ethers.Contract(poolAddress, CURVE_POOL_ABI, provider);
  const method = useUnderlying ? "underlying_coins" : "coins";
  const coins = [];

  for (let i = 0; i < 8; i++) {
    try {
      let coin;
      try {
        coin = await pool[method](i);
      } catch {
        coin = await pool[method](ethers.BigNumber.from(i));
      }

      if (coin === ethers.constants.AddressZero) break;
      coins.push(coin);
    } catch {
      break;
    }
  }

  return coins;
}

/**
 * Get pool information including coins and balances
 * @param {Object} provider - Ethers provider
 * @param {string} poolAddress - Pool address
 * @returns {Object} - Pool info
 */
async function getPoolInfo(provider, poolAddress) {
  const pool = new ethers.Contract(poolAddress, CURVE_POOL_ABI, provider);

  const coins = await getPoolCoins(provider, poolAddress);
  const balances = [];

  for (let i = 0; i < coins.length; i++) {
    try {
      let balance;
      try {
        balance = await pool.balances(i);
      } catch {
        balance = await pool.balances(ethers.BigNumber.from(i));
      }
      balances.push(balance);
    } catch {
      balances.push(ethers.BigNumber.from(0));
    }
  }

  let fee = ethers.BigNumber.from(0);
  let A = ethers.BigNumber.from(0);
  let virtualPrice = ethers.BigNumber.from(0);

  try {
    fee = await pool.fee();
  } catch {}

  try {
    A = await pool.A();
  } catch {}

  try {
    virtualPrice = await pool.get_virtual_price();
  } catch {}

  return {
    address: poolAddress,
    coins,
    balances,
    fee, // in 1e10 (0.04% = 4000000)
    A,
    virtualPrice,
  };
}

/**
 * Find pools that support trading between two tokens
 * @param {Object} provider - Ethers provider
 * @param {string} tokenIn - Input token address
 * @param {string} tokenOut - Output token address
 * @returns {Array} - Array of pool addresses
 */
async function findPoolsForPair(provider, tokenIn, tokenOut) {
  const pools = [];

  // Try main registry
  try {
    const registry = new ethers.Contract(CURVE_REGISTRY, CURVE_REGISTRY_ABI, provider);

    // Find up to 5 pools for this pair
    for (let i = 0; i < 5; i++) {
      try {
        const poolAddr = await registry["find_pool_for_coins(address,address,uint256)"](tokenIn, tokenOut, i);
        if (poolAddr !== ethers.constants.AddressZero && !pools.includes(poolAddr)) {
          pools.push(poolAddr);
        }
      } catch {
        break;
      }
    }
  } catch (err) {
    console.warn(`[curveUtils] Registry lookup failed: ${err.message}`);
  }

  // Also check known pools
  for (const poolAddr of Object.values(KNOWN_POOLS)) {
    if (pools.includes(poolAddr)) continue;

    try {
      const coins = await getPoolCoins(provider, poolAddr);
      const hasIn = coins.some(c => c.toLowerCase() === tokenIn.toLowerCase());
      const hasOut = coins.some(c => c.toLowerCase() === tokenOut.toLowerCase());

      if (hasIn && hasOut) {
        pools.push(poolAddr);
      }
    } catch {
      continue;
    }
  }

  return pools;
}

/**
 * Get the best quote across all available pools for a pair
 * @param {Object} provider - Ethers provider
 * @param {string} tokenIn - Input token address
 * @param {string} tokenOut - Output token address
 * @param {BigNumber} amountIn - Amount of input token
 * @returns {Object} - { pool, amountOut, i, j, useUnderlying }
 */
async function getBestCurveQuote(provider, tokenIn, tokenOut, amountIn) {
  const pools = await findPoolsForPair(provider, tokenIn, tokenOut);

  let bestPool = null;
  let bestOut = ethers.BigNumber.from(0);
  let bestI = 0;
  let bestJ = 0;
  let bestUnderlying = false;

  for (const poolAddr of pools) {
    // Try regular coins first
    let i = await getCoinIndex(provider, poolAddr, tokenIn, false);
    let j = await getCoinIndex(provider, poolAddr, tokenOut, false);
    let useUnderlying = false;

    // If not found, try underlying
    if (i === -1 || j === -1) {
      i = await getCoinIndex(provider, poolAddr, tokenIn, true);
      j = await getCoinIndex(provider, poolAddr, tokenOut, true);
      useUnderlying = true;
    }

    if (i === -1 || j === -1) continue;

    try {
      const quote = await getCurveQuote(provider, poolAddr, i, j, amountIn, { useUnderlying });
      if (quote.gt(bestOut)) {
        bestOut = quote;
        bestPool = poolAddr;
        bestI = i;
        bestJ = j;
        bestUnderlying = useUnderlying;
      }
    } catch {
      continue;
    }
  }

  if (!bestPool) {
    throw new Error(`No Curve pool found for ${tokenIn} -> ${tokenOut}`);
  }

  return {
    pool: bestPool,
    amountOut: bestOut,
    i: bestI,
    j: bestJ,
    useUnderlying: bestUnderlying,
  };
}

/**
 * Build exchange calldata for Curve swap
 * @param {string} poolAddress - Pool address
 * @param {number} i - Input coin index
 * @param {number} j - Output coin index
 * @param {BigNumber} amountIn - Amount in
 * @param {BigNumber} minAmountOut - Minimum amount out
 * @param {boolean} useUnderlying - Use underlying coins
 * @returns {string} - Encoded calldata
 */
function buildExchangeCalldata(poolAddress, i, j, amountIn, minAmountOut, useUnderlying = false) {
  const iface = new ethers.utils.Interface(CURVE_POOL_ABI);
  const method = useUnderlying ? "exchange_underlying" : "exchange";
  return iface.encodeFunctionData(method, [i, j, amountIn, minAmountOut]);
}

module.exports = {
  getCurveQuote,
  getCoinIndex,
  getPoolCoins,
  getPoolInfo,
  findPoolsForPair,
  getBestCurveQuote,
  buildExchangeCalldata,
  CURVE_POOL_ABI,
  CURVE_REGISTRY_ABI,
  CURVE_ADDRESS_PROVIDER,
  CURVE_REGISTRY,
  KNOWN_POOLS,
};

