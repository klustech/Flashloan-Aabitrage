// test/integration/flashloan.spec.js
require("dotenv").config({ override: true });
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { deployExecutor } = require("../helpers/executor");

// This is a mainnet-fork smoke test. It only runs when forking is enabled
// (npm run test:fork sets ENABLE_MAINNET_FORK=true + MAINNET_RPC_URL).
const FORK_ENABLED =
  String(process.env.ENABLE_MAINNET_FORK || "").toLowerCase() === "true";
const describeFork = FORK_ENABLED ? describe : describe.skip;

describeFork("ArbitrageFlashloan - fork smoke test", function () {
  this.timeout(90_000);

  it("deploys against the live Aave provider and reports its config", async () => {
    // Reset to a clean fork.
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

    const [deployer] = await ethers.getSigners();

    const { arb, governance } = await deployExecutor(ethers, providerAddr, deployer.address);

    // The provider must resolve to a non-zero, code-bearing lending pool.
    expect(await arb.executors(deployer.address)).to.equal(true);
    expect(await arb.admin()).to.equal(governance.address);
    expect(await arb.profitRecipient()).to.equal(deployer.address);
    expect(await arb.lendingPool()).to.not.equal(ethers.constants.AddressZero);
    expect(await arb.canExecute()).to.equal(true);
  });
});
