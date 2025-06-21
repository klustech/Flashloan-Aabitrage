// scripts/queryReserveData.js
require("dotenv").config();
const { ethers } = require("ethers");

// Minimal ABI for Aave Lending Pool Address Provider
const AAVE_PROVIDER_ABI = ["function getLendingPool() view returns (address)"];

// Minimal ABI for Aave Lending Pool's getReserveData function
// The returned tuple structure is based on Aave V2 documentation.
const LENDING_POOL_ABI = [
  "function getReserveData(address asset) view returns (" +
    "tuple(" +
    "uint256 configuration, " +
    "uint128 liquidityIndex, " +
    "uint128 variableBorrowIndex, " +
    "uint128 currentLiquidityRate, " +
    "uint128 currentVariableBorrowRate, " +
    "uint128 currentStableBorrowRate, " +
    "uint40 lastUpdateTimestamp, " +
    "address aTokenAddress, " +
    "address stableDebtTokenAddress, " +
    "address variableDebtTokenAddress, " +
    "address interestRateStrategyAddress, " +
    "uint8 id" +
    ")" +
    ")",
];

async function main() {
  // Create provider using your MAINNET_RPC_URL
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.MAINNET_RPC_URL
  );

  // Addresses from .env
  const aaveProviderAddress = process.env.AAVE_LENDING_POOL_ADDRESS_PROVIDER;
  const daiAddress = process.env.TOKENS_DAI;

  if (!aaveProviderAddress || !daiAddress) {
    throw new Error(
      "Missing AAVE_LENDING_POOL_ADDRESS_PROVIDER or TOKENS_DAI in .env"
    );
  }

  // Create contract instance for Aave Lending Pool Address Provider
  const aaveProvider = new ethers.Contract(
    aaveProviderAddress,
    AAVE_PROVIDER_ABI,
    provider
  );

  // Get the Lending Pool address
  const lendingPoolAddress = await aaveProvider.getLendingPool();
  console.log("Aave Lending Pool Address:", lendingPoolAddress);

  // Create a contract instance for the Lending Pool
  const lendingPool = new ethers.Contract(
    lendingPoolAddress,
    LENDING_POOL_ABI,
    provider
  );

  // Query reserve data for DAI
  const reserveData = await lendingPool.getReserveData(daiAddress);

  console.log("Reserve Data for DAI:");
  console.log("Configuration:", reserveData.configuration.toString());
  console.log("Liquidity Index:", reserveData.liquidityIndex.toString());
  console.log(
    "Variable Borrow Index:",
    reserveData.variableBorrowIndex.toString()
  );
  console.log(
    "Current Liquidity Rate:",
    reserveData.currentLiquidityRate.toString()
  );
  console.log(
    "Current Variable Borrow Rate:",
    reserveData.currentVariableBorrowRate.toString()
  );
  console.log(
    "Current Stable Borrow Rate:",
    reserveData.currentStableBorrowRate.toString()
  );
  console.log(
    "Last Update Timestamp:",
    reserveData.lastUpdateTimestamp.toString()
  );
  console.log("aToken Address:", reserveData.aTokenAddress);
  console.log("Stable Debt Token Address:", reserveData.stableDebtTokenAddress);
  console.log(
    "Variable Debt Token Address:",
    reserveData.variableDebtTokenAddress
  );
  console.log(
    "Interest Rate Strategy Address:",
    reserveData.interestRateStrategyAddress
  );
  console.log("Reserve ID:", reserveData.id.toString());
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
