/**
 * server/config/networkConfig.js
 *
 * Multi-Network Configuration for Flash Loan Arbitrage Bot
 * Contains token addresses, router addresses, and DEX configurations
 * for all supported networks.
 */

// Network Chain IDs
const CHAIN_IDS = {
  ethereum: 1,
  goerli: 5,
  sepolia: 11155111,
  arbitrum: 42161,
  arbitrumGoerli: 421613,
  optimism: 10,
  optimismGoerli: 420,
  polygon: 137,
  polygonMumbai: 80001,
  base: 8453,
  baseGoerli: 84531,
};

// Token Configurations per Network
const TOKENS = {
  ethereum: {
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    DAI: "0x6B175474E89094C44Da98b954EesaDCAE3686f72E2",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    AAVE: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    CRV: "0xD533a949740bb3306d119CC777fa900bA034cd52",
    MKR: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
    COMP: "0xc00e94Cb662C3520282E6f5717214004A7f26888",
    SNX: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
    SUSHI: "0x6B3595068778DD592e39A122f4f5a5cF09C90fE2",
    BAL: "0xba100000625a3754423978a60c9317c58a424e3D",
    YFI: "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e",
  },
  arbitrum: {
    WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    USDC: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
    USDT: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    WBTC: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    UNI: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0",
    LINK: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4",
    ARB: "0x912CE59144191C1204E64559FE8253a0e49E6548",
    GMX: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a",
    MAGIC: "0x539bdE0d7Dbd336b79148AA742883198BBF60342",
  },
  optimism: {
    WETH: "0x4200000000000000000000000000000000000006",
    DAI: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    USDC: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
    USDT: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    WBTC: "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
    OP: "0x4200000000000000000000000000000000000042",
    SNX: "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4",
    LINK: "0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6",
  },
  polygon: {
    WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
    LINK: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
    AAVE: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",
  },
  base: {
    WETH: "0x4200000000000000000000000000000000000006",
    DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    USDC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  },
  sepolia: {
    WETH: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    DAI: "0x68194a729C2450ad26072b3D33ADaCbcef39D574",
    USDC: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8",
    LINK: "0x779877A7B0D9E8603169DdbD7836e478b4624789",
  },
};

// DEX Router Configurations per Network
const DEX_ROUTERS = {
  ethereum: {
    uniswap_v2: {
      router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
      factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
      initCodeHash: "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f",
    },
    uniswap_v3: {
      router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
      router2: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    },
    sushiswap: {
      router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
      factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
      initCodeHash: "0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303",
    },
    balancer: {
      vault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
    },
    curve: {
      registry: "0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5",
      addressProvider: "0x0000000022D53366457F9d5E68Ec105046FC4383",
      metaRegistry: "0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC",
    },
  },
  arbitrum: {
    uniswap_v3: {
      router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
      router2: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    },
    sushiswap: {
      router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
      factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
    },
    balancer: {
      vault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
    },
    camelot: {
      router: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d",
      factory: "0x6EcCab422D763aC031210895C81787E87B43A652",
    },
    gmx: {
      router: "0xaBBc5F99639c9B6bCb58544ddf04EFA6802F4064",
      vault: "0x489ee077994B6658eAfA855C308275EAd8097C4A",
    },
  },
  optimism: {
    uniswap_v3: {
      router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
      router2: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    },
    velodrome: {
      router: "0x9c12939390052919aF3155f41Bf4160Fd3666A6f",
      factory: "0x25CbdDb98b35ab1FF77413456B31EC81A6B6B746",
    },
    synthetix: {
      exchanger: "0x6330D5F08f51057F36F46d6751eCDc0c65Ef7E9e",
    },
  },
  polygon: {
    uniswap_v3: {
      router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
      router2: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoter: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    },
    quickswap: {
      router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
      factory: "0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32",
    },
    sushiswap: {
      router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
      factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
    },
    balancer: {
      vault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
    },
    curve: {
      addressProvider: "0x0000000022D53366457F9d5E68Ec105046FC4383",
    },
  },
  base: {
    uniswap_v3: {
      router: "0x2626664c2603336E57B271c5C0b26F421741e481",
      quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
      factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    },
    aerodrome: {
      router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
      factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
    },
  },
};

// Aave Lending Pool Configurations
const AAVE_CONFIG = {
  ethereum: {
    v2: {
      lendingPoolAddressProvider: "0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5",
      lendingPool: "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9",
    },
    v3: {
      poolAddressProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
      pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    },
  },
  arbitrum: {
    v3: {
      poolAddressProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    },
  },
  optimism: {
    v3: {
      poolAddressProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    },
  },
  polygon: {
    v2: {
      lendingPoolAddressProvider: "0xd05e3E715d945B59290df0ae8eF85c1BdB684744",
      lendingPool: "0x8dFf5E27EA6b7AC08EbFdf9eB090F32ee9a30fcf",
    },
    v3: {
      poolAddressProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
      pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    },
  },
  base: {
    v3: {
      poolAddressProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
      pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    },
  },
};

// Connext Cross-Chain Bridge Configuration
const CONNEXT_CONFIG = {
  ethereum: {
    connext: "0x8898B472C54c31894e3B9bb83cEA802a5d0e63C6",
    domain: 6648936,
  },
  arbitrum: {
    connext: "0xEE9deC2712cCE65174B561151701Bf54b99C24C8",
    domain: 1634886255,
  },
  optimism: {
    connext: "0x8f7492DE823025b4CfaAB1D34c58963F2af5DEDA",
    domain: 1869640809,
  },
  polygon: {
    connext: "0x11984dc4465481512eb5b777E44061C158CF2259",
    domain: 1886350457,
  },
  base: {
    connext: "0xB8448C6f7f7887D36DcA487370778e419e9ebE3F",
    domain: 1650553709,
  },
};

// Flashbots Relay URLs
const FLASHBOTS_RELAYS = {
  ethereum: [
    "https://relay.flashbots.net",
    "https://rpc.beaverbuild.org",
    "https://builder0x69.io",
    "https://rpc.titanbuilder.xyz",
  ],
  goerli: [
    "https://relay-goerli.flashbots.net",
  ],
};

// Gas Estimation Defaults per Network
const GAS_DEFAULTS = {
  ethereum: {
    maxPriorityFeePerGas: "2000000000", // 2 gwei
    maxFeePerGas: "100000000000", // 100 gwei ceiling
    gasLimit: 500000,
  },
  arbitrum: {
    maxPriorityFeePerGas: "0",
    maxFeePerGas: "1000000000", // 1 gwei
    gasLimit: 3000000,
  },
  optimism: {
    maxPriorityFeePerGas: "1000000",
    maxFeePerGas: "1000000000",
    gasLimit: 1000000,
  },
  polygon: {
    maxPriorityFeePerGas: "30000000000", // 30 gwei
    maxFeePerGas: "500000000000", // 500 gwei
    gasLimit: 500000,
  },
  base: {
    maxPriorityFeePerGas: "1000000",
    maxFeePerGas: "1000000000",
    gasLimit: 500000,
  },
};

// RPC Endpoints (use environment variables in production)
const RPC_DEFAULTS = {
  ethereum: process.env.MAINNET_RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/your-api-key",
  arbitrum: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
  optimism: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
  polygon: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
  base: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  sepolia: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
};

// Token Decimals (common tokens)
const TOKEN_DECIMALS = {
  WETH: 18,
  DAI: 18,
  USDC: 6,
  USDT: 6,
  WBTC: 8,
  UNI: 18,
  LINK: 18,
  AAVE: 18,
  CRV: 18,
  WMATIC: 18,
  ARB: 18,
  OP: 18,
  GMX: 18,
};

/**
 * Get configuration for a specific network
 * @param {string} network - Network name (ethereum, arbitrum, optimism, polygon, base)
 * @returns {Object} Network configuration
 */
function getNetworkConfig(network) {
  const normalizedNetwork = network.toLowerCase();

  return {
    chainId: CHAIN_IDS[normalizedNetwork],
    tokens: TOKENS[normalizedNetwork] || {},
    dexRouters: DEX_ROUTERS[normalizedNetwork] || {},
    aave: AAVE_CONFIG[normalizedNetwork] || {},
    connext: CONNEXT_CONFIG[normalizedNetwork] || {},
    flashbotsRelays: FLASHBOTS_RELAYS[normalizedNetwork] || [],
    gasDefaults: GAS_DEFAULTS[normalizedNetwork] || GAS_DEFAULTS.ethereum,
    rpcUrl: RPC_DEFAULTS[normalizedNetwork],
  };
}

/**
 * Get token address for a specific token on a network
 * @param {string} network - Network name
 * @param {string} symbol - Token symbol (e.g., "WETH", "DAI")
 * @returns {string|null} Token address or null if not found
 */
function getTokenAddress(network, symbol) {
  const normalizedNetwork = network.toLowerCase();
  const normalizedSymbol = symbol.toUpperCase();
  return TOKENS[normalizedNetwork]?.[normalizedSymbol] || null;
}

/**
 * Get DEX router address
 * @param {string} network - Network name
 * @param {string} dex - DEX identifier (e.g., "uniswap_v2", "sushiswap")
 * @returns {Object|null} DEX configuration or null if not found
 */
function getDexConfig(network, dex) {
  const normalizedNetwork = network.toLowerCase();
  const normalizedDex = dex.toLowerCase();
  return DEX_ROUTERS[normalizedNetwork]?.[normalizedDex] || null;
}

/**
 * Get all supported tokens for a network
 * @param {string} network - Network name
 * @returns {string[]} Array of token symbols
 */
function getSupportedTokens(network) {
  const normalizedNetwork = network.toLowerCase();
  return Object.keys(TOKENS[normalizedNetwork] || {});
}

/**
 * Get all supported DEXes for a network
 * @param {string} network - Network name
 * @returns {string[]} Array of DEX identifiers
 */
function getSupportedDexes(network) {
  const normalizedNetwork = network.toLowerCase();
  return Object.keys(DEX_ROUTERS[normalizedNetwork] || {});
}

/**
 * Get all supported networks
 * @returns {string[]} Array of network names
 */
function getSupportedNetworks() {
  return Object.keys(CHAIN_IDS);
}

/**
 * Validate network configuration
 * @param {string} network - Network name
 * @returns {Object} Validation result { valid: boolean, errors: string[] }
 */
function validateNetworkConfig(network) {
  const errors = [];
  const config = getNetworkConfig(network);

  if (!config.chainId) {
    errors.push(`Unknown network: ${network}`);
    return { valid: false, errors };
  }

  if (!config.tokens || Object.keys(config.tokens).length === 0) {
    errors.push(`No tokens configured for ${network}`);
  }

  if (!config.dexRouters || Object.keys(config.dexRouters).length === 0) {
    errors.push(`No DEX routers configured for ${network}`);
  }

  if (!config.rpcUrl) {
    errors.push(`No RPC URL configured for ${network}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  CHAIN_IDS,
  TOKENS,
  DEX_ROUTERS,
  AAVE_CONFIG,
  CONNEXT_CONFIG,
  FLASHBOTS_RELAYS,
  GAS_DEFAULTS,
  RPC_DEFAULTS,
  TOKEN_DECIMALS,
  getNetworkConfig,
  getTokenAddress,
  getDexConfig,
  getSupportedTokens,
  getSupportedDexes,
  getSupportedNetworks,
  validateNetworkConfig,
};
