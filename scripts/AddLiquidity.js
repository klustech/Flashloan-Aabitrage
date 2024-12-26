// scripts/AddLiquidity.js

const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Adding liquidity with the account:", deployer.address);
    console.log("Account balance:", ethers.utils.formatEther(await deployer.getBalance()), "ETH");

    // Fetch and validate addresses from environment variables
    const routerAddress = process.env.ROUTER_ADDRESS
        ? ethers.utils.getAddress(process.env.ROUTER_ADDRESS)
        : null; // Uniswap V2 Router
    const factoryAddress = process.env.FACTORY_ADDRESS
        ? ethers.utils.getAddress(process.env.FACTORY_ADDRESS)
        : null; // Uniswap V2 Factory
    const baseTokenAddress = process.env.BASE_TOKEN_ADDRESS
        ? ethers.utils.getAddress(process.env.BASE_TOKEN_ADDRESS)
        : null; // WETH
    const mockTokenAddress = process.env.MOCK_TOKEN_ADDRESS
        ? ethers.utils.getAddress(process.env.MOCK_TOKEN_ADDRESS)
        : null; // MockToken

    // Validate that all necessary addresses are provided
    if (!routerAddress || !factoryAddress || !baseTokenAddress || !mockTokenAddress) {
        throw new Error("One or more required contract addresses are missing in the .env file.");
    }

    // ABIs
    const routerABI = [
        "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external payable returns (uint amountToken, uint amountETH, uint liquidity)",
        "function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)"
    ];

    const erc20ABI = [
        "function approve(address spender, uint256 amount) external returns (bool)",
        "function balanceOf(address account) external view returns (uint256)"
    ];

    // Instantiate contract instances using their ABIs
    const router = new ethers.Contract(routerAddress, routerABI, deployer);
    const mockToken = new ethers.Contract(mockTokenAddress, erc20ABI, deployer);
    const baseToken = new ethers.Contract(baseTokenAddress, erc20ABI, deployer);

    // Approve router to spend MockToken
    const amountTokenDesired = ethers.utils.parseUnits("1000", 18); // 1000 MockTokens
    const approvalTx = await mockToken.approve(routerAddress, amountTokenDesired);
    console.log(`Approving ${ethers.utils.formatUnits(amountTokenDesired, 18)} MockTokens for Router...`);
    await approvalTx.wait();
    console.log("Approval transaction confirmed.");

    // Define slippage and deadline
    const slippage = 5; // 5%
    const amountTokenMin = amountTokenDesired.mul(100 - slippage).div(100); // 95% of desired
    const amountETHMin = ethers.utils.parseEther("0.05"); // Minimum ETH to add

    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from now

    // Amount of ETH to add
    const amountETH = ethers.utils.parseEther("1"); // 1 ETH

    console.log("Adding liquidity to Uniswap V2...");

    // Execute addLiquidityETH
    try {
        const tx = await router.addLiquidityETH(
            mockTokenAddress,
            amountTokenDesired,
            amountTokenMin,
            amountETHMin,
            deployer.address,
            deadline,
            {
                value: amountETH,
                gasPrice: ethers.utils.parseUnits('50', 'gwei'), // Adjust as needed
                gasLimit: 300000
            }
        );

        console.log(`Transaction submitted: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log("Liquidity added successfully!");
        console.log(`Transaction Receipt:`, receipt);
    } catch (error) {
        console.error("Error adding liquidity:", error.reason || error.message);
    }
}

main().catch((error) => {
    console.error("Error in AddLiquidity script:", error);
    process.exit(1);
});
