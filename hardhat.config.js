// Use the lockfile-pinned local Solidity compiler; no compiler download required.
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, TASK_TEST_GET_TEST_FILES } = require("hardhat/builtin-tasks/task-names");
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }, _hre, runSuper) => {
  if (solcVersion === "0.8.20") return { compilerPath: require.resolve("solc/soljson.js"), isSolcJs: true, version: solcVersion, longVersion: require("solc").version() };
  return runSuper();
});
require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-etherscan");
require("solidity-coverage");
require("hardhat-gas-reporter");
require("hardhat-deploy");
require("hardhat-contract-sizer");
require("dotenv").config({ override: false });

// node:test owns *.node.test.js; mixing it with Mocha can hide failed tests.
subtask(TASK_TEST_GET_TEST_FILES).setAction(async (args, _hre, runSuper) => {
  if (args.testFiles.some(file => file.endsWith(".node.test.js"))) {
    throw new Error("Run *.node.test.js with npm run test:core or node --test, not hardhat test.");
  }
  const files = await runSuper(args);
  return files.filter(file => !file.endsWith(".node.test.js"));
});

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
  ENABLE_MAINNET_FORK,
} = process.env;

const isForkingEnabled = String(ENABLE_MAINNET_FORK || "").toLowerCase() === "true";

const toBlockNumber = (blockNumberEnv, fallback) => {
  if (blockNumberEnv) {
    const parsed = parseInt(blockNumberEnv, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const buildForkingConfig = (networkLabel, rpcUrl, blockNumberEnv, fallbackBlock) => {
  if (!isForkingEnabled) {
    return undefined;
  }
  if (!rpcUrl) {
    console.warn(
      `[hardhat.config] ENABLE_MAINNET_FORK=true but missing ${networkLabel} RPC URL. Forking disabled for ${networkLabel}.`
    );
    return undefined;
  }

  const forkingConfig = { url: rpcUrl };
  const blockNumber = toBlockNumber(blockNumberEnv, fallbackBlock);
  if (blockNumber) {
    forkingConfig.blockNumber = blockNumber;
  }
  return forkingConfig;
};

const mainnetForkingConfig = buildForkingConfig(
  "mainnet",
  MAINNET_RPC_URL,
  FORK_BLOCK_NUMBER,
  17_000_000
);

const arbitrumForkingConfig = buildForkingConfig(
  "arbitrum",
  ARB_RPC_URL,
  ARB_FORK_BLOCK_NUMBER,
  17_000_000
);

const optimismForkingConfig = buildForkingConfig(
  "optimism",
  OP_RPC_URL,
  OP_FORK_BLOCK_NUMBER,
  17_000_000
);

module.exports = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      chainId: 1337,
      allowUnlimitedContractSize: true,
      ...(mainnetForkingConfig ? { forking: mainnetForkingConfig } : {}),
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
    ...(arbitrumForkingConfig
      ? {
          arbitrumFork: {
            chainId: 42161,
            allowUnlimitedContractSize: true,
            forking: arbitrumForkingConfig,
          },
        }
      : {}),
    ...(optimismForkingConfig
      ? {
          optimismFork: {
            chainId: 10,
            allowUnlimitedContractSize: true,
            forking: optimismForkingConfig,
          },
        }
      : {}),
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
