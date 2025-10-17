const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FlashloanExecutor approvals with USDT-like tokens", function () {
  let owner;
  let executor;
  let provider;
  let router;
  let usdtLike;

  const dexTypeUniswapV2 = 0;

  const swapStepAbi =
    "tuple(uint8 dex,address routerOrVault,address tokenIn,address tokenOut,uint24 fee,bytes32 balancerPoolId,int128 curveIndexIn,int128 curveIndexOut,uint256 amountIn,uint256 minAmountOut,address[] uniPath)[]";

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    const ProviderFactory = await ethers.getContractFactory("MockProvider");
    provider = await ProviderFactory.deploy(ethers.constants.AddressZero);
    await provider.deployed();

    const ExecutorFactory = await ethers.getContractFactory("FlashloanExecutor");
    executor = await ExecutorFactory.deploy(provider.address);
    await executor.deployed();

    const RouterFactory = await ethers.getContractFactory("MockUniswapV2Router");
    router = await RouterFactory.deploy();
    await router.deployed();

    const USDTFactory = await ethers.getContractFactory("USDTLikeToken");
    usdtLike = await USDTFactory.deploy();
    await usdtLike.deployed();

    const mintAmount = ethers.utils.parseUnits("1000000", 6);
    await usdtLike.mint(executor.address, mintAmount);
  });

  function buildStep(amount) {
    return [
      {
        dex: dexTypeUniswapV2,
        routerOrVault: router.address,
        tokenIn: usdtLike.address,
        tokenOut: usdtLike.address,
        fee: 0,
        balancerPoolId: ethers.constants.HashZero,
        curveIndexIn: 0,
        curveIndexOut: 0,
        amountIn: amount,
        minAmountOut: 0,
        uniPath: [usdtLike.address, usdtLike.address],
      },
    ];
  }

  function encodeSteps(steps) {
    return ethers.utils.defaultAbiCoder.encode([swapStepAbi], [steps]);
  }

  async function execute(amount, premium) {
    const steps = buildStep(amount);
    const params = encodeSteps(steps);
    await executor.executeOperation(
      [usdtLike.address],
      [amount],
      [premium],
      owner.address,
      params
    );
  }

  it("cycles approvals without reverting for USDT-style tokens", async function () {
    const borrowAmount = ethers.utils.parseUnits("1000", 6);
    const premiumAmount = ethers.utils.parseUnits("10", 6);

    await expect(execute(borrowAmount, premiumAmount)).to.not.be.reverted;

    const firstRouterAllowance = await usdtLike.allowance(
      executor.address,
      router.address
    );
    expect(firstRouterAllowance).to.equal(borrowAmount);

    const firstRepayAllowance = await usdtLike.allowance(
      executor.address,
      owner.address
    );
    expect(firstRepayAllowance).to.equal(borrowAmount.add(premiumAmount));

    await expect(execute(borrowAmount, premiumAmount)).to.not.be.reverted;

    const secondRouterAllowance = await usdtLike.allowance(
      executor.address,
      router.address
    );
    expect(secondRouterAllowance).to.equal(borrowAmount);

    const secondRepayAllowance = await usdtLike.allowance(
      executor.address,
      owner.address
    );
    expect(secondRepayAllowance).to.equal(borrowAmount.add(premiumAmount));
  });

  it("resets allowances correctly when the amount changes", async function () {
    const firstAmount = ethers.utils.parseUnits("500", 6);
    const secondAmount = ethers.utils.parseUnits("800", 6);
    const premiumAmount = ethers.utils.parseUnits("5", 6);

    await execute(firstAmount, premiumAmount);
    await execute(secondAmount, premiumAmount);

    const routerAllowance = await usdtLike.allowance(executor.address, router.address);
    expect(routerAllowance).to.equal(secondAmount);

    const repayAllowance = await usdtLike.allowance(executor.address, owner.address);
    expect(repayAllowance).to.equal(secondAmount.add(premiumAmount));
  });
});
