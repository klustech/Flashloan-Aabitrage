const { expect } = require("chai");
const { ethers } = require("ethers");

const {
  determineProfit,
  simulateRoute,
} = require("../../utils/profitDetermination");

describe("profitDetermination integrations", function () {
  const providerStub = {
    async getGasPrice() {
      return ethers.utils.parseUnits("30", "gwei");
    },
  };

  const baseSimConfig = {
    ethToDaiRate: 2000,
    slippageTolerance: 0,
    gasPriceLimit: ethers.utils.parseUnits("50", "gwei"),
    tradeSize: 0,
    flashloanPremiumBips: 9,
    conversionBoost: 1,
    estimatedGasPerSwap: 200000,
  };

  const cliStyleRoute = {
    name: "CLI demo",
    steps: [
      {
        description: "boost",
        simulate: (amount) => amount * 1.1,
      },
    ],
  };

  const apiStyleRoute = {
    name: "API demo",
    steps: [
      {
        description: "half hop",
        simulate: (amount) => amount * 0.5,
      },
      {
        description: "double back",
        simulate: (amount) => amount * 2.2,
      },
    ],
  };

  it("computes profit for CLI-style invocation", async function () {
    const borrowNumber = 1000;
    const borrowWei = ethers.utils.parseUnits(borrowNumber.toString(), 18);
    const gasUsed = ethers.BigNumber.from("21000");

    const result = await determineProfit({
      provider: providerStub,
      route: cliStyleRoute,
      inputAmount: borrowWei,
      gasEstimate: gasUsed,
      flashloanPremiumBips: baseSimConfig.flashloanPremiumBips,
      simConfig: baseSimConfig,
      inputAmountHuman: borrowNumber,
      ethToDaiRate: baseSimConfig.ethToDaiRate,
    });

    expect(result.aborted).to.equal(false);
    expect(result.simulatedOutput).to.be.closeTo(1100, 0.0000000000001);
    expect(result.gasCostDAI).to.be.closeTo(1.26, 0.0000000000001);
    expect(result.premiumDAI).to.be.closeTo(0.9, 0.0000000000001);
    expect(result.totalCostDAI).to.be.closeTo(1002.16, 0.001);
    expect(result.profit).to.be.closeTo(97.84, 0.01);
    expect(result.details.gasUsed).to.equal(gasUsed.toString());
  });

  it("computes profit for HTTP endpoint invocation", async function () {
    const borrowNumber = 5000;
    const borrowWei = ethers.utils.parseUnits(borrowNumber.toString(), 18);
    const gasUsed = ethers.BigNumber.from("300000");

    const result = await determineProfit({
      provider: providerStub,
      route: apiStyleRoute,
      inputAmount: borrowWei,
      gasEstimate: gasUsed,
      flashloanPremiumBips: baseSimConfig.flashloanPremiumBips,
      simConfig: baseSimConfig,
      ethToDaiRate: baseSimConfig.ethToDaiRate,
    });

    expect(result.aborted).to.equal(false);
    expect(result.simulatedOutput).to.be.closeTo(5500, 0.0000000000001);
    expect(result.totalCostDAI).to.be.greaterThan(result.gasCostDAI);
    expect(result.premiumDAI).to.be.closeTo(4.5, 0.0000000001);
    expect(result.profit).to.be.closeTo(477.5, 0.1);
  });
});

describe("simulateRoute", function () {
  it("rejects non-numeric step results", function () {
    const route = {
      steps: [
        {
          simulate: () => "not-a-number",
        },
      ],
    };

    expect(() => simulateRoute(route, 1)).to.throw(
      "simulateRoute steps[0] output must be a finite number"
    );
  });

  it("processes numeric steps", function () {
    const route = {
      steps: [
        { simulate: (amount) => amount + 5 },
        { simulate: (amount) => amount * 2 },
      ],
    };

    expect(simulateRoute(route, 10)).to.equal(30);
  });
});
