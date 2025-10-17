const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { ParamType } = require("@ethersproject/abi");

process.env.UNISWAP_ROUTER_ADDRESS =
  process.env.UNISWAP_ROUTER_ADDRESS || "0x1111111111111111111111111111111111111111";
process.env.SUSHISWAP_ROUTER_ADDRESS =
  process.env.SUSHISWAP_ROUTER_ADDRESS || "0x2222222222222222222222222222222222222222";

const routerInterface = new ethers.utils.Interface(
  require("../../server/abis/uniswapRouter.json")
);

const { buildSwapDataFromDynamic } = require("../../server/scripts/swapDataBuilder");

test("buildSwapDataFromDynamic returns encodable SwapData", async (t) => {
  const originalParamFrom = ParamType.from;
  ParamType.from = (value) => {
    if (value === "SwapData") {
      return originalParamFrom({
        name: "SwapData",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "paths", type: "address[][]" },
          { name: "minOuts", type: "uint256[]" },
          { name: "minProfit", type: "uint256" },
          { name: "route", type: "string" },
        ],
      });
    }
    return originalParamFrom(value);
  };

  t.after(() => {
    ParamType.from = originalParamFrom;
  });

  const borrowToken = ethers.Wallet.createRandom().address;
  const midToken = ethers.Wallet.createRandom().address;

  const bestRoute = {
    hops: [
      { dex: "uniswap_v2", tokenA: borrowToken, tokenB: midToken },
      { dex: "sushiswap_v2", tokenA: midToken, tokenB: borrowToken },
    ],
  };

  const borrowAmount = ethers.utils.parseUnits("100", 18);
  const minProfit = ethers.utils.parseUnits("1", 18);

  const providerStub = {
    _isProvider: true,
    async resolveName(value) {
      return value;
    },
    async call({ data }) {
      const [amountIn] = routerInterface.decodeFunctionData("getAmountsOut", data);
      const amounts = [amountIn, amountIn];
      return routerInterface.encodeFunctionResult("getAmountsOut", [amounts]);
    },
  };

  const swapData = await buildSwapDataFromDynamic(
    bestRoute,
    {
      borrowToken,
      borrowAmount,
      slippageBips: 50,
      minProfit,
    },
    providerStub
  );

  assert.equal(swapData.token, borrowToken);
  assert.equal(swapData.paths.length, 2);
  assert.equal(swapData.minOuts.length, 2);
  assert.equal(typeof swapData.route, "string");

  assert.doesNotThrow(() => {
    const encoded = ethers.utils.defaultAbiCoder.encode(["SwapData"], [swapData]);
    assert.equal(typeof encoded, "string");
  });
});
