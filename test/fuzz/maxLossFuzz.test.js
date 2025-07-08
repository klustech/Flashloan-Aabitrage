const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Fuzz: setMaxLossBps", function () {
  let flash;
  before(async () => {
    const Arb = await ethers.getContractFactory("ArbitrageFlashloan");
    flash = await Arb.deploy(
      "0x0000000000000000000000000000000000000001",
      100,
      9
    );
    await flash.deployed();
  });

  it("never allows value above limit", async () => {
    for (let i = 0; i < 20; i++) {
      const val = Math.floor(Math.random() * 2000);
      if (val > 1000) {
        await expect(flash.setMaxLossBps(val)).to.be.reverted;
      } else {
        await flash.setMaxLossBps(val);
        expect(await flash.maxLossBps()).to.equal(val);
      }
    }
  });
});
