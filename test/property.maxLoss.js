const { expect } = require("chai");
const { ethers } = require("hardhat");

// DexType.UNISWAP_V2 == 0
const DEX_UNISWAP_V2 = 0;

/**
 * Profit-or-revert invariant.
 *
 * The refactored ArbitrageFlashloan no longer tolerates any loss: there is no
 * maxLossBps buffer. Instead executeOperation requires
 *     finalBalance >= borrowedAmount + premium + minProfit
 * so any cycle that fails to clear principal + premium + minProfit MUST revert,
 * and the contract can never settle a net loss. These tests pin that invariant
 * across a range of swap rates.
 */
describe("Invariant: arbitrage is profit-or-revert", function () {
  let arbitrage, deployer, dai, weth, routerA, routerB, lendingPool, provider;

  const PREMIUM_BPS = 9; // 0.09%
  const FLASH_AMOUNT = ethers.utils.parseEther("100");
  const PREMIUM = FLASH_AMOUNT.mul(PREMIUM_BPS).div(10000); // 0.09 DAI

  beforeEach(async () => {
    [deployer] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    dai = await Token.deploy("Mock DAI", "DAI", 18);
    weth = await Token.deploy("Mock WETH", "WETH", 18);

    const Router = await ethers.getContractFactory("MockUniswapV2Router");
    routerA = await Router.deploy();
    routerB = await Router.deploy();

    const LendingPool = await ethers.getContractFactory("MockLendingPool");
    lendingPool = await LendingPool.deploy(PREMIUM_BPS);

    const Provider = await ethers.getContractFactory("MockProvider");
    provider = await Provider.deploy(lendingPool.address);

    const Arb = await ethers.getContractFactory("ArbitrageFlashloan");
    arbitrage = await Arb.deploy(
      provider.address,
      deployer.address,
      ethers.constants.AddressZero
    );
    await arbitrage.deployed();

    // Generous liquidity so swaps never fail for lack of tokens.
    await dai.mint(lendingPool.address, FLASH_AMOUNT.mul(100));
    await weth.mint(routerA.address, FLASH_AMOUNT.mul(100));
    await dai.mint(routerB.address, FLASH_AMOUNT.mul(100));

    // Leg 1 is always 1 DAI -> 1 WETH; leg 2's rate is set per-test.
    await routerA.setRate(dai.address, weth.address, 1, 1);
  });

  function buildArbData(minProfit) {
    const baseStep = {
      dexType: DEX_UNISWAP_V2,
      router: ethers.constants.AddressZero,
      tokenIn: ethers.constants.AddressZero,
      tokenOut: ethers.constants.AddressZero,
      minAmountOut: 0, // relax slippage so the profit guard is what enforces the invariant
      v3Fee: 0,
      balancerPoolId: ethers.constants.HashZero,
      curveIndexIn: 0,
      curveIndexOut: 0,
      curveUnderlying: false,
      v2Path: [],
    };
    return {
      borrowToken: dai.address,
      borrowAmount: FLASH_AMOUNT,
      steps: [
        Object.assign({}, baseStep, {
          router: routerA.address,
          tokenIn: dai.address,
          tokenOut: weth.address,
        }),
        Object.assign({}, baseStep, {
          router: routerB.address,
          tokenIn: weth.address,
          tokenOut: dai.address,
        }),
      ],
      minProfit,
      route: "DAI->WETH->DAI",
    };
  }

  it("reverts when the cycle returns less than principal + premium", async () => {
    // 100 WETH -> 99 DAI: below the 100 DAI principal, definitely a loss.
    await routerB.setRate(weth.address, dai.address, 99, 100);
    await expect(
      arbitrage.initiateFlashLoan(buildArbData(0))
    ).to.be.revertedWith("profit<minProfit");
  });

  it("reverts when profit is positive but below minProfit", async () => {
    // 100 WETH -> 100.5 DAI: clears principal + premium (100.09) but the
    // 0.41 DAI profit is short of the 1 DAI minProfit.
    await routerB.setRate(weth.address, dai.address, 1005, 1000);
    await expect(
      arbitrage.initiateFlashLoan(buildArbData(ethers.utils.parseEther("1")))
    ).to.be.revertedWith("profit<minProfit");
  });

  it("succeeds and pays out exactly principal+premium worth of profit", async () => {
    // 100 WETH -> 110 DAI: profit = 110 - 100.09 = 9.91 DAI >= minProfit (1).
    await routerB.setRate(weth.address, dai.address, 11, 10);
    const minProfit = ethers.utils.parseEther("1");

    const finalOut = FLASH_AMOUNT.mul(11).div(10); // 110 DAI
    const expectedProfit = finalOut.sub(FLASH_AMOUNT.add(PREMIUM)); // 9.91

    await expect(arbitrage.initiateFlashLoan(buildArbData(minProfit))).to.not.be
      .reverted;

    expect(await dai.balanceOf(deployer.address)).to.equal(expectedProfit);
  });

  it("never settles a loss: profitability is monotonic in the output rate", async () => {
    // numerator/1000 is the DAI returned per WETH. The break-even point is
    // ~1000.9/1000 (principal + premium). Below it the tx must revert; well
    // above it the tx must succeed. This sweeps both sides of the boundary.
    const cases = [
      { num: 990, shouldRevert: true }, // 99.0 DAI  -> loss
      { num: 1000, shouldRevert: true }, // 100.0 DAI -> below premium
      { num: 1009, shouldRevert: true }, // 100.9 DAI -> profit < 1 minProfit
      { num: 1020, shouldRevert: false }, // 102.0 DAI -> ~1.91 profit
      { num: 1100, shouldRevert: false }, // 110.0 DAI -> 9.91 profit
    ];
    const minProfit = ethers.utils.parseEther("1");

    for (const { num, shouldRevert } of cases) {
      await routerB.setRate(weth.address, dai.address, num, 1000);
      const call = arbitrage.callStatic.initiateFlashLoan(
        buildArbData(minProfit)
      );
      if (shouldRevert) {
        await expect(call, `rate ${num}/1000 should revert`).to.be.reverted;
      } else {
        await expect(call, `rate ${num}/1000 should succeed`).to.not.be
          .reverted;
      }
    }
  });
});
