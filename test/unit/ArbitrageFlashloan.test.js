// test/unit/ArbitrageFlashloan.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ArbitrageFlashloan - Unit Tests", function () {
  let deployer;
  let other;
  let arbitrage;
  let provider;
  let lendingPool;

  const PREMIUM_BPS = 9; // 0.09%

  before(async function () {
    [deployer, other] = await ethers.getSigners();

    // Deploy lightweight mocks so the constructor's provider.getLendingPool()
    // call resolves to real on-chain code on the local Hardhat network.
    const LendingPool = await ethers.getContractFactory("MockLendingPool");
    lendingPool = await LendingPool.deploy(PREMIUM_BPS);
    await lendingPool.deployed();

    const Provider = await ethers.getContractFactory("MockProvider");
    provider = await Provider.deploy(lendingPool.address);
    await provider.deployed();

    // Constructor: (provider, profitRecipient, timelock).
    const Factory = await ethers.getContractFactory("ArbitrageFlashloan");
    arbitrage = await Factory.deploy(
      provider.address,
      deployer.address,
      ethers.constants.AddressZero
    );
    await arbitrage.deployed();
  });

  it("assigns deployer as owner", async () => {
    expect(await arbitrage.owner()).to.equal(deployer.address);
  });

  it("assigns the configured profit recipient", async () => {
    expect(await arbitrage.profitRecipient()).to.equal(deployer.address);
  });

  it("wires up the lending pool from the provider", async () => {
    expect(await arbitrage.lendingPool()).to.equal(lendingPool.address);
  });

  it("starts unpaused and reports it can execute", async () => {
    expect(await arbitrage.paused()).to.equal(false);
    expect(await arbitrage.canExecute()).to.equal(true);
  });

  it("reverts when a non-provider address is used as the provider", async () => {
    const Factory = await ethers.getContractFactory("ArbitrageFlashloan");
    await expect(
      Factory.deploy(
        ethers.constants.AddressZero,
        deployer.address,
        ethers.constants.AddressZero
      )
    ).to.be.revertedWith("invalid provider");
  });

  it("transfers ownership only by the current owner", async () => {
    await expect(
      arbitrage.connect(other).transferOwnership(other.address)
    ).to.be.revertedWith("unauthorized");

    await arbitrage.transferOwnership(other.address);
    expect(await arbitrage.owner()).to.equal(other.address);

    // Restore ownership for any subsequent tests.
    await arbitrage.connect(other).transferOwnership(deployer.address);
    expect(await arbitrage.owner()).to.equal(deployer.address);
  });
});
