// test/MockToken.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MockToken", function () {
    let MockToken;
    let mockToken;
    let deployer;

    beforeEach(async function () {
        [deployer] = await ethers.getSigners();
        MockToken = await ethers.getContractFactory("MockToken");
        mockToken = await MockToken.deploy(deployer.address);
        await mockToken.deployed();
    });

    it("Should assign the total supply to the deployer", async function () {
        const deployerBalance = await mockToken.balanceOf(deployer.address);
        expect(deployerBalance).to.equal(ethers.utils.parseUnits("1000000", 18));
    });

    it("Should have correct name and symbol", async function () {
        expect(await mockToken.name()).to.equal("MockToken");
        expect(await mockToken.symbol()).to.equal("MKT");
    });

    it("Should allow transfers", async function () {
        const recipient = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199";
        const transferAmount = ethers.utils.parseUnits("100", 18);

        await mockToken.transfer(recipient, transferAmount);
        const recipientBalance = await mockToken.balanceOf(recipient);
        expect(recipientBalance).to.equal(transferAmount);
    });
});
