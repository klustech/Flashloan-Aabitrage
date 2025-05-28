// scripts/deploy.js

const { ethers } = require("hardhat");
require("dotenv").config();

async function main() {
  const { AAVE_LENDING_POOL_ADDRESS_PROVIDER, GAS_PRICE_CEILING } = process.env;

  const uniswapRouterAddress = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D"; // Uniswap V2 Router02
  const sushiSwapRouterAddress = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F"; // SushiSwap Router

  try {
    const formattedAddressesProvider = ethers.utils.getAddress(
      AAVE_LENDING_POOL_ADDRESS_PROVIDER
    );
    const formattedUniswapRouter =
      ethers.utils.getAddress(uniswapRouterAddress);
    const formattedSushiSwapRouter = ethers.utils.getAddress(
      sushiSwapRouterAddress
    );

    console.log("Deploying ArbitrageFlashloan with the following parameters:");
    console.log(`AddressesProvider: ${formattedAddressesProvider}`);
    console.log(`Uniswap Router: ${formattedUniswapRouter}`);
    console.log(`SushiSwap Router: ${formattedSushiSwapRouter}`);

    const feeData = await ethers.provider.getFeeData();
    const maxFeePerGas = ethers.utils.parseUnits("30", "gwei");
    const maxPriorityFeePerGas = ethers.utils.parseUnits("2", "gwei");

    console.log(
      `Current maxFeePerGas: ${ethers.utils.formatUnits(
        feeData.maxFeePerGas || 0,
        "gwei"
      )} gwei`
    );
    console.log(
      `Setting maxFeePerGas to: ${ethers.utils.formatUnits(
        maxFeePerGas,
        "gwei"
      )} gwei`
    );
    console.log(
      `Setting maxPriorityFeePerGas to: ${ethers.utils.formatUnits(
        maxPriorityFeePerGas,
        "gwei"
      )} gwei`
    );

    const network = await ethers.provider.getNetwork();
    console.log(
      `Deploying on network: ${network.name} (chainId: ${network.chainId})`
    );

    const ArbitrageFlashloan = await ethers.getContractFactory(
      "ArbitrageFlashloan"
    );
    const arbitrageFlashloan = await ArbitrageFlashloan.deploy(
      formattedAddressesProvider,
      formattedUniswapRouter,
      formattedSushiSwapRouter,
      {
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
      }
    );

    await arbitrageFlashloan.deployed();
    console.log("ArbitrageFlashloan deployed at:", arbitrageFlashloan.address);
  } catch (error) {
    console.error("Error during deployment:", error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment script failed:", error);
    process.exit(1);
  });
