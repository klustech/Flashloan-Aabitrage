require("dotenv").config();
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ArbitrageFlashloan (Mainnet Fork)", function () {
  this.timeout(60000);

  let deployer, arbitrage;

  const providerAddr = process.env.AAVE_LENDING_POOL_ADDRESS_PROVIDER;
  const uniRouter = process.env.UNISWAP_ROUTER_ADDRESS;
  const sushiRouter = process.env.SUSHISWAP_ROUTER_ADDRESS;

  before(async () => {
    if (!providerAddr || !uniRouter || !sushiRouter) {
      throw new Error(
        "Set AAVE_LENDING_POOL_ADDRESS_PROVIDER, UNISWAP_ROUTER_ADDRESS, SUSHISWAP_ROUTER_ADDRESS in .env"
      );
    }
    [deployer] = await ethers.getSigners();
    const Arb = await ethers.getContractFactory("ArbitrageFlashloan");
    arbitrage = await Arb.deploy(providerAddr, uniRouter, sushiRouter);
    await arbitrage.deployed();
  });

  it("assigns deployer as owner", async () => {
    expect(await arbitrage.owner()).to.equal(deployer.address);
  });

  it("allows initiateFlashLoan to be called (even if it reverts later)", async () => {
    const SwapData = {
      uniPath: [process.env.TOKENS_DAI, process.env.TOKENS_WETH],
      sushiPath: [process.env.TOKENS_WETH, process.env.TOKENS_DAI],
      thirdPath: [process.env.TOKENS_WETH, process.env.TOKENS_DAI],
      minOutUni: 0,
      minOutSushi: 0,
      minOutThird: 0,
      minProfit: 0,
    };

    // simulate with callStatic so we don't need a working flashLoan pool
    await expect(
      arbitrage.callStatic.initiateFlashLoan(
        SwapData.uniPath[0],
        ethers.utils.parseEther("1"),
        SwapData
      )
    ).to.be.reverted;
  });
});
