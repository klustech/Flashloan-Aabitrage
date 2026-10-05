// test/unit/ArbitrageFlashloan.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ArbitrageFlashloan - Unit Tests", function () {
  let executor, other, governance, newGovernance;
  let arbitrage, provider, lendingPool, Factory;

  const PREMIUM_BPS = 9; // 0.09%

  beforeEach(async function () {
    [executor, other, newGovernance, governance] = await ethers.getSigners();

    // Deploy lightweight mocks so the constructor's provider.getLendingPool()
    // call resolves to real on-chain code on the local Hardhat network.
    const LendingPool = await ethers.getContractFactory("MockLendingPool");
    lendingPool = await LendingPool.deploy(PREMIUM_BPS);
    await lendingPool.deployed();

    const Provider = await ethers.getContractFactory("MockProvider");
    provider = await Provider.deploy(lendingPool.address);
    await provider.deployed();

    // Constructor: (provider, profitRecipient, admin, executor).
    Factory = await ethers.getContractFactory("ArbitrageFlashloan");
    arbitrage = await Factory.deploy(provider.address, executor.address, governance.address, executor.address, []);
    await arbitrage.deployed();
  });

  it("separates the admin from the executor", async () => {
    expect(await arbitrage.admin()).to.equal(governance.address);
    expect(await arbitrage.executors(executor.address)).to.equal(true);
    expect(await arbitrage.executors(governance.address)).to.equal(false);
    expect(await arbitrage.executorVersion()).to.equal(4);
  });

  it("assigns the configured profit recipient", async () => {
    expect(await arbitrage.profitRecipient()).to.equal(executor.address);
  });

  it("wires up the lending pool from the provider", async () => {
    expect(await arbitrage.lendingPool()).to.equal(lendingPool.address);
  });

  it("starts unpaused and reports it can execute", async () => {
    expect(await arbitrage.paused()).to.equal(false);
    expect(await arbitrage.canExecute()).to.equal(true);
  });

  it("rejects invalid constructor authority", async () => {
    const Z = ethers.constants.AddressZero;
    await expect(Factory.deploy(Z, executor.address, governance.address, executor.address, [])).to.be.revertedWith("invalid provider");
    await expect(Factory.deploy(provider.address, Z, governance.address, executor.address, [])).to.be.revertedWith("invalid recipient");
    await expect(Factory.deploy(provider.address, executor.address, Z, executor.address, [])).to.be.revertedWith("invalid admin");
    await expect(Factory.deploy(provider.address, executor.address, governance.address, Z, [])).to.be.revertedWith("invalid executor");
    await expect(Factory.deploy(provider.address, executor.address, executor.address, executor.address, [])).to.be.revertedWith("invalid executor");
    await expect(Factory.deploy(provider.address, executor.address, governance.address, executor.address, [Z])).to.be.revertedWith("zero router");
    const seeded = await Factory.deploy(provider.address, executor.address, governance.address, executor.address, [other.address]);
    expect(await seeded.approvedRouters(other.address)).to.equal(true);
  });

  it("gives the executor no governance powers", async () => {
    const hot = arbitrage.connect(executor);
    await expect(hot.setExecutor(other.address, true)).to.be.revertedWith("unauthorized");
    await expect(hot.setRouter(other.address, true)).to.be.revertedWith("unauthorized");
    await expect(hot.transferAdmin(executor.address)).to.be.revertedWith("unauthorized");
    await expect(hot.scheduleProfitRecipientChange(executor.address)).to.be.revertedWith("unauthorized");
    await expect(hot.rescueToken(other.address, 1)).to.be.revertedWith("unauthorized");
    await hot.pause();
    await expect(hot.unpause()).to.be.revertedWith("unauthorized");
    await arbitrage.connect(governance).unpause();
  });

  it("never lets the admin hold the executor role", async () => {
    await expect(arbitrage.connect(governance).setExecutor(governance.address, true)).to.be.revertedWith("invalid executor");
    await expect(arbitrage.connect(governance).transferAdmin(executor.address)).to.be.revertedWith("invalid admin");
    await arbitrage.connect(governance).transferAdmin(newGovernance.address);
    await expect(arbitrage.connect(governance).setExecutor(newGovernance.address, true)).to.be.revertedWith("invalid executor");
  });

  it("transfers admin in two steps", async () => {
    await expect(arbitrage.connect(other).transferAdmin(other.address)).to.be.revertedWith("unauthorized");
    await arbitrage.connect(governance).transferAdmin(newGovernance.address);
    expect(await arbitrage.admin()).to.equal(governance.address);
    await expect(arbitrage.connect(other).acceptAdmin()).to.be.revertedWith("unauthorized");
    await arbitrage.connect(newGovernance).acceptAdmin();
    expect(await arbitrage.admin()).to.equal(newGovernance.address);
    expect(await arbitrage.pendingAdmin()).to.equal(ethers.constants.AddressZero);
  });

  it("lets the admin rotate executors and manage routers", async () => {
    await arbitrage.connect(governance).setExecutor(other.address, true);
    await arbitrage.connect(governance).setExecutor(executor.address, false);
    expect(await arbitrage.executors(other.address)).to.equal(true);
    expect(await arbitrage.executors(executor.address)).to.equal(false);
    await arbitrage.connect(governance).setRouter(other.address, true);
    expect(await arbitrage.approvedRouters(other.address)).to.equal(true);
    await expect(arbitrage.connect(governance).setRouter(ethers.constants.AddressZero, true)).to.be.revertedWith("zero router");
  });
});
