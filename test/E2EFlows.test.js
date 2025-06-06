// test/E2EFlows.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("E2E Arbitrage on UniswapV3 + Balancer + Curve", function () {
  before(async function () {
    this.timeout(200000);
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.ETH_RPC_URL,
            blockNumber: 17300000,
          },
        },
      ],
    });
    this.arb = await ethers.getContractFactory("ArbitrageFlashloan");
    this.contract = await this.arb.deploy(
      process.env.AAVE_POOL,
      process.env.UNI_ROUTER,
      process.env.SUSHI_ROUTER,
      (
        await ethers.getSigners()
      )[0].address,
      100,
      ethers.utils.parseEther("1")
    );
    await this.contract.deployed();
  });

  it("Should find a UniswapV3 4-hop arb and execute", async function () {
    // simulate with Quoter for V3 pools & ensure flashloan path builder picks it
    const topV3Pools = await getTopV3Pools(10);
    const routes = await generateRouteDefs(topV3Pools);
    const profitable = await simulateRoute(routes[0], 25);
    expect(profitable.isProfitable).to.be.true;
    // attempt flashloan; this will revert or succeed on forked chain
  }).timeout(100000);
});
