// server/scripts/swapDataBuilder.js

/**
 * Given a route definition with heterogeneous DEX hops (UniswapV2, SushiSwap, UniswapV3, BalancerV2, CurveV2),
 * compute slippage-protected minOuts for each hop and assemble the arrays needed for the Solidity contract.
 *
 * The routeDef.steps array must be of length 3, each step having:
 *   {
 *     dex:       string,            // one of "uniswap_v2", "sushiswap_v2", "uniswap_v3", "balancer_v2", "curve_v2"
 *     path:      [string, string],  // [tokenIn, tokenOut] addresses for V2, V3; for Balancer/Curve, these are the two tokens in that hop
 *     fee?:      number,            // only for uniswap_v3 (e.g. 3000)
 *     poolAddress?: string,         // only for balancer_v2 or curve_v2
 *     curveIndices?: { i: number, j: number } // only for curve_v2: indices of tokenIn and tokenOut in pool's token array
 *   }
 *
 * The returned object contains:
 *   { token,                     // borrowToken
 *     paths: [ [routerAddr, tokenIn, tokenOut], ... ],  // three arrays of length 3 each, identifying router & tokens
 *     minOuts: [BigNumber,BigNumber,BigNumber],         // slippage-adjusted outputs
 *     minProfit: BigNumber,      // passed-through from opts.minProfit
 *     route: string              // human-readable route string
 *   }
 */

const { ethers } = require("ethers");
require("dotenv").config({ override: true });

const { getV3Quote } = require("../scripts/v3Utils");
const { getBalancerQuote } = require("../scripts/balancerUtils");
const { getCurveQuote } = require("../scripts/curveUtils");

// Routers (V2) from environment
// The README refers to UNISWAP_ROUTER_ADDRESS and SUSHISWAP_ROUTER_ADDRESS.
// Older revisions of this file expected UNISWAP_V2_ROUTER / SUSHISWAP_V2_ROUTER
// which caused undefined addresses when only the new variables were provided.
const UNISWAP_V2_ROUTER =
  process.env.UNISWAP_ROUTER_ADDRESS || process.env.UNISWAP_V2_ROUTER;
const SUSHISWAP_V2_ROUTER =
  process.env.SUSHISWAP_ROUTER_ADDRESS || process.env.SUSHISWAP_V2_ROUTER;
const provider = new ethers.providers.JsonRpcProvider(
  process.env.MAINNET_RPC_URL
);

const TOKEN_SYMBOL_BY_ADDRESS = {
  [process.env.DAI_ADDRESS]: "DAI",
  [process.env.WETH_ADDRESS]: "WETH",
  [process.env.USDC_ADDRESS]: "USDC",
  [process.env.USDT_ADDRESS]: "USDT",
  // Add other token mappings if needed
};

async function buildSwapDataFromDynamic(
  routeDef,
  {
    slippageBips = parseInt(process.env.DEFAULT_SLIPPAGE_BIPS || "50", 10),
    minProfit = process.env.MIN_PROFIT_DAI || "1",
    borrowToken,
    borrowAmount,
  } = {}
) {
  // Allow callers to pass just the hops array
  if (Array.isArray(routeDef)) {
    const hops = routeDef;
    routeDef = {
      steps: hops.map((h) => ({
        dex: h.dex,
        path: [h.tokenA, h.tokenB],
        fee: h.fee || null,
        poolAddress: h.poolAddress,
        curveIndices: h.curveIndices || null,
      })),
      routeTokens: [hops[0].tokenA, ...hops.map((h) => h.tokenB)],
    };
  }

  if (!Array.isArray(routeDef.steps) || routeDef.steps.length !== 3) {
    throw new Error("Expected exactly 3 hops in routeDef.steps");
  }

  // Helper: choose router address for V2 sw ap
  function getV2RouterAddr(dex) {
    if (dex === "uniswap_v2") return UNISWAP_V2_ROUTER;
    if (dex === "sushiswap_v2") return SUSHISWAP_V2_ROUTER;
    throw new Error(`Unsupported V2 dex: ${dex}`);
  }

  // Determine borrow token and amount with sane fallbacks
  const actualBorrowToken = borrowToken || routeDef.steps[0]?.path[0];
  if (!actualBorrowToken) {
    throw new Error("No borrowToken provided");
  }

  if (borrowAmount === undefined || borrowAmount === null) {
    throw new Error("No borrowAmount provided");
  }

  let borrowAmtBN;
  if (typeof borrowAmount === "string" && borrowAmount.includes(".")) {
    borrowAmtBN = ethers.utils.parseUnits(borrowAmount, 18);
  } else {
    borrowAmtBN = ethers.BigNumber.from(borrowAmount.toString());
  }

  // Prepare arrays to collect data for each hop
  const paths = [];
  const minOuts = [];

  // Track the output of each hop so it becomes the input to the next
  let currentAmtBN = borrowAmtBN;

  // We will feed into contract three arrays of [routerAddr, tokenIn, tokenOut]
  for (let idx = 0; idx < 3; idx++) {
    const hop = routeDef.steps[idx];
    const tokenIn =
      idx === 0 ? actualBorrowToken : routeDef.steps[idx - 1].path[1];
    const tokenOut = hop.path[1];
    let routerAddr;
    let rawOutBN;

    switch (hop.dex) {
      case "uniswap_v2":
      case "sushiswap_v2":
        routerAddr = getV2RouterAddr(hop.dex);
        {
          // On-chain getAmountsOut for V2
          const routerContract = new ethers.Contract(
            routerAddr,
            [
              "function getAmountsOut(uint256,address[]) view returns (uint256[])",
            ],
            provider
          );
          const amtIn = currentAmtBN;
          const amounts = await routerContract.getAmountsOut(amtIn, [
            tokenIn,
            tokenOut,
          ]);
          rawOutBN = amounts[amounts.length - 1];
        }
        break;

      case "uniswap_v3":
        routerAddr = UNISWAP_V2_ROUTER; // The contract may use a V3-compatible adapter; off-chain we just compute quote
        {
          const amtIn = currentAmtBN;
          rawOutBN = ethers.BigNumber.from(
            await getV3Quote(provider, tokenIn, tokenOut, hop.fee, amtIn)
          );
        }
        break;

      case "balancer_v2":
        routerAddr = hop.poolAddress; // The contract must know to route through Balancer Vault; we pass poolAddress as "router"
        {
          const amtIn = currentAmtBN;
          rawOutBN = await getBalancerQuote(provider, tokenIn, tokenOut, amtIn);
        }
        break;

      case "curve_v2":
        routerAddr = hop.poolAddress; // pass Curve pool address as "router"
        {
          const amtIn = currentAmtBN;
          rawOutBN = await getCurveQuote(
            provider,
            hop.poolAddress,
            hop.curveIndices.i,
            hop.curveIndices.j,
            amtIn
          );
        }
        break;

      default:
        throw new Error(`Unknown DEX in buildSwapData: ${hop.dex}`);
    }

    // Adjust for slippage
    const slippageAdjusted = rawOutBN.mul(10000 - slippageBips).div(10000);

    // Store
    paths.push([routerAddr, tokenIn, tokenOut]);
    minOuts.push(slippageAdjusted);

    // Prepare amount for next hop
    currentAmtBN = slippageAdjusted;
  }

  // Human-readable route string
  const routeString = routeDef.routeTokens
    .map((addr) => TOKEN_SYMBOL_BY_ADDRESS[addr] || addr.slice(0, 6))
    .join("→");

  return {
    token: actualBorrowToken,
    paths, // [ [router1, tokenIn, tokenMid], [router2, mid1, mid2], [router3, mid2, actualBorrowToken] ]
    minOuts, // [minOutHop1, minOutHop2, minOutHop3]
    minProfit: ethers.BigNumber.from(minProfit),
    route: routeString,
  };
}

module.exports = { buildSwapDataFromDynamic };
