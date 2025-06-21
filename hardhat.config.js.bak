require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-etherscan");
require("solidity-coverage");
require("hardhat-gas-reporter");
require("hardhat-deploy");
require("hardhat-contract-sizer");
require("dotenv").config();

const {
  PRIVATE_KEY,
  SEPOLIA_RPC_URL,
  MAINNET_RPC_URL,
  ETHERSCAN_API_KEY,
  REPORT_GAS,
  FORK_BLOCK_NUMBER,
  BSC_RPC_URL,
  POLYGON_RPC_URL,
  ARB_RPC_URL,
  OP_RPC_URL,
  ARB_FORK_BLOCK_NUMBER,
  OP_FORK_BLOCK_NUMBER,
} = process.env;

module.exports = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      forking: {
        url: MAINNET_RPC_URL || "",
        blockNumber: FORK_BLOCK_NUMBER
          ? parseInt(FORK_BLOCK_NUMBER, 10)
          : 17000000,
      },
      chainId: 1337,
      allowUnlimitedContractSize: true,
    },
    localhost: {
      url: process.env.LOCALHOST_RPC_URL || "http://127.0.0.1:8545",
      chainId: 1337,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      allowUnlimitedContractSize: true,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL || "",
      chainId: 11155111,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    mainnet: {
      url: MAINNET_RPC_URL || "",
      chainId: 1,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    bsc: {
      url: BSC_RPC_URL || "",
      chainId: 56,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    polygon: {
      url: POLYGON_RPC_URL || "",
      chainId: 137,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    arbitrum: {
      url: ARB_RPC_URL || "",
      chainId: 42161,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    optimism: {
      url: OP_RPC_URL || "",
      chainId: 10,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    arbitrumFork: {
      url: MAINNET_RPC_URL || "",
      forking: {
        url: ARB_RPC_URL || "",
        blockNumber: ARB_FORK_BLOCK_NUMBER
          ? parseInt(ARB_FORK_BLOCK_NUMBER, 10)
          : 17000000,
      },
      chainId: 42161,
      allowUnlimitedContractSize: true,
    },
    optimismFork: {
      url: MAINNET_RPC_URL || "",
      forking: {
        url: OP_RPC_URL || "",
        blockNumber: OP_FORK_BLOCK_NUMBER
          ? parseInt(OP_FORK_BLOCK_NUMBER, 10)
          : 17000000,
      },
      chainId: 10,
      allowUnlimitedContractSize: true,
    },
  },
  namedAccounts: {
    deployer: {
      default: 0,
    },
  },
  solidity: {
    compilers: [
      {
        version: "0.8.20",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          metadata: { bytecodeHash: "ipfs" },
        },
      },
      {
        version: "0.8.17",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
      {
        version: "0.8.0",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    ],
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
    deploy: "./deploy",
  },
  mocha: {
    timeout: 200000,
    bail: false,
  },
  gasReporter: {
    enabled: REPORT_GAS === "true",
    currency: "USD",
    gasPrice: 100,
    outputFile: "gas-report.txt",
    noColors: true,
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY || "",
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: false,
    disambiguatePaths: false,
  },
  typechain: {
    outDir: "typechain",
    target: "ethers-v5",
  },
  solidityCoverage: {
    skipFiles: ["mocks/", "interfaces/"],
  },
};
