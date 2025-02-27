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
<<<<<<< HEAD
  solidity: "0.8.20", // Specify the Solidity compiler version
=======
  defaultNetwork: "hardhat",
>>>>>>> fb927c21 (Major upgrades since last push)
  networks: {
    hardhat: {
      forking: {
        url: RPC_URL_MAINNET, // Use the HTTP RPC URL for forking
      },
<<<<<<< HEAD
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
=======
      chainId: 1337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 1337,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL || "",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 11155111,
    },
    mainnet: {
      url: MAINNET_RPC_URL || "",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  solidity: {
    version: "0.8.17",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY || "",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 20000,
  },
>>>>>>> fb927c21 (Major upgrades since last push)
};
