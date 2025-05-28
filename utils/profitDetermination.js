// utils/profitDetermination.js
//
// End-to-end profit calculator used by the bot & front-end.
// • Live ETH/DAI fetch on boot (falls back to 2000).
// • Front-end overrides merged via getSimulationConfig().
// • determineProfit() computes gas cost, flash-loan premium & net PnL.

const { ethers } = require("ethers");
const axios = require("axios");

/* ────────────────────────────────────────────────
   Default simulation config (overrides merge later)
   ────────────────────────────────────────────────*/
const defaultSimulationConfig = {
  ethToDaiRate: null, // fetched on boot
  slippageTolerance: 0.005, // 0.5 %
  gasPriceLimit: ethers.utils.parseUnits("50", "gwei"),
  tradeSize: 1_000_000, // DAI
  flashloanPremiumBips: 9, // 0.09 %
  conversionBoost: 1.07, // favourable 7 %
};

/* ────────────────────────────────────────────────
   Live ETH→DAI rate (Coingecko)
   ────────────────────────────────────────────────*/
(async () => {
  try {
    const { data } = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      { params: { ids: "ethereum", vs_currencies: "dai" } }
    );
    defaultSimulationConfig.ethToDaiRate = data.ethereum.dai;
    console.log(`✔  Loaded ETH/DAI = ${data.ethereum.dai}`);
  } catch (err) {
    defaultSimulationConfig.ethToDaiRate = 2000;
    console.warn("⚠  Could not fetch ETH/DAI – using 2000");
  }
})();

/* ────────────────────────────────────────────────
   Config merger – called by API
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
  };
}

/* ────────────────────────────────────────────────
   Helper functions
   ────────────────────────────────────────────────*/
async function getLiveGasPrice(provider) {
  try {
    return await provider.getGasPrice();
  } catch (err) {
    console.warn("Gas-price fetch failed – defaulting to 50 gwei");
    return ethers.utils.parseUnits("50", "gwei");
  }
}

function estimateGasCostETH(gasUsed, gasPrice) {
  return parseFloat(ethers.utils.formatEther(gasUsed.mul(gasPrice)));
}
function convertEthToDai(eth, rate) {
  return eth * rate;
}
function applyPremium(amount, bips) {
  return amount * (1 + bips / 10_000);
}

/* ────────────────────────────────────────────────
   Route simulator (array of steps with .simulate fn)
   ────────────────────────────────────────────────*/
function simulateRoute(route, input) {
  let out = input;
  for (let i = 0; i < route.steps.length; i++) {
    out = route.steps[i].simulate(out);
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
};
