// test/E2EFlows.test.js
//
// End-to-end flow test for the refactored ArbitrageFlashloan.
//
// Originally this referenced fork-only helpers (getTopV3Pools / generateRouteDefs /
// simulateRoute) that were never exported, plus an outdated 6-arg constructor.
// It now runs fully locally against the mock DEX/lending stack and exercises the
// real off-chain route simulator (utils/profitDetermination + buildStepsFromHops)
// before executing the same cycle on-chain via the new ArbitrageData API.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const { simulateRoute } = require("../utils/profitDetermination");
const { buildStepsFromHops } = require("../utils/buildStepsFromHops");

// DexType.UNISWAP_V2 == 0
const DEX_UNISWAP_V2 = 0;

describe("E2E Arbitrage flow (off-chain sim -> on-chain execution)", function () {
  this.timeout(120000);

  let deployer;
  let dai;
  let weth;
  let routerA;
  let routerB;
  let lendingPool;
  let provider;
  let contract;

  const PREMIUM_BPS = 9; // 0.09%
  const FLASH_AMOUNT = ethers.utils.parseEther("100");
  const PREMIUM = FLASH_AMOUNT.mul(PREMIUM_BPS).div(10000);

  before(async function () {
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

    // New 3-arg constructor: (provider, profitRecipient, timelock).
    const Arb = await ethers.getContractFactory("ArbitrageFlashloan");
    contract = await Arb.deploy(
      provider.address,
      deployer.address,
      ethers.constants.AddressZero
    );
    await contract.deployed();

    // Seed liquidity. routerB returns 1.1 DAI per WETH -> profitable cycle.
    await dai.mint(lendingPool.address, FLASH_AMOUNT.mul(100));
    await weth.mint(routerA.address, FLASH_AMOUNT.mul(100));
    await dai.mint(routerB.address, FLASH_AMOUNT.mul(100));
    await routerA.setRate(dai.address, weth.address, 1, 1);
    await routerB.setRate(weth.address, dai.address, 11, 10);
  });

  function buildArbData(minProfit) {
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

  it("simulates a profitable multi-hop route off-chain", function () {
    // Use the real route simulator. Two near-zero-fee hops so the off-chain
    // estimate stays close to the on-chain mock output.
    const route = buildStepsFromHops({
      hops: [
        { dex: "uniswap_v2", feeBps: 0 },
        { dex: "uniswap_v2", feeBps: 0 },
      ],
    });
    // Override the second hop to reflect the 1.1x mock rate.
    route.steps[1].simulate = (amt) => amt * 1.1;

    const output = simulateRoute(route, 100); // start with 100 DAI
    expect(output).to.be.closeTo(110, 1e-6);
    expect(output).to.be.greaterThan(100); // gross-profitable before premium
  });

  it("executes the on-chain flash-loan cycle and realises the predicted profit", async function () {
    const minProfit = ethers.utils.parseEther("1");
    const finalOut = FLASH_AMOUNT.mul(11).div(10); // 110 DAI
    const expectedProfit = finalOut.sub(FLASH_AMOUNT.add(PREMIUM)); // 9.91 DAI

    const before = await dai.balanceOf(deployer.address);

    await expect(contract.initiateFlashLoan(buildArbData(minProfit)))
      .to.emit(contract, "ArbitrageExecuted")
      .withArgs(FLASH_AMOUNT, expectedProfit, "DAI->WETH->DAI");

    const after = await dai.balanceOf(deployer.address);
    expect(after.sub(before)).to.equal(expectedProfit);
  });

  it("reverts a cycle that cannot clear principal + premium + minProfit", async function () {
    await routerB.setRate(weth.address, dai.address, 1, 1); // 100 WETH -> 100 DAI
    await expect(
      contract.initiateFlashLoan(buildArbData(ethers.utils.parseEther("1")))
    ).to.be.revertedWith("profit<minProfit");
    // Restore the profitable rate for isolation.
    await routerB.setRate(weth.address, dai.address, 11, 10);
  });
});

