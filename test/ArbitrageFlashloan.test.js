const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ArbitrageFlashloan", function () {
  let deployer;
  let dai;
  let weth;
  let routerA;
  let routerB;
  let lendingPool;
  let provider;
  let arbitrage;

  const maxLossBps = 500; // 5%
  const flashloanPremiumBps = 9; // 0.09%
  const flashAmount = ethers.utils.parseEther("100");
  const minProfit = ethers.utils.parseEther("1");
  const routeString = "DAI→WETH→DAI";

  beforeEach(async () => {
    [deployer] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    dai = await Token.deploy("Mock DAI", "DAI", 18);
    weth = await Token.deploy("Mock WETH", "WETH", 18);

    const Router = await ethers.getContractFactory("MockUniswapV2Router");
    routerA = await Router.deploy();
    routerB = await Router.deploy();

    const LendingPool = await ethers.getContractFactory("MockLendingPool");
    lendingPool = await LendingPool.deploy(flashloanPremiumBps);

    const Provider = await ethers.getContractFactory("MockProvider");
    provider = await Provider.deploy(lendingPool.address);

    const Arb = await ethers.getContractFactory("ArbitrageFlashloan");
    arbitrage = await Arb.deploy(provider.address, maxLossBps, flashloanPremiumBps);

    // Seed liquidity for the flash loan and routers
    await dai.mint(lendingPool.address, flashAmount.mul(10));
    await weth.mint(routerA.address, flashAmount.mul(10));
    await dai.mint(routerB.address, flashAmount.mul(10));

    // Configure deterministic swap rates
    await routerA.setRate(dai.address, weth.address, 1, 1);
    await routerB.setRate(weth.address, dai.address, 11, 10);
  });

  function buildSwapData() {
    return {
      token: dai.address,
      paths: [
        [routerA.address, dai.address, weth.address],
        [routerB.address, weth.address, dai.address],
      ],
      minOuts: [
        ethers.utils.parseEther("99"),
        ethers.utils.parseEther("105"),
      ],
      minProfit,
      route: routeString,
    };
  }

  it("assigns deployer as owner", async () => {
    expect(await arbitrage.owner()).to.equal(deployer.address);
  });

  it("validates path/minOut structure before requesting the flash loan", async () => {
    const badData = {
      token: dai.address,
      paths: [[routerA.address, dai.address, weth.address]],
      minOuts: [],
      minProfit: 0,
      route: routeString,
    };

    await expect(
      arbitrage.initiateFlashLoan(dai.address, flashAmount, badData)
    ).to.be.revertedWith("paths/minOuts mismatch");
  });

  it("executes the mocked flash-loan cycle, emits events, and realises profit", async () => {
    const swapData = buildSwapData();

    // Dry-run via callStatic to ensure validation passes
    await expect(
      arbitrage.callStatic.initiateFlashLoan(dai.address, flashAmount, swapData)
    ).to.not.be.reverted;

    const tx = await arbitrage.initiateFlashLoan(dai.address, flashAmount, swapData);

    const firstOut = flashAmount;
    const secondOut = firstOut.mul(11).div(10);
    const premium = flashAmount.mul(flashloanPremiumBps).div(10000);
    const expectedPnl = secondOut.sub(flashAmount.add(premium));

    await expect(tx)
      .to.emit(arbitrage, "SwapExecuted")
      .withArgs(routerA.address, dai.address, weth.address, flashAmount, firstOut);

    await expect(tx)
      .to.emit(arbitrage, "SwapExecuted")
      .withArgs(routerB.address, weth.address, dai.address, firstOut, secondOut);

    await expect(tx)
      .to.emit(arbitrage, "ProfitWithdrawn")
      .withArgs(dai.address, expectedPnl);

    await expect(tx)
      .to.emit(arbitrage, "ArbitrageExecuted")
      .withArgs(flashAmount, expectedPnl, routeString);

    const ownerBalance = await dai.balanceOf(deployer.address);
    expect(ownerBalance).to.equal(expectedPnl);

    const poolBalance = await dai.balanceOf(lendingPool.address);
    expect(poolBalance).to.equal(flashAmount.mul(10).add(premium));
  });
});
