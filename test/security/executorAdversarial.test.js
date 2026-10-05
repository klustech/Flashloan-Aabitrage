// Gate 10: executor v4 under adversarial routers, callbacks and stale quotes.
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Executor v4 adversarial invariants", function () {
  const AMOUNT = ethers.utils.parseEther("100");
  const MODE = { HONEST: 0, REENTER_CAPITAL: 1, REENTER_FLASHLOAN: 2, CALL_RESCUE: 3, CALL_ADMIN: 4, CALL_CALLBACK: 5, UNDER_DELIVER: 6, OVER_PULL: 7 };
  let executor, governance, attacker, a, b, honest, evil, pool, arb;

  async function deploy(routers) {
    const provider = await (await ethers.getContractFactory("MockProvider")).deploy(pool.address);
    return (await ethers.getContractFactory("ArbitrageFlashloan")).deploy(provider.address, executor.address, governance.address, executor.address, routers);
  }
  function step(router, tokenIn, tokenOut, minAmountOut = 1) {
    return { dexType: 0, router, tokenIn, tokenOut, minAmountOut, v3Fee: 0, balancerPoolId: ethers.constants.HashZero,
      curveIndexIn: 0, curveIndexOut: 0, curveUnderlying: false, v2Path: [] };
  }
  function data({ minProfit = 1, secondMin = 1 } = {}) {
    return { borrowToken: a.address, borrowAmount: AMOUNT, minProfit, route: "A-B-A",
      steps: [step(honest.address, a.address, b.address), step(evil.address, b.address, a.address, secondMin)] };
  }

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    [executor, attacker] = signers; governance = signers[signers.length - 1];
    const Token = await ethers.getContractFactory("MockERC20");
    a = await Token.deploy("A", "A", 18); b = await Token.deploy("B", "B", 18);
    honest = await (await ethers.getContractFactory("MockUniswapV2Router")).deploy();
    evil = await (await ethers.getContractFactory("MaliciousRouter")).deploy();
    pool = await (await ethers.getContractFactory("MockLendingPool")).deploy(9);
    arb = await deploy([honest.address, evil.address]);
    await honest.setRate(a.address, b.address, 1, 1);
    await evil.setRate(11, 10);
    await b.mint(honest.address, AMOUNT.mul(10)); await a.mint(evil.address, AMOUNT.mul(10));
    await a.mint(pool.address, AMOUNT.mul(10)); await a.mint(arb.address, AMOUNT);
  });

  async function expectPrincipalIntact() { expect(await a.balanceOf(arb.address)).to.equal(AMOUNT); }

  it("refuses a router governance has not approved", async () => {
    const strict = await deploy([honest.address]);
    await a.mint(strict.address, AMOUNT);
    await expect(strict.executeCapitalArbitrage(data())).to.be.revertedWith("router not approved");
    await expect(strict.initiateFlashLoan(data())).to.be.revertedWith("router not approved");
  });

  it("a router cannot re-enter capital execution, even if mistakenly given the executor role", async () => {
    await evil.configure(MODE.REENTER_CAPITAL, arb.address, arb.interface.encodeFunctionData("executeCapitalArbitrage", [data()]));
    await arb.executeCapitalArbitrage(data());
    expect(await evil.attackAttempted()).to.equal(true); expect(await evil.attackSucceeded()).to.equal(false);
    await arb.connect(governance).setExecutor(evil.address, true);
    await arb.executeCapitalArbitrage(data());
    expect(await evil.attackSucceeded()).to.equal(false); // ReentrancyGuard
    await expectPrincipalIntact();
  });

  it("a router with the executor role cannot open a nested flash loan mid-swap", async () => {
    await arb.connect(governance).setExecutor(evil.address, true);
    await evil.configure(MODE.REENTER_FLASHLOAN, arb.address, arb.interface.encodeFunctionData("initiateFlashLoan", [data()]));
    await arb.executeCapitalArbitrage(data());
    expect(await evil.attackSucceeded()).to.equal(false); // executeOperation is nonReentrant
    await expectPrincipalIntact();
  });

  it("a router cannot rescue funds, change governance or fake the lending-pool callback", async () => {
    const attacks = [
      [MODE.CALL_RESCUE, arb.interface.encodeFunctionData("rescueToken", [a.address, AMOUNT])],
      [MODE.CALL_ADMIN, arb.interface.encodeFunctionData("setRouter", [attacker.address, true])],
      [MODE.CALL_ADMIN, arb.interface.encodeFunctionData("transferAdmin", [attacker.address])],
      [MODE.CALL_ADMIN, arb.interface.encodeFunctionData("setExecutor", [attacker.address, true])],
      [MODE.CALL_ADMIN, arb.interface.encodeFunctionData("scheduleProfitRecipientChange", [attacker.address])],
      [MODE.CALL_ADMIN, arb.interface.encodeFunctionData("unpause")],
      [MODE.CALL_CALLBACK, arb.interface.encodeFunctionData("executeOperation", [[a.address], [AMOUNT], [0], arb.address, "0x"])],
    ];
    for (const [mode, payload] of attacks) {
      await evil.configure(mode, arb.address, payload);
      await arb.executeCapitalArbitrage(data());
      expect(await evil.attackSucceeded()).to.equal(false);
    }
    expect(await arb.approvedRouters(attacker.address)).to.equal(false);
    expect(await arb.executors(attacker.address)).to.equal(false);
    expect(await arb.pendingAdmin()).to.equal(ethers.constants.AddressZero);
    await expectPrincipalIntact();
  });

  it("output is measured, so a router that under-delivers or over-pulls reverts the trade", async () => {
    await evil.configure(MODE.UNDER_DELIVER, ethers.constants.AddressZero, "0x");
    await expect(arb.executeCapitalArbitrage(data({ secondMin: AMOUNT }))).to.be.revertedWith("swap output below minimum");
    await evil.configure(MODE.OVER_PULL, ethers.constants.AddressZero, "0x");
    await expect(arb.executeCapitalArbitrage(data())).to.be.reverted; // allowance is exactly amountIn
    await expectPrincipalIntact();
  });

  it("a stale quote on worsened liquidity reverts on the profit floor instead of settling a loss (gate 5)", async () => {
    // Quoted: 100 A -> 100 B -> 110 A, i.e. 10 A gross. Production floors
    // minProfit at the configured minimum plus the gas budget.
    const floor = ethers.utils.parseEther("9");
    for (const [num, den, executes] of [[1095, 1000, true], [1080, 1000, false], [1000, 1000, false], [990, 1000, false]]) {
      await evil.setRate(num, den);
      const before = await a.balanceOf(executor.address);
      if (executes) {
        await arb.executeCapitalArbitrage(data({ minProfit: floor }));
        expect((await a.balanceOf(executor.address)).sub(before)).to.be.gte(floor);
      } else {
        await expect(arb.executeCapitalArbitrage(data({ minProfit: floor }))).to.be.revertedWith("profit<minProfit");
        await expect(arb.initiateFlashLoan(data({ minProfit: floor }))).to.be.revertedWith("profit<minProfit");
      }
      await expectPrincipalIntact();
    }
  });

  it("flash-loan callbacks with a wrong initiator, or after completion, are refused", async () => {
    await arb.initiateFlashLoan(data());
    await ethers.provider.send("hardhat_impersonateAccount", [pool.address]);
    await ethers.provider.send("hardhat_setBalance", [pool.address, "0x10000000000000000"]);
    const asPool = arb.connect(await ethers.getSigner(pool.address));
    await expect(asPool.executeOperation([a.address], [AMOUNT], [0], attacker.address, "0x")).to.be.revertedWith("bad initiator");
    await expect(asPool.executeOperation([a.address], [AMOUNT], [0], arb.address, "0x")).to.be.revertedWith("unexpected callback");
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [pool.address]);
    await expectPrincipalIntact();
  });

  it("the admin cannot trade and the hot executor holds no governance power", async () => {
    await expect(arb.connect(governance).executeCapitalArbitrage(data())).to.be.revertedWith("unauthorized");
    await expect(arb.connect(governance).initiateFlashLoan(data())).to.be.revertedWith("unauthorized");
    for (const call of [() => arb.rescueToken(a.address, 1), () => arb.transferAdmin(executor.address),
      () => arb.setRouter(attacker.address, true), () => arb.setExecutor(attacker.address, true),
      () => arb.scheduleProfitRecipientChange(attacker.address)])
      await expect(call()).to.be.revertedWith("unauthorized");
    await arb.pause();
    await expect(arb.unpause()).to.be.revertedWith("unauthorized");
    await expect(arb.connect(governance).setExecutor(governance.address, true)).to.be.revertedWith("invalid executor");
  });
});
