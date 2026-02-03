// server/scripts/balancerUtils.js
/**
 * Balancer V2 Utilities for Flash Loan Arbitrage Bot
 * Supports vault swaps, batch swaps, and SOR (Smart Order Router)
 */

const { ethers } = require("ethers");

// Try to load Balancer SDK, but don't fail if not installed
let BalancerSDK, Network;
try {
  ({ BalancerSDK, Network } = require("@balancer-labs/sdk"));
} catch (err) {
  console.warn("[balancerUtils] @balancer-labs/sdk not installed, using direct vault interactions");
}

// Balancer Vault ABI for direct interactions
const BALANCER_VAULT_ABI = [
  "function swap((bytes32 poolId, uint8 kind, address assetIn, address assetOut, uint256 amount, bytes userData), (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance), uint256 limit, uint256 deadline) external payable returns (uint256 amountCalculated)",
  "function batchSwap(uint8 kind, (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds, int256[] limits, uint256 deadline) external payable returns (int256[] assetDeltas)",
  "function queryBatchSwap(uint8 kind, (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps, address[] assets, (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds) external returns (int256[] assetDeltas)",
  "function getPoolTokens(bytes32 poolId) external view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)",
  "event Swap(bytes32 indexed poolId, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
];

// Weighted Pool ABI for pool-specific queries
const WEIGHTED_POOL_ABI = [
  "function getPoolId() external view returns (bytes32)",
  "function getNormalizedWeights() external view returns (uint256[])",
  "function getSwapFeePercentage() external view returns (uint256)",
];

// Contract addresses (mainnet)
const BALANCER_VAULT = process.env.BALANCER_VAULT || "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

// SwapKind enum
const SwapKind = {
  GIVEN_IN: 0,
  GIVEN_OUT: 1,
};

// Cached SDK instances
let balancerInstance = null;
let sorInstance = null;
let rpcProvider = null;

/**
 * Initialize Balancer SDK with a provider
 * @param {Object} provider - Ethers provider
 * @returns {Object} - { balancer, sor, vault }
 */
async function initBalancer(provider) {
  if (!provider) {
    throw new Error("Provider is required for Balancer initialization");
  }

  rpcProvider = provider;

  // If SDK is available, use it
  if (BalancerSDK && Network) {
    const network = await provider.getNetwork();
    const chainId = network.chainId;

    // Map chainId to Balancer Network
    let balancerNetwork = Network.MAINNET;
    if (chainId === 137) balancerNetwork = Network.POLYGON;
    else if (chainId === 42161) balancerNetwork = Network.ARBITRUM;
    else if (chainId === 10) balancerNetwork = Network.OPTIMISM;

    const rpcUrl = provider.connection?.url || process.env.MAINNET_RPC_URL || process.env.ETH_RPC_URL;

    balancerInstance = new BalancerSDK({
      network: balancerNetwork,
      rpcUrl,
    });

    sorInstance = balancerInstance.sor;

    // Fetch pool data for SOR
    await sorInstance.fetchPools();

    return {
      balancer: balancerInstance,
      sor: sorInstance,
      vault: new ethers.Contract(BALANCER_VAULT, BALANCER_VAULT_ABI, provider),
    };
  }

  // Fallback to direct vault interaction
  return {
    balancer: null,
    sor: null,
    vault: new ethers.Contract(BALANCER_VAULT, BALANCER_VAULT_ABI, provider),
  };
}

/**
 * Get a quote for a Balancer swap using SOR or direct query
 * @param {string} tokenIn - Input token address
 * @param {string} tokenOut - Output token address
 * @param {BigNumber} amountIn - Amount of input token
 * @param {Object} options - Optional { poolId, provider }
 * @returns {BigNumber} - Expected output amount
 */
async function getBalancerQuote(tokenIn, tokenOut, amountIn, options = {}) {
  const provider = options.provider || rpcProvider;

  // Try SOR first if available
  if (sorInstance) {
    try {
      const swapInfo = await sorInstance.getSwaps(
        tokenIn,
        tokenOut,
        SwapKind.GIVEN_IN,
        amountIn.toString()
      );
      if (swapInfo && swapInfo.returnAmount) {
        return ethers.BigNumber.from(swapInfo.returnAmount);
      }
    } catch (err) {
      console.warn(`[balancerUtils] SOR quote failed: ${err.message}, trying direct query`);
    }
  }

  // Fallback to direct vault query if poolId is provided
  if (options.poolId && provider) {
    return getBalancerQuoteDirect(provider, options.poolId, tokenIn, tokenOut, amountIn);
  }

  throw new Error("Balancer quote failed: No SOR available and no poolId provided");
}

/**
 * Get a quote using direct vault queryBatchSwap
 * @param {Object} provider - Ethers provider
 * @param {string} poolId - Pool ID (bytes32)
 * @param {string} tokenIn - Input token address
 * @param {string} tokenOut - Output token address
 * @param {BigNumber} amountIn - Amount of input token
 * @returns {BigNumber} - Expected output amount
 */
async function getBalancerQuoteDirect(provider, poolId, tokenIn, tokenOut, amountIn) {
  const vault = new ethers.Contract(BALANCER_VAULT, BALANCER_VAULT_ABI, provider);

  const swaps = [{
    poolId,
    assetInIndex: 0,
    assetOutIndex: 1,
    amount: amountIn,
    userData: "0x",
  }];

  const assets = [tokenIn, tokenOut];

  const funds = {
    sender: ethers.constants.AddressZero,
    fromInternalBalance: false,
    recipient: ethers.constants.AddressZero,
    toInternalBalance: false,
  };

  try {
    const deltas = await vault.callStatic.queryBatchSwap(
      SwapKind.GIVEN_IN,
      swaps,
      assets,
      funds
    );

    // deltas[1] is negative (amount received)
    return deltas[1].mul(-1);
  } catch (err) {
    throw new Error(`Balancer direct quote failed: ${err.message}`);
  }
}

/**
 * Get pool tokens and balances
 * @param {Object} provider - Ethers provider
 * @param {string} poolId - Pool ID (bytes32)
 * @returns {Object} - { tokens, balances, lastChangeBlock }
 */
async function getPoolTokens(provider, poolId) {
  const vault = new ethers.Contract(BALANCER_VAULT, BALANCER_VAULT_ABI, provider);
  const result = await vault.getPoolTokens(poolId);
  return {
    tokens: result.tokens,
    balances: result.balances,
    lastChangeBlock: result.lastChangeBlock,
  };
}

/**
 * Build swap data for Balancer vault single swap
 * @param {string} poolId - Pool ID
 * @param {string} tokenIn - Input token
 * @param {string} tokenOut - Output token
 * @param {BigNumber} amountIn - Amount in
 * @param {BigNumber} minAmountOut - Minimum amount out
 * @returns {Object} - Swap params for vault.swap()
 */
function buildSingleSwapParams(poolId, tokenIn, tokenOut, amountIn, minAmountOut) {
  return {
    singleSwap: {
      poolId,
      kind: SwapKind.GIVEN_IN,
      assetIn: tokenIn,
      assetOut: tokenOut,
      amount: amountIn,
      userData: "0x",
    },
    funds: {
      sender: ethers.constants.AddressZero, // Will be replaced by contract
      fromInternalBalance: false,
      recipient: ethers.constants.AddressZero, // Will be replaced by contract
      toInternalBalance: false,
    },
    limit: minAmountOut,
    deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour
  };
}

/**
 * Build batch swap data for multi-hop Balancer swaps
 * @param {Array} hops - Array of { poolId, tokenIn, tokenOut }
 * @param {BigNumber} amountIn - Initial amount in
 * @param {BigNumber} minAmountOut - Minimum final amount out
 * @returns {Object} - Batch swap params for vault.batchSwap()
 */
function buildBatchSwapParams(hops, amountIn, minAmountOut) {
  // Collect unique assets
  const assetSet = new Set();
  for (const hop of hops) {
    assetSet.add(hop.tokenIn.toLowerCase());
    assetSet.add(hop.tokenOut.toLowerCase());
  }
  const assets = Array.from(assetSet);

  // Build swaps array
  const swaps = hops.map((hop, index) => ({
    poolId: hop.poolId,
    assetInIndex: assets.indexOf(hop.tokenIn.toLowerCase()),
    assetOutIndex: assets.indexOf(hop.tokenOut.toLowerCase()),
    amount: index === 0 ? amountIn : 0, // Only first swap specifies amount
    userData: "0x",
  }));

  // Build limits array (positive for tokens going in, negative for tokens coming out)
  const limits = assets.map((asset, index) => {
    if (index === 0) return amountIn; // Max input
    if (index === assets.length - 1) return minAmountOut.mul(-1); // Min output (negative)
    return 0; // Intermediate tokens
  });

  return {
    kind: SwapKind.GIVEN_IN,
    swaps,
    assets,
    funds: {
      sender: ethers.constants.AddressZero,
      fromInternalBalance: false,
      recipient: ethers.constants.AddressZero,
      toInternalBalance: false,
    },
    limits,
    deadline: Math.floor(Date.now() / 1000) + 3600,
  };
}

/**
 * Find pools containing both tokens
 * @param {Object} provider - Ethers provider
 * @param {string} tokenA - First token
 * @param {string} tokenB - Second token
 * @returns {Array} - Array of pool info objects
 */
async function findBalancerPools(tokenA, tokenB) {
  if (!sorInstance) {
    console.warn("[balancerUtils] SOR not initialized, cannot find pools");
    return [];
  }

  // Use SOR's internal pool data
  const pools = sorInstance.getPools();
  const matchingPools = [];

  for (const pool of pools) {
    const tokens = pool.tokensList || [];
    const hasA = tokens.some(t => t.toLowerCase() === tokenA.toLowerCase());
    const hasB = tokens.some(t => t.toLowerCase() === tokenB.toLowerCase());

    if (hasA && hasB) {
      matchingPools.push({
        id: pool.id,
        address: pool.address,
        poolType: pool.poolType,
        tokens: pool.tokensList,
        swapFee: pool.swapFee,
        totalLiquidity: pool.totalLiquidity,
      });
    }
  }

  return matchingPools;
}

// Export legacy references for backward compatibility
const balancer = balancerInstance;
const sor = sorInstance;

module.exports = {
  initBalancer,
  getBalancerQuote,
  getBalancerQuoteDirect,
  getPoolTokens,
  buildSingleSwapParams,
  buildBatchSwapParams,
  findBalancerPools,
  balancer,
  sor,
  BALANCER_VAULT,
  BALANCER_VAULT_ABI,
  SwapKind,
};
