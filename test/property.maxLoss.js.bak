const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Invariant: maxLossBps never exceeds 1000 (10%)", function () {
  let flash, deployer, mockProvider;
  const DUMMY_ROUTER = "0x0000000000000000000000000000000000000002";

  before(async () => {
    [deployer] = await ethers.getSigners();

    // deploy MockProvider, returning deployer.address as the “pool”
    const Mock = await ethers.getContractFactory("MockProvider");
    mockProvider = await Mock.deploy(deployer.address);
    await mockProvider.deployed();

    const Arb = await ethers.getContractFactory("ArbitrageFlashloan");
    flash = await Arb.deploy(mockProvider.address, DUMMY_ROUTER, DUMMY_ROUTER);
    await flash.deployed();
  });

  it("reverts if you try to set maxLossBps > 1000", async () => {
    await expect(flash.setMaxLossBps(1001)).to.be.revertedWith("too generous");
  });

  it("accepts maxLossBps = 1000", async () => {
    await flash.setMaxLossBps(1000);
    expect(await flash.maxLossBps()).to.equal(1000);
  });

  it("never allows maxLossBps to drift above 1000", async () => {
    for (const bps of [0, 500, 1000]) {
      await flash.setMaxLossBps(bps);
      expect(await flash.maxLossBps()).to.be.at.most(1000);
    }
  });
});
