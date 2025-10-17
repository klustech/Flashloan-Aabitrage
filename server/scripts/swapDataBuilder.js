const { ethers } = require("ethers");
const UNISWAP_V2_ROUTER =
  process.env.UNISWAP_ROUTER_ADDRESS || process.env.UNISWAP_V2_ROUTER;
const SUSHISWAP_V2_ROUTER =
  process.env.SUSHISWAP_ROUTER_ADDRESS || process.env.SUSHISWAP_V2_ROUTER;
const UNISWAP_ROUTER_ABI = require("../abis/uniswapRouter.json");

function getV2Router(dex) {
  if (dex === "uniswap_v2") return UNISWAP_V2_ROUTER;
  if (dex === "sushiswap_v2") return SUSHISWAP_V2_ROUTER;
  throw new Error(`Unsupported V2 dex: ${dex}`);
}

async function buildSwapDataFromDynamic(route, options = {}, provider) {
  if (!provider) throw new Error("No provider supplied");
  if (!route || !Array.isArray(route.hops) || route.hops.length === 0)
    throw new Error("Route must include at least one hop");

  const {
    borrowToken: borrowTokenOpt,
    borrowAmount,
    slippageBips = 50,
    minProfit,
  } = options;

  const actualBorrowToken =
    borrowTokenOpt || route.hops[0]?.tokenA || route.hops[0]?.tokenB;
  if (!actualBorrowToken) throw new Error("No borrowToken provided");
  if (borrowAmount === undefined || borrowAmount === null)
    throw new Error("No borrowAmount provided");
  if (minProfit === undefined || minProfit === null)
    throw new Error("No minProfit provided");

  let borrowAmtBN;
  if (ethers.BigNumber.isBigNumber(borrowAmount)) {
    borrowAmtBN = borrowAmount;
  } else if (typeof borrowAmount === "string" && borrowAmount.includes(".")) {
    borrowAmtBN = ethers.utils.parseUnits(borrowAmount, 18);
  } else {
    borrowAmtBN = ethers.BigNumber.from(borrowAmount.toString());
  }

  let minProfitBN;
  if (ethers.BigNumber.isBigNumber(minProfit)) {
    minProfitBN = minProfit;
  } else if (typeof minProfit === "string" && minProfit.includes(".")) {
    minProfitBN = ethers.utils.parseUnits(minProfit, 18);
  } else {
    minProfitBN = ethers.BigNumber.from(minProfit.toString());
  }

  const slippage = Number(slippageBips);
  if (!Number.isFinite(slippage) || slippage < 0)
    throw new Error("Invalid slippageBips provided");

  const paths = [];
  const minOuts = [];

  let currentAmtBN = borrowAmtBN;
  let currentToken = actualBorrowToken;
  const tokenSequence = [actualBorrowToken];

  for (let idx = 0; idx < route.hops.length; idx++) {
    const hop = route.hops[idx];
    const { dex, tokenA, tokenB } = hop;
    if (!dex || !tokenA || !tokenB)
      throw new Error(`Invalid hop at index ${idx}`);

    const routerAddr = getV2Router(dex);
    if (!routerAddr) {
      throw new Error(`Router address not configured for ${dex}`);
    }

    const normalizedCurrent = currentToken.toLowerCase();
    let tokenIn;
    let tokenOut;
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

    const router = new ethers.Contract(
      routerAddr,
      UNISWAP_ROUTER_ABI,
      provider
    );
    const amountsOut = await router.getAmountsOut(currentAmtBN, [
      tokenIn,
      tokenOut,
    ]);
    const outputAmt = amountsOut[amountsOut.length - 1];

    const minOut = outputAmt
      .mul(ethers.BigNumber.from(10000 - slippage))
      .div(ethers.BigNumber.from(10000));

    paths.push([routerAddr, tokenIn, tokenOut]);
    minOuts.push(minOut);
    tokenSequence.push(currentToken);

    currentAmtBN = outputAmt;
  }

  if (
    tokenSequence[tokenSequence.length - 1].toLowerCase() !==
    actualBorrowToken.toLowerCase()
  ) {
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

function encodeSwapData(data) {
  const tupleType =
    "tuple(address token,address[][] paths,uint256[] minOuts,uint256 minProfit,string route)";
  return ethers.utils.defaultAbiCoder.encode([tupleType], [data]);
}

module.exports = {
  buildSwapDataFromDynamic,
  encodeSwapData,
};
