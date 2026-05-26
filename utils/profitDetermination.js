// utils/profitDetermination.js
//
// End-to-end profit calculator used by the bot & front-end.
// • Live ETH/DAI fetch on boot (falls back to USD if DAI fails – since 1 DAI ≈ 1 USD).
// • Front-end overrides merged via getSimulationConfig().
// • determineProfit() computes gas cost, flash-loan premium & net PnL using either CLI or on-chain simulation.
// • simulateSwapPaths() uses on-chain getAmountsOut() for each hop—recommended for bot accuracy.
// • CLI helper (node utils/profitDetermination.js) for quick testing.

const { ethers } = require("ethers");

let fetchEthDaiPrice = async () => 2000;
try {
  ({ fetchEthDaiPrice } = require("../server/scripts/priceUtils"));
} catch (err) {
  console.warn(
    "⚠  priceUtils unavailable; using static ETH/DAI fallback in simulations"
  );
}

/* ────────────────────────────────────────────────
   Default simulation config (overrides merge later)
   ────────────────────────────────────────────────*/
const defaultSimulationConfig = {
  ethToDaiRate: 2000, // fallback rate in case fetch fails
  slippageTolerance: 0.005, // 0.5 %
  gasPriceLimit: ethers.utils.parseUnits("50", "gwei"),
  tradeSize: 1_000_000, // DAI
  flashloanPremiumBips: 9, // 0.09 %
  conversionBoost: 1.0, // neutral; must stay 1.0 in production (no fabricated profit)
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
function estimateGasCostWei(gasUsed, gasPrice) {
  if (ethers.BigNumber.isBigNumber(gasUsed)) {
    return gasUsed.mul(gasPrice);
  }
  return ethers.BigNumber.from(gasUsed).mul(gasPrice);
}

function normalizeRateToWei(rate) {
  if (!rate && rate !== 0) return null;
  if (ethers.BigNumber.isBigNumber(rate)) return rate;
  if (typeof rate === "string") {
    if (rate.trim() === "") return null;
    if (rate.includes(".")) {
      return ethers.utils.parseUnits(rate, 18);
    }
    return ethers.BigNumber.from(rate);
  }
  if (typeof rate === "number") {
    return ethers.utils.parseUnits(rate.toString(), 18);
  }
  return null;
}

/* ────────────────────────────────────────────────
   On-chain route simulator: uses getAmountsOut()
   for each hop, exactly as the contract will
   ────────────────────────────────────────────────*/
async function simulateSwapPaths(provider, swapData, borrowAmt) {
  if (!swapData || !Array.isArray(swapData.paths)) {
    throw new Error("simulateSwapPaths: swapData.paths missing or invalid");
  }
  if (!Array.isArray(swapData.minOuts)) {
    throw new Error("simulateSwapPaths: swapData.minOuts missing or invalid");
  }

  let currentAmt = borrowAmt;
  for (let i = 0; i < swapData.paths.length; i++) {
    const path = swapData.paths[i];
    if (!Array.isArray(path) || path.length < 3) {
      throw new Error(`simulateSwapPaths: invalid path at index ${i}`);
    }
    const [router, ...tokenPath] = path;
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
    const minOutRaw = swapData.minOuts[i];
    const minOut = ethers.BigNumber.isBigNumber(minOutRaw)
      ? minOutRaw
      : ethers.BigNumber.from(minOutRaw);
    if (outAmt.lt(minOut)) {
      return {
        success: false,
        reason: "slippage",
        amountOut: outAmt,
      };
    }
    currentAmt = outAmt;
  }

  return {
    success: true,
    amountOut: currentAmt,
    hops: swapData.paths.length,
  };
}

/* ────────────────────────────────────────────────
   Route simulator (array of steps with .simulate fn)
   ────────────────────────────────────────────────*/
function ensureNumeric(value, label) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    throw new Error(`${label} must be a finite number`);
  }
  return normalized;
}

function simulateRoute(route, input) {
  /* Defensive guards — never assume `.steps` is present or valid */
  if (!route || !Array.isArray(route.steps) || route.steps.length === 0) {
    throw new Error("simulateRoute: route.steps missing or empty");
  }

  let out = ensureNumeric(input, "simulateRoute input");
  for (const [idx, step] of route.steps.entries()) {
    if (!step || typeof step.simulate !== "function") {
      throw new Error(
        `simulateRoute: steps[${idx}] lacks a callable .simulate()`
      );
    }
    out = ensureNumeric(
      step.simulate(out),
      `simulateRoute steps[${idx}] output`
    );
  }
  return out;
}

/* ────────────────────────────────────────────────
   determineProfit()
   ────────────────────────────────────────────────*/
async function determineProfit(options) {
  if (!options || typeof options !== "object") {
    throw new Error("determineProfit expects an options object");
  }

  const {
    provider,
    route,
    swapData,
    inputAmount,
    gasEstimate,
    gasUsed,
    gasPriceOverride,
    flashloanPremiumBips,
    flashloanPremiumWei,
    simConfig,
    inputAmountHuman,
    ethToDaiRate,
    midMarketRate,
    borrowTokenDecimals = 18,
  } = options;

  if (!provider || typeof provider.getGasPrice !== "function") {
    throw new Error("determineProfit requires a provider with getGasPrice()");
  }

  const normalizedInput = ethers.BigNumber.from(inputAmount);
  const cfg = simConfig || getSimulationConfig();

  const gasPrice = gasPriceOverride
    ? ethers.BigNumber.from(gasPriceOverride)
    : await getLiveGasPrice(provider);

  if (cfg.gasPriceLimit && gasPrice.gt(cfg.gasPriceLimit)) {
    return { aborted: true, reason: "gasPrice>limit" };
  }

  const gasUnits =
    gasEstimate !== undefined && gasEstimate !== null
      ? gasEstimate
      : gasUsed !== undefined
      ? gasUsed
      : cfg.estimatedGasPerSwap;
  const gasUnitsBN = ethers.BigNumber.isBigNumber(gasUnits)
    ? gasUnits
    : ethers.BigNumber.from(gasUnits);

  const gasCostWei = estimateGasCostWei(gasUnitsBN, gasPrice);

  const rateWei =
    normalizeRateToWei(midMarketRate) ||
    normalizeRateToWei(ethToDaiRate) ||
    normalizeRateToWei(cfg.ethToDaiRate) ||
    ethers.utils.parseUnits("2000", 18);

  const gasCostDaiWei = gasCostWei
    .mul(rateWei)
    .div(ethers.constants.WeiPerEther);

  let simulatedOutWei;
  if (swapData) {
    const swapResult = await simulateSwapPaths(
      provider,
      swapData,
      normalizedInput
    );
    if (!swapResult.success) {
      return {
        aborted: true,
        reason: swapResult.reason || "swapSimulationFailed",
        simulatedOutput: 0,
        gasCostDAI: parseFloat(ethers.utils.formatUnits(gasCostDaiWei, 18)),
        gasCostETH: parseFloat(ethers.utils.formatEther(gasCostWei)),
        totalCostDAI: parseFloat(
          ethers.utils.formatUnits(normalizedInput.add(gasCostDaiWei), 18)
        ),
        profit: 0,
        premiumDAI: 0,
        details: {
          gasUsed: gasUnitsBN.toString(),
          gasPriceWei: gasPrice.toString(),
          premiumWei: "0",
          rateWei: rateWei.toString(),
          amountOutWei: swapResult.amountOut?.toString() || "0",
        },
      };
    }
    simulatedOutWei = swapResult.amountOut;
  } else if (route) {
    const numericInput =
      inputAmountHuman !== undefined
        ? ensureNumeric(inputAmountHuman, "determineProfit inputAmountHuman")
        : Number(
            ethers.utils.formatUnits(normalizedInput, borrowTokenDecimals)
          );
    const simulatedOutNumber = simulateRoute(route, numericInput);
    simulatedOutWei = ethers.utils.parseUnits(
      simulatedOutNumber.toFixed(18),
      borrowTokenDecimals
    );
  } else {
    throw new Error("determineProfit requires either route or swapData");
  }

  const premiumBips =
    flashloanPremiumBips !== undefined
      ? Number(flashloanPremiumBips)
      : cfg.flashloanPremiumBips;
  if (!Number.isFinite(premiumBips)) {
    throw new Error("flashloanPremiumBips must be numeric");
  }

  const premiumWei = flashloanPremiumWei
    ? ethers.BigNumber.from(flashloanPremiumWei)
    : normalizedInput
        .mul(10_000 + Math.trunc(premiumBips))
        .div(10_000)
        .sub(normalizedInput);

  const totalCostWei = normalizedInput.add(gasCostDaiWei).add(premiumWei);

  let profitWei;
  let profitSign = 1;
  if (simulatedOutWei.gte(totalCostWei)) {
    profitWei = simulatedOutWei.sub(totalCostWei);
  } else {
    profitWei = totalCostWei.sub(simulatedOutWei);
    profitSign = -1;
  }

  const premiumDaiFloat = parseFloat(
    ethers.utils.formatUnits(premiumWei, borrowTokenDecimals)
  );

  return {
    simulatedOutput: parseFloat(
      ethers.utils.formatUnits(simulatedOutWei, borrowTokenDecimals)
    ),
    gasCostDAI: parseFloat(ethers.utils.formatUnits(gasCostDaiWei, 18)),
    gasCostETH: parseFloat(ethers.utils.formatEther(gasCostWei)),
    totalCostDAI: parseFloat(ethers.utils.formatUnits(totalCostWei, 18)),
    premiumDAI: premiumDaiFloat,
    profit:
      profitSign *
      parseFloat(ethers.utils.formatUnits(profitWei, borrowTokenDecimals)),
    aborted: false,
    details: {
      gasUsed: gasUnitsBN.toString(),
      gasPriceWei: gasPrice.toString(),
      premiumWei: premiumWei.toString(),
      rateWei: rateWei.toString(),
      amountOutWei: simulatedOutWei.toString(),
    },
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
  const tradeSizeWei = ethers.utils.parseUnits(cfg.tradeSize.toString(), 18);

  const res = await determineProfit({
    provider,
    route,
    inputAmount: tradeSizeWei,
    gasEstimate: gasUsed,
    flashloanPremiumBips: cfg.flashloanPremiumBips,
    simConfig: cfg,
    inputAmountHuman: cfg.tradeSize,
    ethToDaiRate: cfg.ethToDaiRate,
  });
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
  normalizeRateToWei,
};
