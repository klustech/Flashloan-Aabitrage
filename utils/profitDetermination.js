// utils/profitDetermination.js
//
// End-to-end profit calculator used by the bot & front-end.
// • Live ETH/DAI fetch on boot (falls back to USD if DAI fails – since 1 DAI ≈ 1 USD).
// • Front-end overrides merged via getSimulationConfig().
// • determineProfit() computes gas cost, flash-loan premium & net PnL using either CLI or on-chain simulation.
// • simulateSwapPaths() uses on-chain getAmountsOut() for each hop—recommended for bot accuracy.
// • CLI helper (node utils/profitDetermination.js) for quick testing.

const { ethers } = require("ethers");
const { fetchEthDaiPrice } = require("../server/scripts/priceUtils");

/* ────────────────────────────────────────────────
   Default simulation config (overrides merge later)
   ────────────────────────────────────────────────*/
const defaultSimulationConfig = {
  ethToDaiRate: 2000, // fallback rate in case fetch fails
  slippageTolerance: 0.005, // 0.5 %
  gasPriceLimit: ethers.utils.parseUnits("50", "gwei"),
  tradeSize: 1_000_000, // DAI
  flashloanPremiumBips: 9, // 0.09 %
  conversionBoost: 1.07, // favourable 7 %
  estimatedGasPerSwap: 200000, // approximate gas units per swap hop
};

/* ────────────────────────────────────────────────
   Live ETH→DAI rate (Coingecko)
   ────────────────────────────────────────────────*/
(async () => {
  try {
    const rate = await fetchEthDaiPrice();
    defaultSimulationConfig.ethToDaiRate = rate;
    console.log(`✔  Loaded ETH/DAI = ${rate}`);
  } catch (err) {
    console.warn(
      "⚠  Could not fetch ETH/DAI; using fallback 2000:",
      err.message
    );
  }
})();

/* ────────────────────────────────────────────────
   Config merger – called by API & bot
   ────────────────────────────────────────────────*/
function getSimulationConfig(overrides = {}) {
  return {
    ethToDaiRate:
      overrides.ethToDaiRate ?? defaultSimulationConfig.ethToDaiRate,
    slippageTolerance: overrides.slippageBips
      ? overrides.slippageBips / 10_000
      : defaultSimulationConfig.slippageTolerance,
    gasPriceLimit: overrides.gasPriceCeiling
      ? ethers.utils.parseUnits(overrides.gasPriceCeiling.toString(), "gwei")
      : defaultSimulationConfig.gasPriceLimit,
    tradeSize:
      overrides.simulationInputAmount ?? defaultSimulationConfig.tradeSize,
    flashloanPremiumBips:
      overrides.flashloanPremiumBips ??
      defaultSimulationConfig.flashloanPremiumBips,
    conversionBoost:
      overrides.conversionBoost ?? defaultSimulationConfig.conversionBoost,
    estimatedGasPerSwap: defaultSimulationConfig.estimatedGasPerSwap,
  };
}

/* ────────────────────────────────────────────────
   Helper: live gas-price fetch (falls back if needed)
   ────────────────────────────────────────────────*/
async function getLiveGasPrice(provider) {
  try {
    return await provider.getGasPrice();
  } catch (err) {
    console.warn("Gas-price fetch failed – defaulting to 50 gwei");
    return ethers.utils.parseUnits("50", "gwei");
  }
}

/* ────────────────────────────────────────────────
   Helper: convert gas*price → ETH, then ETH→DAI
   ────────────────────────────────────────────────*/
function estimateGasCostETH(gasUsed, gasPrice) {
  return parseFloat(ethers.utils.formatEther(gasUsed.mul(gasPrice)));
}
function convertEthToDai(eth, rate) {
  return eth * rate;
}

/* ────────────────────────────────────────────────
   Helper: apply flash-loan premium (in bips)
   ────────────────────────────────────────────────*/
function applyPremium(amountBN, bipsInt) {
  // amountBN and the return value are BigNumbers (wei)
  // bipsInt is an integer, e.g. 9  (= 0.09 %)
  return amountBN.mul(10_000 + bipsInt).div(10_000);
}

/* ────────────────────────────────────────────────
   On-chain route simulator: uses getAmountsOut()
   for each hop, exactly as the contract will
   ────────────────────────────────────────────────*/
async function simulateSwapPaths(provider, swapData, borrowAmt) {
  let currentAmt = borrowAmt;
  for (let i = 0; i < swapData.paths.length; i++) {
    const [router, ...tokenPath] = swapData.paths[i];
    const routerContract = new ethers.Contract(
      router,
      ["function getAmountsOut(uint256, address[]) view returns (uint256[])"],
      provider
    );
    const amountsOut = await routerContract.getAmountsOut(
      currentAmt,
      tokenPath
    );
    const outAmt = amountsOut[amountsOut.length - 1];
    if (outAmt.lt(swapData.minOuts[i])) {
      // If slippage fails, no arb
      return {
        profit: ethers.constants.NegativeOne,
        gasCost: ethers.constants.Zero,
      };
    }
    currentAmt = outAmt;
  }

  const premium = borrowAmt
    .mul(parseInt(process.env.FLASHLOAN_PREMIUM_BIPS, 10))
    .div(10000);
  const required = borrowAmt.add(premium);
  const profit = currentAmt.sub(required);

  // Rough gas cost: (per-hop + final settlement) × estimatedGasPerSwap
  const gasCost = ethers.BigNumber.from(
    getSimulationConfig().estimatedGasPerSwap
  ).mul(swapData.paths.length + 1);

  return { profit, gasCost };
}

/* ────────────────────────────────────────────────
   Route simulator (array of steps with .simulate fn)
   ────────────────────────────────────────────────*/
function simulateRoute(route, input) {
  /* Defensive guards — never assume `.steps` is present or valid */
  if (!route || !Array.isArray(route.steps) || route.steps.length === 0) {
    throw new Error("simulateRoute: route.steps missing or empty");
  }

  let out = input;
  for (const [idx, step] of route.steps.entries()) {
    if (!step || typeof step.simulate !== "function") {
      throw new Error(
        `simulateRoute: steps[${idx}] lacks a callable .simulate()`
      );
    }
    out = step.simulate(out);
  }
  return out;
}

/* ────────────────────────────────────────────────
   determineProfit()
   ────────────────────────────────────────────────*/
async function determineProfit(
  provider,
  route,
  inputAmount,
  gasUsed,
  flashloanPremiumBips,
  simCfg
) {
  const gasPrice = await getLiveGasPrice(provider);
  if (gasPrice.gt(simCfg.gasPriceLimit)) {
    return { aborted: true, reason: "gasPrice>limit" };
  }

  const gasCostDAI = convertEthToDai(
    estimateGasCostETH(gasUsed, gasPrice),
    simCfg.ethToDaiRate
  );

  const simulatedOut = simulateRoute(route, inputAmount);
  const totalCostDAI = applyPremium(
    inputAmount + gasCostDAI,
    flashloanPremiumBips
  );
  const profit = simulatedOut - totalCostDAI;

  return {
    simulatedOutput: simulatedOut,
    gasCostDAI,
    totalCostDAI,
    profit,
    aborted: false,
  };
}

/* ────────────────────────────────────────────────
   CLI helper (node utils/profitDetermination.js)
   ────────────────────────────────────────────────*/
async function runProfitDetermination(overrides = {}) {
  const cfg = getSimulationConfig(overrides);
  const provider = new ethers.providers.InfuraProvider(
    "mainnet",
    process.env.INFURA_API_KEY || "demo"
  );

  const route = {
    name: "DAI→WETH→DAI (Uni)",
    steps: [
      {
        description: "DAI→WETH",
        simulate: (amt) =>
          (amt / cfg.ethToDaiRate) * (1 - cfg.slippageTolerance),
      },
      {
        description: "WETH→DAI",
        simulate: (amt) =>
          amt *
          cfg.ethToDaiRate *
          cfg.conversionBoost *
          (1 - cfg.slippageTolerance),
      },
    ],
  };

  const gasUsed = ethers.BigNumber.from("200000");
  const res = await determineProfit(
    provider,
    route,
    cfg.tradeSize,
    gasUsed,
    cfg.flashloanPremiumBips,
    cfg
  );
  console.table(res);
}

if (require.main === module) {
  runProfitDetermination().catch(console.error);
}

/* ────────────────────────────────────────────────
   Exports
   ────────────────────────────────────────────────*/
module.exports = {
  determineProfit,
  getSimulationConfig,
  runProfitDetermination,
  simulateSwapPaths,
  simulateRoute,
};
