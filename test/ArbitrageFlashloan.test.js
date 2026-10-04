const { expect } = require("chai");
const { ethers } = require("hardhat");

// DexType enum from the contract: UNISWAP_V2 = 0
const DEX_UNISWAP_V2 = 0;

describe("ArbitrageFlashloan", function () {
  let deployer;
  let dai;
  let weth;
  let routerA;
  let routerB;
  let lendingPool;
  let provider;
  let arbitrage;

  const flashloanPremiumBps = 9; // 0.09%
  const flashAmount = ethers.utils.parseEther("100");
  const minProfit = ethers.utils.parseEther("1");
  const routeString = "DAI->WETH->DAI";

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

    // New constructor: (provider, profitRecipient, timelock).
    // profitRecipient = deployer so we can assert PnL lands on the owner.
    const Arb = await ethers.getContractFactory("ArbitrageFlashloan");
    arbitrage = await Arb.deploy(
      provider.address,
      deployer.address,
      ethers.constants.AddressZero
    );
    await arbitrage.deployed();

    // Seed liquidity for the flash loan and routers.
    await dai.mint(lendingPool.address, flashAmount.mul(10));
    await weth.mint(routerA.address, flashAmount.mul(10));
    await dai.mint(routerB.address, flashAmount.mul(10));

    // Configure deterministic swap rates:
    //   routerA: 1 DAI -> 1 WETH   (1:1)
    //   routerB: 1 WETH -> 1.1 DAI (11:10) -> creates the arbitrage profit
    await routerA.setRate(dai.address, weth.address, 1, 1);
    await routerB.setRate(weth.address, dai.address, 11, 10);
  });

  // Builds a single ArbitrageData bundle describing the DAI->WETH->DAI cycle.
  function buildArbData(overrides = {}) {
    const baseStep = {
      dexType: DEX_UNISWAP_V2,
      router: ethers.constants.AddressZero,
      tokenIn: ethers.constants.AddressZero,
      tokenOut: ethers.constants.AddressZero,
      minAmountOut: 1,
      v3Fee: 0,
      balancerPoolId: ethers.constants.HashZero,
      curveIndexIn: 0,
      curveIndexOut: 0,
      curveUnderlying: false,
      v2Path: [],
    };

    return Object.assign(
      {
        borrowToken: dai.address,
        borrowAmount: flashAmount,
        steps: [
          Object.assign({}, baseStep, {
            router: routerA.address,
            tokenIn: dai.address,
            tokenOut: weth.address,
            minAmountOut: ethers.utils.parseEther("99"),
          }),
          Object.assign({}, baseStep, {
            router: routerB.address,
            tokenIn: weth.address,
            tokenOut: dai.address,
            minAmountOut: ethers.utils.parseEther("105"),
          }),
        ],
        minProfit,
        route: routeString,
      },
      overrides
    );
  }

  it("assigns deployer as owner", async () => {
    expect(await arbitrage.owner()).to.equal(deployer.address);
  });

  it("sets the profit recipient from the constructor", async () => {
    expect(await arbitrage.profitRecipient()).to.equal(deployer.address);
  });

  it("rejects flash loans from non-owners", async () => {
    const [, attacker] = await ethers.getSigners();
    await expect(
      arbitrage.connect(attacker).initiateFlashLoan(buildArbData())
    ).to.be.revertedWith("unauthorized");
  });

  it("validates the swap cycle before requesting the flash loan", async () => {
    // First step's tokenIn must equal the borrow token.
    const badData = buildArbData();
    badData.steps[0].tokenIn = weth.address;

    await expect(arbitrage.initiateFlashLoan(badData)).to.be.revertedWith(
      "first step tokenIn mismatch"
    );
  });

  it("executes the mocked flash-loan cycle, emits events, and realises profit", async () => {
    const arbData = buildArbData();

    // Dry-run via callStatic to ensure validation + execution path pass.
    await expect(arbitrage.callStatic.initiateFlashLoan(arbData)).to.not.be
      .reverted;

    const firstOut = flashAmount; // 100 DAI -> 100 WETH (1:1)
    const secondOut = firstOut.mul(11).div(10); // 100 WETH -> 110 DAI
    const premium = flashAmount.mul(flashloanPremiumBps).div(10000); // 0.09 DAI
    const expectedPnl = secondOut.sub(flashAmount.add(premium)); // 110 - 100.09 = 9.91

    const tx = await arbitrage.initiateFlashLoan(arbData);

    // SwapExecuted(dexType, tokenIn, tokenOut, amountIn, amountOut)
    await expect(tx)
      .to.emit(arbitrage, "SwapExecuted")
      .withArgs(
        DEX_UNISWAP_V2,
        dai.address,
        weth.address,
        flashAmount,
        firstOut
      );

    await expect(tx)
      .to.emit(arbitrage, "SwapExecuted")
      .withArgs(DEX_UNISWAP_V2, weth.address, dai.address, firstOut, secondOut);

    // ProfitWithdrawn(token, recipient, amount)
    await expect(tx)
      .to.emit(arbitrage, "ProfitWithdrawn")
      .withArgs(dai.address, deployer.address, expectedPnl);

    // ArbitrageExecuted(borrowed, pnl, route)
    await expect(tx)
      .to.emit(arbitrage, "ArbitrageExecuted")
      .withArgs(flashAmount, expectedPnl, routeString);

    // Profit recipient (deployer) received exactly the realised PnL.
    const ownerBalance = await dai.balanceOf(deployer.address);
    expect(ownerBalance).to.equal(expectedPnl);

    // Pool was repaid principal + premium.
    const poolBalance = await dai.balanceOf(lendingPool.address);
    expect(poolBalance).to.equal(flashAmount.mul(10).add(premium));
  });

  it("reverts a non-profitable cycle (profit < minProfit)", async () => {
    // Make routerB return only 1:1, so the cycle returns 100 DAI < 100.09 + 1.
    await routerB.setRate(weth.address, dai.address, 1, 1);

    const arbData = buildArbData();
    // Relax minAmountOut so the swaps themselves do not revert on slippage;
    // the profit-or-revert guard in executeOperation must catch the shortfall.
    arbData.steps[1].minAmountOut = 1;

    await expect(arbitrage.initiateFlashLoan(arbData)).to.be.revertedWith(
      "profit<minProfit"
    );
  });
  it("executes a treasury-funded cycle without allowing prefunded principal to subsidize losses", async () => {
    const treasury = ethers.utils.parseEther("100");
    const arbData = buildArbData({ borrowAmount: treasury });

    await dai.mint(arbitrage.address, treasury);
    const recipientBefore = await dai.balanceOf(deployer.address);

    const firstOut = treasury;
    const secondOut = firstOut.mul(11).div(10);
    const expectedProfit = secondOut.sub(treasury);

    await expect(arbitrage.executeFundedArbitrage(arbData))
      .to.emit(arbitrage, "FundedArbitrageExecuted")
      .withArgs(treasury, expectedProfit, routeString);

    expect(await dai.balanceOf(arbitrage.address)).to.equal(treasury);
    expect((await dai.balanceOf(deployer.address)).sub(recipientBefore)).to.equal(expectedProfit);

    await routerB.setRate(weth.address, dai.address, 99, 100);
    const losing = buildArbData({
      borrowAmount: treasury,
      minProfit: 1,
    });
    losing.steps[1].minAmountOut = 1;

    await expect(arbitrage.executeFundedArbitrage(losing)).to.be.revertedWith(
      "profit<minProfit"
    );
    expect(await dai.balanceOf(arbitrage.address)).to.equal(treasury);
  });

  it("reports executor version 3 for adaptive funding support", async () => {
    expect(await arbitrage.executorVersion()).to.equal(3);
  });

});
