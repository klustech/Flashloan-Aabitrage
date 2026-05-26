const { expect } = require("chai");
const { ethers } = require("hardhat");

// DexType.UNISWAP_V2 == 0
const DEX_UNISWAP_V2 = 0;

/**
 * Randomized profit-or-revert fuzz.
 *
 * The old maxLossBps setter is gone; the invariant we fuzz now is the
 * profit-or-revert guard in executeOperation. For a randomly chosen second-leg
 * output rate we assert the on-chain outcome (revert vs. success) matches the
 * off-chain prediction: succeed iff finalOut >= principal + premium + minProfit.
 */
describe("Fuzz: profit-or-revert boundary", function () {
  let arbitrage, deployer, dai, weth, routerA, routerB, lendingPool, provider;

  const PREMIUM_BPS = 9; // 0.09%
  const FLASH_AMOUNT = ethers.utils.parseEther("100");
  const PREMIUM = FLASH_AMOUNT.mul(PREMIUM_BPS).div(10000);
  const MIN_PROFIT = ethers.utils.parseEther("1");
  // Required final balance for a tx to succeed: 100 + 0.09 + 1 = 101.09 DAI.
  const REQUIRED = FLASH_AMOUNT.add(PREMIUM).add(MIN_PROFIT);

  before(async () => {
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

    await dai.mint(lendingPool.address, FLASH_AMOUNT.mul(1000));
    await weth.mint(routerA.address, FLASH_AMOUNT.mul(1000));
    await dai.mint(routerB.address, FLASH_AMOUNT.mul(1000));

    await routerA.setRate(dai.address, weth.address, 1, 1); // 1 DAI -> 1 WETH
  });

  function buildArbData() {
    const baseStep = {
      dexType: DEX_UNISWAP_V2,
      router: ethers.constants.AddressZero,
      tokenIn: ethers.constants.AddressZero,
      tokenOut: ethers.constants.AddressZero,
      minAmountOut: 0,
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
      minProfit: MIN_PROFIT,
      route: "DAI->WETH->DAI",
    };
  }

  it("on-chain outcome always matches the profit-or-revert prediction", async () => {
    for (let i = 0; i < 25; i++) {
      // Random second-leg rate between 0.90 and 1.20 DAI per WETH.
      const num = 900 + Math.floor(Math.random() * 301); // [900, 1200]
      await routerB.setRate(weth.address, dai.address, num, 1000);

      // 100 WETH -> (num/1000)*100 DAI
      const finalOut = FLASH_AMOUNT.mul(num).div(1000);
      const shouldSucceed = finalOut.gte(REQUIRED);

      const call = arbitrage.callStatic.initiateFlashLoan(buildArbData());
      if (shouldSucceed) {
        await expect(call, `rate ${num}/1000 should succeed`).to.not.be
          .reverted;
      } else {
        await expect(call, `rate ${num}/1000 should revert`).to.be.reverted;
      }
    }
  });
});
