// scripts/deployMockToken.js

const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying contracts with the account:", deployer.address);
    console.log("Account balance:", ethers.utils.formatEther(await deployer.getBalance()), "ETH");

    const MockToken = await ethers.getContractFactory("MockToken");
    const mockToken = await MockToken.deploy(deployer.address); // Pass deployer as initialOwner
    await mockToken.deployed();

    console.log("MockToken deployed at:", mockToken.address);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Error in deployMockToken script:", error);
        process.exit(1);
    });
