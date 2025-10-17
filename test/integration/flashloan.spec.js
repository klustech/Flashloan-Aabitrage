// test/integration/flashloan.spec.js
require("dotenv").config({ override: true });
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("ArbitrageFlashloan – smoke test", function () {
  this.timeout(90_000);

  it("sets maxLossBps and stores value", async () => {
    // reset to a clean fork
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.MAINNET_RPC_URL,
            blockNumber: 17_000_000,
          },
        },
      ],
    });

    const providerAddr = process.env.AAVE_LENDING_POOL_ADDRESS_PROVIDER;

    if (!providerAddr) {
      throw new Error("Missing AAVE_LENDING_POOL_ADDRESS_PROVIDER in .env");
    }

    const maxLossBps = 50;
    const flashloanPremiumBps = 9;

    const Factory = await ethers.getContractFactory("ArbitrageFlashloan");
    const arb = await Factory.deploy(
      providerAddr,
      maxLossBps,
      flashloanPremiumBps
    );
    await arb.deployed();

    await expect(arb.setMaxLossBps(50)).to.not.be.reverted;
    expect(await arb.maxLossBps()).to.equal(50);
  });
});
