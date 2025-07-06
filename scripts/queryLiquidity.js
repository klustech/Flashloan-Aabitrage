// scripts/queryLiquidity.js
require("dotenv").config({ override: true });
const { ethers } = require("ethers");

// Minimal ERC20 ABI containing only balanceOf
const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
];

// Minimal ABI for Aave Lending Pool Address Provider to get the lending pool address
const AAVE_PROVIDER_ABI = ["function getLendingPool() view returns (address)"];

async function main() {
  // Create an ethers provider using your MAINNET_RPC_URL from .env
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.MAINNET_RPC_URL
  );

  // Get the DAI token contract address from .env (TOKENS_DAI)
  const daiAddress = process.env.TOKENS_DAI;
  if (!daiAddress) {
    throw new Error("TOKENS_DAI not set in .env");
  }
  const daiContract = new ethers.Contract(daiAddress, ERC20_ABI, provider);

  // Get the Aave Lending Pool Address Provider from .env
  const aaveProviderAddress = process.env.AAVE_LENDING_POOL_ADDRESS_PROVIDER;
  if (!aaveProviderAddress) {
    throw new Error("AAVE_LENDING_POOL_ADDRESS_PROVIDER not set in .env");
  }
  const aaveProvider = new ethers.Contract(
    aaveProviderAddress,
    AAVE_PROVIDER_ABI,
    provider
  );

  // Retrieve the lending pool address from the provider
  const lendingPoolAddress = await aaveProvider.getLendingPool();
  console.log("Aave Lending Pool Address:", lendingPoolAddress);

  // Query the DAI balance of the lending pool
  const balance = await daiContract.balanceOf(lendingPoolAddress);
  const formattedBalance = ethers.utils.formatUnits(balance, 18);
  console.log("DAI Balance in Lending Pool:", formattedBalance, "DAI");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
