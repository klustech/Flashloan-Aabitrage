require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-etherscan");
require("solidity-coverage");
require("dotenv").config();

const { PRIVATE_KEY, SEPOLIA_RPC_URL, MAINNET_RPC_URL, ETHERSCAN_API_KEY } =
  process.env;

module.exports = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      // fork _once_ at startup
      forking: {
        url: MAINNET_RPC_URL,
        blockNumber: 17_000_000,
      },
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
    compilers: [
      {
        version: "0.8.20",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
      {
        version: "0.8.17",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    ],
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
  coverage: {
    skipFiles: ["mocks/", "interfaces/"],
  },
};
