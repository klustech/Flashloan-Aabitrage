/**
 * SwapDataBuilder - Multi-DEX swap data construction for arbitrage
 * Supports: Uniswap V2, Uniswap V3, SushiSwap, Balancer V2, Curve
 */

const { ethers } = require("ethers");
const { getV3Quote } = require("./v3Utils");
const { getBalancerQuote } = require("./balancerUtils");
const { getCurveQuote } = require("./curveUtils");

// Router addresses from environment
const UNISWAP_V2_ROUTER = process.env.UNISWAP_ROUTER_ADDRESS || process.env.UNISWAP_V2_ROUTER;
const SUSHISWAP_V2_ROUTER = process.env.SUSHISWAP_ROUTER_ADDRESS || process.env.SUSHISWAP_V2_ROUTER;
const UNISWAP_V3_ROUTER = process.env.UNISWAP_V3_ROUTER || "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const BALANCER_VAULT = process.env.BALANCER_VAULT || "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

const UNISWAP_ROUTER_ABI = require("../abis/uniswapRouter.json");

// DEX type enum matching smart contract
const DexType = {
  UNISWAP_V2: 0,
  UNISWAP_V3: 1,
  SUSHISWAP: 2,
  BALANCER: 3,
  CURVE: 4,
};

/**
 * Get router address for V2-compatible DEXes
 */
function getV2Router(dex) {
  const dexLower = dex.toLowerCase();
  if (dexLower === "uniswap_v2" || dexLower === "uniswapv2") return UNISWAP_V2_ROUTER;
  if (dexLower === "sushiswap_v2" || dexLower === "sushiswapv2" || dexLower === "sushiswap") return SUSHISWAP_V2_ROUTER;
  return null;
}

/**
 * Determine DEX type from string identifier
 */
function getDexType(dex) {
  const dexLower = dex.toLowerCase();
  if (dexLower === "uniswap_v2" || dexLower === "uniswapv2") return DexType.UNISWAP_V2;
  if (dexLower === "uniswap_v3" || dexLower === "uniswapv3") return DexType.UNISWAP_V3;
  if (dexLower === "sushiswap_v2" || dexLower === "sushiswapv2" || dexLower === "sushiswap") return DexType.SUSHISWAP;
  if (dexLower === "balancer" || dexLower === "balancer_v2") return DexType.BALANCER;
  if (dexLower === "curve") return DexType.CURVE;
  throw new Error(`Unsupported DEX: ${dex}`);
}

/**
 * Build swap data for the new multi-DEX ArbitrageFlashloan contract
 * @param {Object} route - Route object with hops array
 * @param {Object} options - Configuration options
 * @param {Object} provider - Ethers provider
 * @returns {Object} ArbitrageData struct for smart contract
 */
async function buildArbitrageData(route, options = {}, provider) {
  if (!provider) throw new Error("No provider supplied");
  if (!route || !Array.isArray(route.hops) || route.hops.length === 0) {
    throw new Error("Route must include at least one hop");
  }

  const {
    borrowToken: borrowTokenOpt,
    borrowAmount,
    slippageBips = 50,
    minProfit,
  } = options;

  const actualBorrowToken = borrowTokenOpt || route.hops[0]?.tokenA || route.hops[0]?.tokenB;
  if (!actualBorrowToken) throw new Error("No borrowToken provided");
  if (borrowAmount === undefined || borrowAmount === null) throw new Error("No borrowAmount provided");
  if (minProfit === undefined || minProfit === null) throw new Error("No minProfit provided");

  // Convert to BigNumber
  const borrowAmtBN = toBigNumber(borrowAmount);
  const minProfitBN = toBigNumber(minProfit);

  const slippage = Number(slippageBips);
  if (!Number.isFinite(slippage) || slippage < 0) throw new Error("Invalid slippageBips provided");

  const steps = [];
  let currentAmtBN = borrowAmtBN;
  let currentToken = actualBorrowToken;
  const tokenSequence = [actualBorrowToken];

  for (let idx = 0; idx < route.hops.length; idx++) {
    const hop = route.hops[idx];
    const { dex, tokenA, tokenB, fee, poolId, poolAddress, curveIndexIn, curveIndexOut, useUnderlying } = hop;

    if (!dex || !tokenA || !tokenB) {
      throw new Error(`Invalid hop at index ${idx}`);
    }

    // Determine token direction
    const normalizedCurrent = currentToken.toLowerCase();
    let tokenIn, tokenOut;

    if (tokenA.toLowerCase() === normalizedCurrent) {
      tokenIn = tokenA;
      tokenOut = tokenB;
      currentToken = tokenB;
    } else if (tokenB.toLowerCase() === normalizedCurrent) {
      tokenIn = tokenB;
      tokenOut = tokenA;
      currentToken = tokenA;
    } else if (idx === 0) {
      tokenIn = tokenA;
      tokenOut = tokenB;
      currentToken = tokenB;
    } else {
      throw new Error(`Hop ${idx} does not connect from current token`);
    }

    const dexType = getDexType(dex);
    let outputAmt;
    let step;

    switch (dexType) {
      case DexType.UNISWAP_V2:
      case DexType.SUSHISWAP: {
        const routerAddr = getV2Router(dex);
        if (!routerAddr) throw new Error(`Router address not configured for ${dex}`);

        const router = new ethers.Contract(routerAddr, UNISWAP_ROUTER_ABI, provider);
        const amountsOut = await router.getAmountsOut(currentAmtBN, [tokenIn, tokenOut]);
        outputAmt = amountsOut[amountsOut.length - 1];

        step = {
          dexType,
          router: routerAddr,
          tokenIn,
          tokenOut,
          minAmountOut: applySlippage(outputAmt, slippage),
          v3Fee: 0,
          balancerPoolId: ethers.constants.HashZero,
          curveIndexIn: 0,
          curveIndexOut: 0,
          curveUnderlying: false,
          v2Path: [tokenIn, tokenOut],
        };
        break;
      }

      case DexType.UNISWAP_V3: {
        const v3Fee = fee || 3000; // Default to 0.3% fee tier
        outputAmt = await getV3Quote(provider, tokenIn, tokenOut, v3Fee, currentAmtBN);

        step = {
          dexType,
          router: UNISWAP_V3_ROUTER,
          tokenIn,
          tokenOut,
          minAmountOut: applySlippage(outputAmt, slippage),
          v3Fee,
          balancerPoolId: ethers.constants.HashZero,
          curveIndexIn: 0,
          curveIndexOut: 0,
          curveUnderlying: false,
          v2Path: [],
        };
        break;
      }

      case DexType.BALANCER: {
        outputAmt = await getBalancerQuote(tokenIn, tokenOut, currentAmtBN);

        step = {
          dexType,
          router: BALANCER_VAULT,
          tokenIn,
          tokenOut,
          minAmountOut: applySlippage(outputAmt, slippage),
          v3Fee: 0,
          balancerPoolId: poolId || ethers.constants.HashZero,
          curveIndexIn: 0,
          curveIndexOut: 0,
          curveUnderlying: false,
          v2Path: [],
        };
        break;
      }

      case DexType.CURVE: {
        if (!poolAddress) throw new Error(`Curve hop at index ${idx} missing poolAddress`);
        const iIn = curveIndexIn !== undefined ? curveIndexIn : 0;
        const iOut = curveIndexOut !== undefined ? curveIndexOut : 1;

        outputAmt = await getCurveQuote(provider, poolAddress, iIn, iOut, currentAmtBN, {
          useUnderlying: useUnderlying || false,
        });

        step = {
          dexType,
          router: poolAddress,
          tokenIn,
          tokenOut,
          minAmountOut: applySlippage(outputAmt, slippage),
          v3Fee: 0,
          balancerPoolId: ethers.constants.HashZero,
          curveIndexIn: iIn,
          curveIndexOut: iOut,
          curveUnderlying: useUnderlying || false,
          v2Path: [],
        };
        break;
      }

      default:
        throw new Error(`Unsupported DEX type: ${dexType}`);
    }

    steps.push(step);
    tokenSequence.push(currentToken);
    currentAmtBN = outputAmt;
  }

  // Validate route returns to borrow token
  if (tokenSequence[tokenSequence.length - 1].toLowerCase() !== actualBorrowToken.toLowerCase()) {
    throw new Error("Route does not return to borrow token");
  }

  const routeString = route.route || tokenSequence.map(t => getTokenSymbol(t)).join("→");

  return {
    borrowToken: actualBorrowToken,
    borrowAmount: borrowAmtBN,
    steps,
    minProfit: minProfitBN,
    route: routeString,
  };
}

/**
 * Build legacy SwapData format for backward compatibility
 * Only supports V2 routers (Uniswap V2, SushiSwap)
 */
async function buildSwapDataFromDynamic(route, options = {}, provider) {
  if (!provider) throw new Error("No provider supplied");
  if (!route || !Array.isArray(route.hops) || route.hops.length === 0) {
    throw new Error("Route must include at least one hop");
  }

  const {
    borrowToken: borrowTokenOpt,
    borrowAmount,
    slippageBips = 50,
    minProfit,
  } = options;

  const actualBorrowToken = borrowTokenOpt || route.hops[0]?.tokenA || route.hops[0]?.tokenB;
  if (!actualBorrowToken) throw new Error("No borrowToken provided");
  if (borrowAmount === undefined || borrowAmount === null) throw new Error("No borrowAmount provided");
  if (minProfit === undefined || minProfit === null) throw new Error("No minProfit provided");

  const borrowAmtBN = toBigNumber(borrowAmount);
  const minProfitBN = toBigNumber(minProfit);

  const slippage = Number(slippageBips);
  if (!Number.isFinite(slippage) || slippage < 0) throw new Error("Invalid slippageBips provided");

  const paths = [];
  const minOuts = [];

  let currentAmtBN = borrowAmtBN;
  let currentToken = actualBorrowToken;
  const tokenSequence = [actualBorrowToken];

  for (let idx = 0; idx < route.hops.length; idx++) {
    const hop = route.hops[idx];
    const { dex, tokenA, tokenB } = hop;
    if (!dex || !tokenA || !tokenB) throw new Error(`Invalid hop at index ${idx}`);

    const routerAddr = getV2Router(dex);
    if (!routerAddr) {
      throw new Error(`Router address not configured for ${dex}`);
    }

    const normalizedCurrent = currentToken.toLowerCase();
    let tokenIn, tokenOut;

    if (tokenA.toLowerCase() === normalizedCurrent) {
      tokenIn = tokenA;
      tokenOut = tokenB;
      currentToken = tokenB;
    } else if (tokenB.toLowerCase() === normalizedCurrent) {
      tokenIn = tokenB;
      tokenOut = tokenA;
      currentToken = tokenA;
    } else if (idx === 0) {
      tokenIn = tokenA;
      tokenOut = tokenB;
      currentToken = tokenB;
    } else {
      throw new Error(`Hop ${idx} does not connect from current token`);
    }

    const router = new ethers.Contract(routerAddr, UNISWAP_ROUTER_ABI, provider);
    const amountsOut = await router.getAmountsOut(currentAmtBN, [tokenIn, tokenOut]);
    const outputAmt = amountsOut[amountsOut.length - 1];

    const minOut = applySlippage(outputAmt, slippage);

    paths.push([routerAddr, tokenIn, tokenOut]);
    minOuts.push(minOut);
    tokenSequence.push(currentToken);

    currentAmtBN = outputAmt;
  }

  if (tokenSequence[tokenSequence.length - 1].toLowerCase() !== actualBorrowToken.toLowerCase()) {
    throw new Error("Route does not return to borrow token");
  }

  const routeString = route.route || tokenSequence.join("→");

  return {
    token: actualBorrowToken,
    paths,
    minOuts,
    minProfit: minProfitBN,
    route: routeString,
  };
}

/**
 * Encode legacy SwapData for contract call
 */
function encodeSwapData(data) {
  const tupleType = "tuple(address token,address[][] paths,uint256[] minOuts,uint256 minProfit,string route)";
  return ethers.utils.defaultAbiCoder.encode([tupleType], [data]);
}

/**
 * Encode new ArbitrageData for contract call
 */
function encodeArbitrageData(data) {
  const stepType = "tuple(uint8 dexType,address router,address tokenIn,address tokenOut,uint256 minAmountOut,uint24 v3Fee,bytes32 balancerPoolId,int128 curveIndexIn,int128 curveIndexOut,bool curveUnderlying,address[] v2Path)";
  const dataType = `tuple(address borrowToken,uint256 borrowAmount,${stepType}[] steps,uint256 minProfit,string route)`;
  return ethers.utils.defaultAbiCoder.encode([dataType], [data]);
}

// Helper functions

function toBigNumber(value) {
  if (ethers.BigNumber.isBigNumber(value)) {
    return value;
  }
  if (typeof value === "string" && value.includes(".")) {
    return ethers.utils.parseUnits(value, 18);
  }
  return ethers.BigNumber.from(value.toString());
}

function applySlippage(amount, slippageBips) {
  return amount.mul(ethers.BigNumber.from(10000 - slippageBips)).div(ethers.BigNumber.from(10000));
}

// Token symbol lookup (can be expanded)
const TOKEN_SYMBOLS = {
  "0x6b175474e89094c44da98b954eedeac495271d0f": "DAI",
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
  "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
};

function getTokenSymbol(address) {
  return TOKEN_SYMBOLS[address.toLowerCase()] || address.slice(0, 8);
}

module.exports = {
  buildSwapDataFromDynamic,
  buildArbitrageData,
  encodeSwapData,
  encodeArbitrageData,
  getDexType,
  DexType,
};
