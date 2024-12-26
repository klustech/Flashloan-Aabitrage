// scripts/checkMockTokenBalance.js

const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deployer address:", deployer.address);

    const mockTokenAddress = process.env.MOCK_TOKEN_ADDRESS
        ? ethers.utils.getAddress(process.env.MOCK_TOKEN_ADDRESS)
        : null;

    if (!mockTokenAddress) {
        throw new Error("MOCK_TOKEN_ADDRESS is not set in the .env file.");
    }

    const erc20ABI = [
        "function balanceOf(address account) external view returns (uint256)"
    ];

    const mockToken = new ethers.Contract(mockTokenAddress, erc20ABI, deployer);

    const balance = await mockToken.balanceOf(deployer.address);
    console.log(`Deployer MockToken Balance: ${ethers.utils.formatUnits(balance, 18)} MockTokens`);
}

main().catch((error) => {
    console.error("Error in checkMockTokenBalance script:", error);
    process.exit(1);
});
