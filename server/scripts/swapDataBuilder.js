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

async function buildSwapDataFromDynamic(
  routeDef,
  borrowToken,
  borrowAmount,
  slippageBips,
  provider
) {
  const actualBorrowToken = borrowToken || routeDef.steps[0]?.path[0];
  if (!actualBorrowToken) throw new Error("No borrowToken provided");
  if (borrowAmount === undefined || borrowAmount === null)
    throw new Error("No borrowAmount provided");

  let borrowAmtBN;
  if (typeof borrowAmount === "string" && borrowAmount.includes(".")) {
    borrowAmtBN = ethers.utils.parseUnits(borrowAmount, 18);
  } else {
    borrowAmtBN = ethers.BigNumber.from(borrowAmount.toString());
  }

  const routers = [];
  const pathIns = [];
  const pathOuts = [];
  const minAmountsOut = [];

  let currentAmtBN = borrowAmtBN;

  for (let idx = 0; idx < routeDef.steps.length; idx++) {
    const { dex, path } = routeDef.steps[idx];

    const routerAddr = getV2Router(dex);
    const tokenIn = path[0];
    const tokenOut = path[path.length - 1];

    const router = new ethers.Contract(
      routerAddr,
      UNISWAP_ROUTER_ABI,
      provider
    );
    const amountsOut = await router.getAmountsOut(currentAmtBN, path);
    const outputAmt = amountsOut[amountsOut.length - 1];

    const minOut = outputAmt
      .mul(ethers.BigNumber.from(10000 - slippageBips))
      .div(ethers.BigNumber.from(10000));

    routers.push(routerAddr);
    pathIns.push(tokenIn);
    pathOuts.push(tokenOut);
    minAmountsOut.push(minOut);

    currentAmtBN = outputAmt;
  }

  return { routers, pathIns, pathOuts, minAmountsOut };
}

function encodeSwapData({ routers, pathIns, pathOuts, minAmountsOut }) {
  const tupleType =
    "tuple(address[] routers, address[] pathIns, address[] pathOuts, uint256[] minAmountsOut)";
  return ethers.utils.defaultAbiCoder.encode(
    [tupleType],
    [{ routers, pathIns, pathOuts, minAmountsOut }]
  );
}

module.exports = {
  buildSwapDataFromDynamic,
  encodeSwapData,
};
