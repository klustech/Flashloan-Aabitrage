/**
 * server/scripts/optimalParams.js
 *
 * Optimal Parameter Calculation for Flash Loan Arbitrage
 * - Dynamic slippage based on market conditions
 * - Optimal borrow amount calculation
 * - Gas-adjusted profit analysis
 * - Market volatility consideration
 */

const { ethers, BigNumber } = require("ethers");
const axios = require("axios");

// Aave V2 Lending Pool Data Provider ABI
const AAVE_DATA_PROVIDER_ABI = [
  "function getReserveData(address asset) view returns (uint256 availableLiquidity, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
];

// Aave V2 Price Oracle ABI
const AAVE_ORACLE_ABI = [
  "function getAssetPrice(address asset) view returns (uint256)",
];

// Contract addresses (mainnet)
const AAVE_DATA_PROVIDER = process.env.AAVE_DATA_PROVIDER || "0x057835Ad21a177dbdd3090bB1CAE03EaCF78Fc6d";
const AAVE_PRICE_ORACLE = process.env.AAVE_PRICE_ORACLE || "0xA50ba011c48153De246E5192C8f9258A2ba79Ca9";

// Volatility cache
const volatilityCache = {
  data: null,
  timestamp: 0,
  duration: 60000, // 1 minute cache
};

// Configuration
const DEFAULT_CONFIG = {
  // Slippage parameters
  baseSlippageBips: 50,        // 0.5% base slippage
  maxSlippageBips: 300,        // 3% max slippage
  minSlippageBips: 10,         // 0.1% min slippage
  volatilityMultiplier: 10,    // Multiply 24h change % by this for slippage

  // Borrow parameters
  minBorrowUSD: 1000,          // Minimum $1000 borrow
  maxBorrowUSD: 500000,        // Maximum $500k borrow
  liquidityUtilization: 0.3,   // Use max 30% of available liquidity
  profitTargetPercent: 0.1,    // Target 0.1% profit minimum

  // Gas parameters
  minProfitAfterGas: 0.5,      // Minimum $0.50 profit after gas
  gasEstimateBuffer: 1.5,      // 50% buffer on gas estimates
};

/**
 * Get 24h volatility from CoinGecko
 * @param {string} coinId - CoinGecko coin ID
 * @returns {number} - 24h volatility as absolute percentage
 */
async function getVolatility(coinId = "ethereum") {
  const now = Date.now();

  if (volatilityCache.data && now - volatilityCache.timestamp < volatilityCache.duration) {
    return volatilityCache.data;
  }

  try {
    const { data } = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      {
        params: {
          ids: coinId,
          vs_currencies: "usd",
          include_24hr_change: "true",
        },
        timeout: 10000,
      }
    );

    const change = Math.abs(data[coinId]?.usd_24h_change || 0);
    volatilityCache.data = change;
    volatilityCache.timestamp = now;
    return change;
  } catch (err) {
    console.warn(`[optimalParams] Volatility fetch failed: ${err.message}`);
    return volatilityCache.data || 2; // Default 2% if no data
  }
}

/**
 * Calculate dynamic slippage based on market conditions
 * @param {Object} options - Calculation options
 * @returns {number} - Recommended slippage in bips
 */
async function calculateDynamicSlippage(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };

  // Get market volatility
  const volatility = await getVolatility();

  // Base calculation: base + (volatility * multiplier)
  let slippage = config.baseSlippageBips + Math.round(volatility * config.volatilityMultiplier);

  // Apply route complexity factor if provided
  if (options.hopCount) {
    // Add 10 bips per hop beyond 2
    slippage += Math.max(0, (options.hopCount - 2) * 10);
  }

  // Apply liquidity factor if provided
  if (options.poolLiquidity && options.swapAmount) {
    const impactPercent = options.swapAmount / options.poolLiquidity * 100;
    // Add extra slippage for large swaps relative to pool size
    if (impactPercent > 1) {
      slippage += Math.round(impactPercent * 10);
    }
  }

  // Apply DEX type factor
  if (options.dexType) {
    switch (options.dexType) {
      case "curve":
        // Curve stableswap has lower slippage
        slippage = Math.round(slippage * 0.5);
        break;
      case "uniswap_v3":
        // V3 concentrated liquidity, slightly less slippage
        slippage = Math.round(slippage * 0.8);
        break;
      case "balancer":
        // Depends on pool type
        slippage = Math.round(slippage * 0.9);
        break;
    }
  }

  // Clamp to min/max
  return Math.min(config.maxSlippageBips, Math.max(config.minSlippageBips, slippage));
}

/**
 * Get Aave reserve data for optimal borrow calculation
 * @param {Object} provider - Ethers provider
 * @param {string} asset - Asset address
 * @returns {Object} - Reserve data
 */
async function getAaveReserveData(provider, asset) {
  const dataProvider = new ethers.Contract(
    AAVE_DATA_PROVIDER,
    AAVE_DATA_PROVIDER_ABI,
    provider
  );

  try {
    const [reserveData, configData] = await Promise.all([
      dataProvider.getReserveData(asset),
      dataProvider.getReserveConfigurationData(asset),
    ]);

    return {
      availableLiquidity: reserveData.availableLiquidity,
      totalDebt: reserveData.totalStableDebt.add(reserveData.totalVariableDebt),
      variableRate: reserveData.variableBorrowRate,
      decimals: configData.decimals.toNumber(),
      borrowingEnabled: configData.borrowingEnabled,
      isActive: configData.isActive,
      isFrozen: configData.isFrozen,
    };
  } catch (err) {
    console.error(`[optimalParams] Aave reserve fetch failed: ${err.message}`);
    return null;
  }
}

/**
 * Get asset price from Aave oracle
 * @param {Object} provider - Ethers provider
 * @param {string} asset - Asset address
 * @returns {BigNumber} - Asset price in base currency (ETH for mainnet)
 */
async function getAssetPrice(provider, asset) {
  const oracle = new ethers.Contract(AAVE_PRICE_ORACLE, AAVE_ORACLE_ABI, provider);

  try {
    return await oracle.getAssetPrice(asset);
  } catch (err) {
    console.error(`[optimalParams] Price oracle fetch failed: ${err.message}`);
    return BigNumber.from(0);
  }
}

/**
 * Calculate optimal borrow amount based on market conditions
 * @param {Object} params - Calculation parameters
 * @returns {Object} - Optimal borrow configuration
 */
async function calculateOptimalBorrow(params) {
  const {
    provider,
    borrowToken,
    estimatedProfit,     // Expected profit as percentage (e.g., 0.001 = 0.1%)
    gasPrice,            // Current gas price in wei
    estimatedGas = 500000,
    minBorrow,
    maxBorrow,
  } = params;

  const config = { ...DEFAULT_CONFIG, ...params.config };

  // Get Aave reserve data
  const reserveData = await getAaveReserveData(provider, borrowToken);
  if (!reserveData || !reserveData.borrowingEnabled || reserveData.isFrozen) {
    return {
      recommended: BigNumber.from(0),
      reason: "Borrowing not available",
      isViable: false,
    };
  }

  const decimals = reserveData.decimals;
  const availableLiquidity = reserveData.availableLiquidity;

  // Calculate maximum borrow based on liquidity utilization
  const maxFromLiquidity = availableLiquidity
    .mul(Math.floor(config.liquidityUtilization * 100))
    .div(100);

  // Get gas cost in borrow token terms
  let gasCostInToken = BigNumber.from(0);
  try {
    const ethPrice = await getAssetPrice(provider, borrowToken);
    if (!ethPrice.isZero()) {
      const gasCostWei = gasPrice.mul(estimatedGas).mul(config.gasEstimateBuffer);
      // Convert ETH cost to token amount
      gasCostInToken = gasCostWei.mul(BigNumber.from(10).pow(decimals)).div(ethPrice);
    }
  } catch (err) {
    console.warn(`[optimalParams] Gas cost calculation failed: ${err.message}`);
  }

  // Calculate minimum borrow to cover gas with target profit
  const minProfitBN = ethers.utils.parseUnits(config.minProfitAfterGas.toString(), decimals);
  const profitRate = estimatedProfit || config.profitTargetPercent / 100;

  // minBorrow = (gasCost + minProfit) / profitRate
  const minViableBorrow = gasCostInToken.add(minProfitBN)
    .mul(10000)
    .div(Math.floor(profitRate * 10000));

  // Determine recommended borrow amount
  let recommended;

  // Start with minimum viable, then scale up if liquidity allows
  if (minViableBorrow.gt(maxFromLiquidity)) {
    // Not enough liquidity for minimum viable trade
    return {
      recommended: BigNumber.from(0),
      reason: "Insufficient liquidity for profitable trade",
      isViable: false,
      gasCost: gasCostInToken,
      minViable: minViableBorrow,
      available: availableLiquidity,
    };
  }

  // Use golden ratio between min and max for optimal sizing
  const goldenRatio = 0.618;
  recommended = minViableBorrow.add(
    maxFromLiquidity.sub(minViableBorrow).mul(Math.floor(goldenRatio * 1000)).div(1000)
  );

  // Apply user-specified limits
  if (minBorrow && recommended.lt(minBorrow)) {
    recommended = minBorrow;
  }
  if (maxBorrow && recommended.gt(maxBorrow)) {
    recommended = maxBorrow;
  }

  // Final cap at available liquidity
  if (recommended.gt(availableLiquidity)) {
    recommended = availableLiquidity;
  }

  // Calculate expected profit
  const expectedProfit = recommended.mul(Math.floor(profitRate * 10000)).div(10000);
  const netProfit = expectedProfit.sub(gasCostInToken);

  return {
    recommended,
    minViable: minViableBorrow,
    maxFromLiquidity,
    gasCost: gasCostInToken,
    expectedProfit,
    netProfit,
    isViable: netProfit.gt(minProfitBN),
    profitRate,
    decimals,
  };
}

/**
 * Analyze route for optimal parameters
 * @param {Object} route - Route definition
 * @param {Object} provider - Ethers provider
 * @returns {Object} - Optimal parameters for the route
 */
async function analyzeRoute(route, provider) {
  const analysis = {
    slippage: 0,
    borrowAmount: BigNumber.from(0),
    expectedProfit: BigNumber.from(0),
    gasCost: BigNumber.from(0),
    isViable: false,
    warnings: [],
  };

  if (!route || !route.hops || route.hops.length === 0) {
    analysis.warnings.push("Invalid route");
    return analysis;
  }

  // Calculate dynamic slippage for this route
  const hopCount = route.hops.length;
  const dexTypes = route.hops.map(h => h.dex?.toLowerCase());
  const hasCurve = dexTypes.some(d => d?.includes("curve"));
  const hasV3 = dexTypes.some(d => d?.includes("v3"));

  let dexType = "uniswap_v2"; // default
  if (hasCurve) dexType = "curve";
  else if (hasV3) dexType = "uniswap_v3";

  analysis.slippage = await calculateDynamicSlippage({
    hopCount,
    dexType,
    poolLiquidity: route.liquidity,
  });

  // Calculate estimated profit rate from route simulation
  const profitRate = route.estimatedProfit
    ? parseFloat(ethers.utils.formatUnits(route.estimatedProfit, 18))
    : 0.001; // Default 0.1%

  // Get optimal borrow amount
  const borrowToken = route.hops[0]?.tokenA || process.env.TOKENS_DAI;
  const gasPrice = await provider.getGasPrice();

  const borrowAnalysis = await calculateOptimalBorrow({
    provider,
    borrowToken,
    estimatedProfit: profitRate,
    gasPrice,
    estimatedGas: 300000 + (hopCount * 100000), // Base + per-hop estimate
  });

  analysis.borrowAmount = borrowAnalysis.recommended;
  analysis.gasCost = borrowAnalysis.gasCost;
  analysis.expectedProfit = borrowAnalysis.expectedProfit;
  analysis.netProfit = borrowAnalysis.netProfit;
  analysis.isViable = borrowAnalysis.isViable;

  // Add warnings
  if (hopCount > 3) {
    analysis.warnings.push("Complex route with >3 hops may have higher revert risk");
  }

  if (analysis.slippage > 200) {
    analysis.warnings.push("High slippage setting due to market volatility");
  }

  if (!analysis.isViable) {
    analysis.warnings.push(borrowAnalysis.reason || "Trade may not be profitable after gas");
  }

  return analysis;
}

/**
 * Get current market conditions summary
 * @returns {Object} - Market summary
 */
async function getMarketConditions() {
  const volatility = await getVolatility();

  let sentiment = "neutral";
  if (volatility < 1) sentiment = "stable";
  else if (volatility < 3) sentiment = "moderate";
  else if (volatility < 5) sentiment = "volatile";
  else sentiment = "highly_volatile";

  return {
    volatility,
    sentiment,
    recommendedSlippage: await calculateDynamicSlippage(),
    timestamp: Date.now(),
  };
}

module.exports = {
  calculateDynamicSlippage,
  calculateOptimalBorrow,
  analyzeRoute,
  getMarketConditions,
  getAaveReserveData,
  getAssetPrice,
  getVolatility,
  DEFAULT_CONFIG,
};
