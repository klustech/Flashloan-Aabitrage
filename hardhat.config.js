// hardhat.config.js

require("@nomiclabs/hardhat-ethers");  // Interact with ethers.js
require("@nomiclabs/hardhat-waffle"); // Waffle testing library
require("dotenv").config();

const {
  RPC_URL_MAINNET,
  SEPOLIA_URL,
  PRIVATE_KEY,
} = process.env;

// Validate essential environment variables
if (!RPC_URL_MAINNET || !SEPOLIA_URL || !PRIVATE_KEY) {
  throw new Error("Please ensure RPC_URL_MAINNET, SEPOLIA_URL, and PRIVATE_KEY are set in your .env file.");
}

module.exports = {
  solidity: "0.8.20", // Specify the Solidity compiler version
  networks: {
    hardhat: {
      forking: {
        url: RPC_URL_MAINNET, // Use the HTTP RPC URL for forking
      },
      chainId: 31337, // Updated Chain ID for Hardhat local network
    },
    sepolia: {
      url: SEPOLIA_URL, // Sepolia RPC URL
      accounts: [PRIVATE_KEY], // Use the private key directly without adding '0x'
      chainId: 11155111, // Sepolia Chain ID
    },
    mainnet: {
      url: RPC_URL_MAINNET, // Mainnet RPC URL
      accounts: [PRIVATE_KEY], // Use the private key directly without adding '0x'
      chainId: 1, // Ethereum mainnet Chain ID
    },
  },
};
