const { bn } = require("../bot/units");

function normalizeMode(mode) {
  return String(mode || "").trim().toUpperCase();
}

class FundingEngine {
  constructor({ preferTreasury = true } = {}) {
    this.preferTreasury = preferTreasury;
  }

  choose({
    borrowAmount,
    expectedFinalAmount,
    treasuryBalance = 0,
    flashLiquidity = 0,
    flashPremiumBps = 0,
    gasCostBorrowToken = 0,
    builderPaymentBorrowToken = 0,
    gasCostByMode = {},
    builderPaymentByMode = {},
    minimumRequiredProfit = 0,
    allowedModes = ["TREASURY", "AAVE_FLASH_LOAN"],
  }) {
    const amount = bn(borrowAmount);
    const finalAmount = bn(expectedFinalAmount);
    const treasury = bn(treasuryBalance);
    const liquidity = bn(flashLiquidity);
    const costFor = (mode, map, fallback) => bn(map?.[mode] ?? fallback);
    const gas = mode => costFor(mode, gasCostByMode, gasCostBorrowToken);
    const builder = mode => costFor(mode, builderPaymentByMode, builderPaymentBorrowToken);
    const threshold = bn(minimumRequiredProfit);
    const allowed = new Set(allowedModes.map(normalizeMode));
    const options = [];

    if (allowed.has("TREASURY") && treasury.gte(amount)) {
      const financingFee = bn(0);
      const grossProfit = finalAmount.sub(amount);
      const gasCost = gas("TREASURY");
      const builderPayment = builder("TREASURY");
      const expectedNetProfit = grossProfit.sub(gasCost).sub(builderPayment);
      options.push({
        mode: "TREASURY",
        financingFee,
        grossProfit,
        expectedNetProfit,
        gasCostBorrowToken: gasCost,
        builderPaymentBorrowToken: builderPayment,
        profitable: expectedNetProfit.gt(0) && expectedNetProfit.gte(threshold),
        availableLiquidity: treasury,
      });
    }

    if (allowed.has("AAVE_FLASH_LOAN") && liquidity.gte(amount)) {
      const financingFee = amount.mul(Number(flashPremiumBps)).add(5000).div(10000);
      const grossProfit = finalAmount.sub(amount).sub(financingFee);
      const gasCost = gas("AAVE_FLASH_LOAN");
      const builderPayment = builder("AAVE_FLASH_LOAN");
      const expectedNetProfit = grossProfit.sub(gasCost).sub(builderPayment);
      options.push({
        mode: "AAVE_FLASH_LOAN",
        financingFee,
        grossProfit,
        expectedNetProfit,
        gasCostBorrowToken: gasCost,
        builderPaymentBorrowToken: builderPayment,
        profitable: expectedNetProfit.gt(0) && expectedNetProfit.gte(threshold),
        availableLiquidity: liquidity,
      });
    }

    if (!options.length) {
      return {
        mode: null,
        profitable: false,
        reason: "no_funding_capacity",
        options: [],
      };
    }

    options.sort((a, b) => {
      if (a.profitable !== b.profitable) return a.profitable ? -1 : 1;
      if (!a.expectedNetProfit.eq(b.expectedNetProfit)) {
        return a.expectedNetProfit.gt(b.expectedNetProfit) ? -1 : 1;
      }
      if (this.preferTreasury && a.mode !== b.mode) {
        return a.mode === "TREASURY" ? -1 : 1;
      }
      return 0;
    });

    return { ...options[0], options };
  }
}

module.exports = { FundingEngine };