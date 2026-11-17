/**
 * server/botLogic.js
 *
 * Main bot logic for Flashloan Arbitrage (Updated to N-hop SwapData per blueprint),
 * adjusted so helper requires point into server/scripts/, and using minimal router ABIs
 * (instead of loading Quoter.json, which is not a valid router ABI).
 *
 * Added comprehensive logger.info statements at each major step.
 */

const runtimeConfig = require("./utils/runtimeConfig");
const { exitAfterFatal } = require("./utils/fatalExit");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const winston = require("winston");
const { ethers, BigNumber } = require("ethers");
const { env: envConfig, optional, features } = runtimeConfig;
const {
  FlashbotsBundleProvider,
} = require("@flashbots/ethers-provider-bundle");
const { Worker } = require("worker_threads");
const stats = require("simple-statistics");
const {
  arbAttempts,
  arbSuccess,
  arbFailure,
  avgLatency,
  avgProfit,
  simulationHistogram,
  rlEpsilon,
  rlAction,
} = require("./metricsRegistry");
function createDisabledSlippageAgent() {
  return {
    epsilon: 0,
    lastAction: 0,
    continuous: false,
    actions: [],
    select(baseBips) {
      this.lastAction = 0;
      return baseBips;
    },
    update() {},
    resetPolicy() {
      this.epsilon = 0;
      this.lastAction = 0;
    },
  };
}

let slippageAgent = features.reinforcementLearning
  ? require("./rl/slippageAgent")
  : createDisabledSlippageAgent();

if (!features.reinforcementLearning) {
  rlAction.set(0);
  rlEpsilon.set(0);
}
const { initSlippageAgent } = require("./rl/slippageAgent");

// ─────────────────────────────────────────────────────────────────────────────
// Imports: Connext Cross-Chain Profit Forwarding
// ─────────────────────────────────────────────────────────────────────────────
const {
  initConnextClient,
  forwardProfits,
  checkAutoForward,
  tokenDecimals,
  getAccumulatedProfits,
  getDestinationInfo,
  checkTransferStatus,
  getTransferHistory,
  getPendingTransfers,
  TransferStatus,
} = require("./scripts/connextClient");

// Connext state
let connextInitialized = false;
let connextConfig = null;
let connextAutoForwardEnabled = false;

// ─────────────────────────────────────────────────────────────────────────────
// Imports: Tier-1 Competitive Features
// ─────────────────────────────────────────────────────────────────────────────
const {
  riskManager,
  validateTrade,
  recordTrade,
  getPerformanceReport,
} = require("./scripts/riskManager");
const {
  rpcManager,
  initializeFromEnv: initRpcManager,
  getPrimaryProvider,
  executeWithFailover,
} = require("./scripts/rpcManager");
const {
  submitToAllRelays,
  submitBundleVariants,
  getRelayStats,
} = require("./scripts/multiRelay");
const {
  calculateOptimalTip,
  generateTipVariants,
  estimateCompetitionLevel,
  analyzeGasCompetition,
} = require("./scripts/tipCalculator");
const {
  graph: incrementalGraph,
  handleSyncEvent,
  handleV3SwapEvent,
  getStats: getGraphStats,
} = require("./scripts/incrementalGraph");
const { getMempoolMonitor } = require("./scripts/mempoolMonitor");

// Tier-1 feature flags
const ENABLE_MULTI_RELAY = process.env.MULTI_RELAY_ENABLED === "true";
const ENABLE_RISK_MANAGER = process.env.RISK_MANAGER_ENABLED !== "false"; // Default enabled
const ENABLE_INCREMENTAL_GRAPH =
  process.env.INCREMENTAL_GRAPH_ENABLED === "true";
const ENABLE_MEMPOOL_MONITOR = false; // Disabled by the first production profile.
const ENABLE_DYNAMIC_TIPS = process.env.DYNAMIC_TIPS_ENABLED === "true";

// ─────────────────────────────────────────────────────────────────────────────
// Reintroduced: CoinGecko Caching & Dynamic Slippage (exactly from original)
// ─────────────────────────────────────────────────────────────────────────────
const cache = {
  coinGecko: {},
  dynamicSlippage: null,
  duration: 60_000, // 1 minute
};

/**
 *  Shared in-memory single-flight cache for CoinGecko.
 *  – Only **one** request per key can be in-flight at a time.
 *  – Successful responses are cached for `cache.duration` ms.
 *  – 429 responses trigger simple exponential back-off (0.5 s → 1 s → 2 s).
 */
const inFlightCG = {};

async function getCachedCoinGeckoPrice(coinId, vsCurrency) {
  const cacheKey = `${coinId}-${vsCurrency}`;
  const now = Date.now();

  // 1️⃣ Fresh enough?
  if (
    cache.coinGecko[cacheKey] &&
    now - cache.coinGecko[cacheKey].timestamp < cache.duration
  ) {
    return cache.coinGecko[cacheKey].data;
  }

  // 2️⃣ Someone else already fetching?  Await their promise.
  if (inFlightCG[cacheKey]) {
    return inFlightCG[cacheKey];
  }

  // 3️⃣ Launch the fetch with retry/back-off.
  inFlightCG[cacheKey] = (async () => {
    let attempt = 0;

    while (true) {
      try {
        const { data } = await axios.get(
          "https://api.coingecko.com/api/v3/simple/price",
          {
            params: {
              ids: coinId,
              vs_currencies: vsCurrency,
              include_24hr_change: "true",
            },
            timeout: 10_000,
          }
        );
        cache.coinGecko[cacheKey] = { data, timestamp: Date.now() };
        return data;
      } catch (err) {
        const status = err?.response?.status ?? 0;
        if (status !== 429 || attempt >= 3) {
          throw err; // non-rate-limit or exhausted retries
        }
        const delay = 500 * 2 ** attempt; // 0.5 s, 1 s, 2 s
        await new Promise((res) => setTimeout(res, delay));
        attempt += 1;
      }
    }
  })().finally(() => {
    // clear the promise holder no matter what
    delete inFlightCG[cacheKey];
  });

  return inFlightCG[cacheKey];
}

async function getDynamicSlippage() {
  const now = Date.now();
  if (
    cache.dynamicSlippage &&
    now - cache.dynamicSlippage.timestamp < cache.duration
  ) {
    logger.info(`Reusing cached slippage: ${cache.dynamicSlippage.value} bips`);
    return cache.dynamicSlippage.value;
  }
  try {
    const data = await getCachedCoinGeckoPrice("ethereum", "usd");
    const vol = Math.abs(data.ethereum.usd_24h_change) || 0;
    const baseDefault = parseInt(
      SLIPPAGE_DEFAULT_BIPS || OPTIONAL_ENV_DEFAULTS.SLIPPAGE_DEFAULT_BIPS,
      10
    );
    const dynamic = Math.min(baseDefault + Math.round(vol * 10), 200);
    cache.dynamicSlippage = { value: dynamic, timestamp: now };
    logger.info(`Dynamic Slippage determined: ${dynamic} bips`);
    return dynamic;
  } catch (err) {
    logger.warn(
      `Slippage fetch error (${err.message}), using default: ${parseInt(
        SLIPPAGE_DEFAULT_BIPS || OPTIONAL_ENV_DEFAULTS.SLIPPAGE_DEFAULT_BIPS,
        10
      )} bips`
    );
    return parseInt(
      SLIPPAGE_DEFAULT_BIPS || OPTIONAL_ENV_DEFAULTS.SLIPPAGE_DEFAULT_BIPS,
      10
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Imports: Route Finder & SwapData Builder (per blueprint), from server/scripts/
// ─────────────────────────────────────────────────────────────────────────────
const { getAllRoutes: routeFinder } = require("./scripts/routeFinder");
const { buildArbitrageData } = require("./scripts/swapDataBuilder");
const { getCircuitBreaker } = require("./scripts/circuitBreaker");
const {
  findOptimalInput,
  v3VirtualReserves: ammV3VirtualReserves,
} = require("./scripts/ammMath");

// ─────────────────────────────────────────────────────────────────────────────
// Imports: Price Ingestion & Multicall Cache (from server/scripts/)
// ─────────────────────────────────────────────────────────────────────────────
const {
  initSubscriptions,
  reserveCache,
  fetchMulticallReservesForRoute,
  // V3 real-time pricing
  initV3Subscriptions,
  v3PriceCache,
  // Balancer real-time pricing
  initBalancerSubscriptions,
  balancerCache,
  // Curve real-time pricing
  initCurveSubscriptions,
  curveCache,
  // Subscription stats and connection health
  getSubscriptionStats,
  getConnectionStatus,
} = require("./scripts/priceIngestion");

// ─────────────────────────────────────────────────────────────────────────────
// Imports: DEX Quote Utilities (from server/scripts/)
// ─────────────────────────────────────────────────────────────────────────────
const { getV3Quote } = require("./scripts/v3Utils");
const { getVolatility } = require("./scripts/optimalParams");
if (features.balancer) {
  ({ initBalancer, getBalancerQuote } = require("./scripts/balancerUtils"));
}
if (features.curve) {
  ({ getCurveQuote } = require("./scripts/curveUtils"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Imports: PostgreSQL Client for Trade Persistence (server/dbClient.js)
// ─────────────────────────────────────────────────────────────────────────────
const {
  insertTrade,
  pool: dbPool,
  isDbEnabled,
  waitForPoolReady,
} = require("./dbClient");

// ─────────────────────────────────────────────────────────────────────────────
// Imports: Slack Alert Utility (from server/scripts/)
// ─────────────────────────────────────────────────────────────────────────────
const { sendSlackAlert } = require("./scripts/slackUtils");
const { buildStepsFromHops } = require("../utils/buildStepsFromHops");
const safeAsync = require("../utils/safeAsync");
const eventBus = require("./utils/eventBus");

// ─────────────────────────────────────────────────────────────────────────────
// Prometheus Metrics Setup
// ─────────────────────────────────────────────────────────────────────────────
// Prometheus metrics are shared via server/metricsRegistry.js; importing here ensures
// updates from the bot leverage the same registry as the API server.

// ─────────────────────────────────────────────────────────────────────────────
// Logger Configuration
// ─────────────────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) =>
        `[${timestamp}] [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "bot.log" }),
  ],
});

// Off-chain circuit breaker — gates trading on cascading losses / failures.
const circuitBreaker = getCircuitBreaker({
  dailyDrawdownLimitDAI: parseFloat(
    process.env.DAILY_DRAWDOWN_LIMIT_DAI || "500"
  ),
});

// Helper wrapped with safeAsync using the configured logger
const safeFetchReserves = safeAsync(fetchMulticallReservesForRoute, logger);

// Log, alert, then exit: continuing after either of these leaves the process in
// an unknown state. See server/utils/fatalExit.js.
process.on("unhandledRejection", (reason) => {
  logger.error(
    `Unhandled Rejection: ${reason instanceof Error ? reason.message : reason}`
  );
  exitAfterFatal();
});

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught Exception: ${err.stack || err.message}`);
  arbFailure.labels("uncaught_exception").inc();
  Promise.resolve(
    sendSlackAlert(`Uncaught Exception in bot process: ${err.message}`)
  ).catch(() => {});
  exitAfterFatal();
});

// ─────────────────────────────────────────────────────────────────────────────
// Environment & Config (adjusted)
// ─────────────────────────────────────────────────────────────────────────────
const {
  PRIVATE_KEY,
  MAINNET_RPC_URL,
  CONTRACT_ADDRESS,
  AAVE_LENDING_POOL_ADDRESS_PROVIDER,
  TOKENS_DAI,
  TOKENS_WETH,
  UNISWAP_ROUTER_ADDRESS,
  SUSHISWAP_ROUTER_ADDRESS,
} = envConfig;

// Optional configuration defaults. These document the baseline behaviour while
// still allowing deployments to override any value via environment variables.
const OPTIONAL_ENV_DEFAULTS = {
  SLIPPAGE_BIPS: undefined,
  SLIPPAGE_DEFAULT_BIPS: "50",
  GAS_PRICE_CEILING: "50",
  FLASHBOTS_RELAY_URL: "https://relay.flashbots.net",
  MIN_PROFIT_DAI: "1",
  MIN_LIQUIDITY: "100000",
  DYNAMIC_ROUTE_HOPS: "3",
  DYNAMIC_ROUTE_MIN_LIQUIDITY_USD: "100000",
  DYNAMIC_ROUTE_TOPN: "20",
  FLASHLOAN_PREMIUM_BIPS: "9",
  INCLUDE_V3: "false",
  INCLUDE_BALANCER: "false",
  INCLUDE_CURVE: "false",
  INCLUDE_UNISWAP_V2: "true",
  INCLUDE_SUSHISWAP_V2: "true",
  REALTIME_POOL_COUNT: "100",
  ZSCORE_THRESHOLD: "2",
  ML_TOPK: "50",
  FLASHBOTS_BUNDLE_COUNT: "3",
  PRIO_PERCENT: "10",
  PRIO_FEE_MAX_GWEI: "50",
  TIP_RETRY_COUNT: "3",
  TIP_MULTIPLIER_NUM: "12",
  TIP_MULTIPLIER_DEN: "10",
  ALLOW_LNG_CYCLES: "false",
  CB_NEG_THRESHOLD: "5",
  DAILY_DRAWDOWN_LIMIT_DAI: "0",
  SLACK_WEBHOOK_URL: undefined,
  SERVER_PORT: "3000",
  TOKENS_USDC: "",
  TOKENS_USDT: "",
  TOKENS_UNI: "",
  ML_MODEL_ENDPOINT: undefined,
  RL_CONTINUOUS: "false",
  RL_MAX_OFFSET_BIPS: "40",
  RL_EPSILON_START: "0.2",
  RL_EPSILON_MIN: "0.05",
  RL_EPSILON_DECAY: "0.995",
  RL_ALPHA: "0.2",
  RL_SAVE_DEBOUNCE_MS: "200",
};

const optionalEnv = Object.fromEntries(
  Object.entries(OPTIONAL_ENV_DEFAULTS).map(([key, defaultValue]) => [
    key,
    optional(key).string(defaultValue),
  ])
);

const {
  SLIPPAGE_BIPS,
  SLIPPAGE_DEFAULT_BIPS,
  GAS_PRICE_CEILING,
  FLASHBOTS_RELAY_URL,
  MIN_PROFIT_DAI,
  MIN_LIQUIDITY,
  DYNAMIC_ROUTE_HOPS,
  DYNAMIC_ROUTE_MIN_LIQUIDITY_USD,
  DYNAMIC_ROUTE_TOPN,
  FLASHLOAN_PREMIUM_BIPS,
  INCLUDE_V3,
  INCLUDE_BALANCER,
  INCLUDE_CURVE,
  INCLUDE_UNISWAP_V2,
  INCLUDE_SUSHISWAP_V2,
  REALTIME_POOL_COUNT,
  ZSCORE_THRESHOLD,
  ML_TOPK,
  FLASHBOTS_BUNDLE_COUNT,
  PRIO_PERCENT,
  PRIO_FEE_MAX_GWEI,
  TIP_RETRY_COUNT,
  TIP_MULTIPLIER_NUM,
  TIP_MULTIPLIER_DEN,
  ALLOW_LNG_CYCLES,
  CB_NEG_THRESHOLD,
  DAILY_DRAWDOWN_LIMIT_DAI,
  SLACK_WEBHOOK_URL,
  SERVER_PORT,
  TOKENS_USDC,
  TOKENS_USDT,
  TOKENS_UNI,
  ML_MODEL_ENDPOINT,
  RL_CONTINUOUS,
  RL_MAX_OFFSET_BIPS,
  RL_EPSILON_START,
  RL_EPSILON_MIN,
  RL_EPSILON_DECAY,
  RL_ALPHA,
  RL_SAVE_DEBOUNCE_MS,
} = optionalEnv;

// Validate contract address early to avoid cryptic ethers errors
let VALID_CONTRACT_ADDRESS;
try {
  VALID_CONTRACT_ADDRESS = ethers.utils.getAddress(CONTRACT_ADDRESS);
} catch (err) {
  throw new Error(
    `Invalid CONTRACT_ADDRESS environment variable: ${CONTRACT_ADDRESS}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Providers for Ethereum, Arbitrum, Optimism
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_CHAIN = process.env.DEFAULT_CHAIN || "ethereum";

// RPC URL mapping for different networks
const NETWORK_RPC_URLS = {
  ethereum: process.env.MAINNET_RPC_URL || MAINNET_RPC_URL,
  arbitrum: process.env.ARBITRUM_RPC_URL,
  optimism: process.env.OPTIMISM_RPC_URL,
  polygon: process.env.POLYGON_RPC_URL,
  base: process.env.BASE_RPC_URL,
};

const chainContexts = new Map();

/**
 * Get chain context with network-specific configuration
 */
function getChainContext(chain) {
  if (!chainContexts.has(chain)) {
    // Get network-specific RPC URL
    const rpcUrl = NETWORK_RPC_URLS[chain] || MAINNET_RPC_URL;
    if (!rpcUrl) {
      throw new Error(`No RPC URL configured for chain: ${chain}`);
    }

    const provider = new ethers.providers.JsonRpcProvider({
      url: rpcUrl,
      timeout: 120_000,
    });
    const wallet = PRIVATE_KEY
      ? new ethers.Wallet(PRIVATE_KEY, provider)
      : provider;

    // Get network-specific DEX routers
    const dexRouters = getCachedDexRouters(chain);
    const tokens = getCachedTokenAddresses(chain);

    const context = {
      provider,
      wallet,
      chain,
      tokens,
      dexRouters,
      arbContract: new ethers.Contract(
        VALID_CONTRACT_ADDRESS,
        arbitrageABI,
        wallet
      ),
    };

    // Set up DEX routers with network-specific addresses
    if (dexRouters.uniswap_v2?.router) {
      context.uniRouter = new ethers.Contract(
        dexRouters.uniswap_v2.router,
        minimalRouterABI,
        wallet
      );
    }

    if (dexRouters.sushiswap?.router) {
      context.sushiRouter = new ethers.Contract(
        dexRouters.sushiswap.router,
        minimalRouterABI,
        wallet
      );
    }

    chainContexts.set(chain, context);
    logger.info(
      `[${chain}] Chain context initialized with ${
        Object.keys(tokens).filter((k) => tokens[k]).length
      } tokens`
    );
  }
  return chainContexts.get(chain);
}

slippageAgent = initSlippageAgent({
  continuous: (RL_CONTINUOUS || OPTIONAL_ENV_DEFAULTS.RL_CONTINUOUS) === "true",
  maxOffsetBips: parseFloat(
    RL_MAX_OFFSET_BIPS || OPTIONAL_ENV_DEFAULTS.RL_MAX_OFFSET_BIPS
  ),
  epsilonStart: parseFloat(
    RL_EPSILON_START || OPTIONAL_ENV_DEFAULTS.RL_EPSILON_START
  ),
  epsilonMin: parseFloat(
    RL_EPSILON_MIN || OPTIONAL_ENV_DEFAULTS.RL_EPSILON_MIN
  ),
  epsilonDecay: parseFloat(
    RL_EPSILON_DECAY || OPTIONAL_ENV_DEFAULTS.RL_EPSILON_DECAY
  ),
  alpha: parseFloat(RL_ALPHA || OPTIONAL_ENV_DEFAULTS.RL_ALPHA),
  saveDebounceMs: parseInt(
    RL_SAVE_DEBOUNCE_MS || OPTIONAL_ENV_DEFAULTS.RL_SAVE_DEBOUNCE_MS,
    10
  ),
  metrics: { rlAction, rlEpsilon },
  logger,
});

// ─────────────────────────────────────────────────────────────────────────────
// Network Configuration Import
// ─────────────────────────────────────────────────────────────────────────────
const {
  getNetworkConfig,
  getTokenAddress,
  getDexConfig,
  getSupportedNetworks,
  TOKENS: NETWORK_TOKENS,
  DEX_ROUTERS,
  AAVE_CONFIG,
} = require("./config/networkConfig");

// ─────────────────────────────────────────────────────────────────────────────
// Token & DEX Setup (network-aware with env override)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Get token addresses for a specific network
 * Priority: Environment variable > Network config > Empty string
 */
function getTokenAddresses(network = "ethereum") {
  const networkConfig = getNetworkConfig(network);
  const networkTokens = networkConfig.tokens || {};

  return {
    DAI: (TOKENS_DAI || networkTokens.DAI || "").toLowerCase(),
    WETH: (TOKENS_WETH || networkTokens.WETH || "").toLowerCase(),
    USDC: (TOKENS_USDC || networkTokens.USDC || "").toLowerCase(),
    USDT: (TOKENS_USDT || networkTokens.USDT || "").toLowerCase(),
    UNI: (TOKENS_UNI || networkTokens.UNI || "").toLowerCase(),
    WBTC: (networkTokens.WBTC || "").toLowerCase(),
    LINK: (networkTokens.LINK || "").toLowerCase(),
    AAVE: (networkTokens.AAVE || "").toLowerCase(),
  };
}

/**
 * Get DEX router addresses for a specific network
 * Priority: Environment variable > Network config
 */
function getDexRouters(network = "ethereum") {
  const networkConfig = getNetworkConfig(network);
  const dexConfig = networkConfig.dexRouters || {};

  return {
    uniswap_v2: {
      router: UNISWAP_ROUTER_ADDRESS || dexConfig.uniswap_v2?.router || "",
      factory: dexConfig.uniswap_v2?.factory || "",
    },
    uniswap_v3: {
      router: dexConfig.uniswap_v3?.router || "",
      quoter: dexConfig.uniswap_v3?.quoter || "",
      quoterV2: dexConfig.uniswap_v3?.quoterV2 || "",
      factory: dexConfig.uniswap_v3?.factory || "",
    },
    sushiswap: {
      router: SUSHISWAP_ROUTER_ADDRESS || dexConfig.sushiswap?.router || "",
      factory: dexConfig.sushiswap?.factory || "",
    },
    balancer: {
      vault: dexConfig.balancer?.vault || "",
    },
    curve: {
      registry: dexConfig.curve?.registry || "",
      addressProvider: dexConfig.curve?.addressProvider || "",
    },
  };
}

/**
 * Get Aave configuration for a specific network
 */
function getAaveConfig(network = "ethereum") {
  const networkConfig = getNetworkConfig(network);
  const aaveConfig = networkConfig.aave || {};

  if (aaveConfig.v2) {
    return {
      version: 2,
      poolAddressProvider:
        AAVE_LENDING_POOL_ADDRESS_PROVIDER ||
        aaveConfig.v2.lendingPoolAddressProvider,
      pool: aaveConfig.v2.lendingPool,
    };
  }

  return {
    version: 2,
    poolAddressProvider: AAVE_LENDING_POOL_ADDRESS_PROVIDER || "",
    pool: null,
  };
}

// Default token addresses (for backward compatibility)
const tokenAddresses = getTokenAddresses(DEFAULT_CHAIN);

// Network-specific caches
const networkTokenCache = new Map();
const networkDexCache = new Map();

/**
 * Get cached token addresses for a network
 */
function getCachedTokenAddresses(network) {
  if (!networkTokenCache.has(network)) {
    networkTokenCache.set(network, getTokenAddresses(network));
  }
  return networkTokenCache.get(network);
}

/**
 * Get cached DEX routers for a network
 */
function getCachedDexRouters(network) {
  if (!networkDexCache.has(network)) {
    networkDexCache.set(network, getDexRouters(network));
  }
  return networkDexCache.get(network);
}

// ─────────────────────────────────────────────────────────────────────────────
// Load ABI for ArbitrageFlashloan from server/abis/
// ─────────────────────────────────────────────────────────────────────────────
function loadABI(relativePath) {
  const fullPath = path.resolve(__dirname, "abis", relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`ABI file not found: ${fullPath}`);
  }
  const json = require(fullPath);
  return Array.isArray(json) ? json : json.abi;
}

const arbitrageABI = loadABI("ArbitrageFlashloan.json");

// ─────────────────────────────────────────────────────────────────────────────
// Minimal Router ABIs for getAmountsOut (no external JSON files needed)
// ─────────────────────────────────────────────────────────────────────────────
const minimalRouterABI = [
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
];

// ─────────────────────────────────────────────────────────────────────────────
// ML Feature Enrichment: Compute missing features for routes
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// ML Scoring: Attach score to each route via ML microservice (with heuristic fallback)
// ─────────────────────────────────────────────────────────────────────────────
const mlScorer = require("./scripts/mlScorer");

// ─────────────────────────────────────────────────────────────────────────────
// Fetch Top Liquidity Pools & Generate Routes per Chain
// ─────────────────────────────────────────────────────────────────────────────
async function getAllRoutes(chain = "ethereum") {
  if (chain !== "ethereum") return [];
  return (await require("./bot/coordinator").getCoordinator().discover())
    .candidates;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compute Daily PnL over the last 24h using direct dbPool.query
// ─────────────────────────────────────────────────────────────────────────────
let dbDisabledLogged = false;

async function computeDailyPnL() {
  if (!isDbEnabled() && dbPool && typeof waitForPoolReady === "function") {
    await waitForPoolReady();
  }
  if (!isDbEnabled() || !dbPool) {
    if (!dbDisabledLogged) {
      logger.info(
        "PostgreSQL persistence disabled; skipping daily PnL computation."
      );
      dbDisabledLogged = true;
    }
    return BigNumber.from(0);
  }
  try {
    const res = await dbPool.query(
      `SELECT SUM(profit) AS total_profit FROM trades WHERE timestamp >= NOW() - INTERVAL '24 HOURS';`
    );
    const totalProfitRaw = res.rows[0]?.total_profit;
    const profit = totalProfitRaw
      ? ethers.utils.parseUnits(totalProfitRaw.toString(), 18)
      : BigNumber.from(0);
    logger.info(
      `Computed daily PnL: ${ethers.utils.formatUnits(profit, 18)} DAI.`
    );
    return profit;
  } catch (err) {
    logger.warn(`Failed to compute daily PnL: ${err.message}`);
    return BigNumber.from(0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Simulation & Execution Loop for One Chain
// ─────────────────────────────────────────────────────────────────────────────
async function simulateAndExecuteArbChain(
  chain,
  useFlashbots = true,
  options = {}
) {
  if (chain !== "ethereum")
    throw new Error("Production execution is Ethereum-only");
  const coordinator = require("./bot/coordinator").getCoordinator();
  const cb = circuitBreaker.canTrade();
  if (!cb.allowed) return { executed: false, reason: cb.reason };
  const result = await coordinator.cycle(options);
  arbAttempts.inc();
  if (result.executed) arbSuccess.inc();
  if (result.reason) arbFailure.labels("deterministic_gate").inc();
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connext Cross-Chain Profit Forwarding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize Connext client for cross-chain profit forwarding.
 * The client is initialised when CONNEXT_ADAPTER_ADDRESS is set, but
 * auto-forwarding is OFF unless CONNEXT_AUTO_FORWARD=true. The adapter pulls
 * forwarded tokens from its owner, which is the signer here: use a dedicated
 * treasury key, not the hot trading key, before enabling it.
 */
async function initConnext(chain) {
  const connextAdapterAddress = process.env.CONNEXT_ADAPTER_ADDRESS;
  if (!connextAdapterAddress) {
    logger.info(
      "[Connext] CONNEXT_ADAPTER_ADDRESS not set, cross-chain forwarding disabled"
    );
    return false;
  }

  // Auto-forward moves funds cross-chain, so it is strictly opt-in.
  connextAutoForwardEnabled = process.env.CONNEXT_AUTO_FORWARD === "true";

  try {
    const { provider, wallet } = getChainContext(chain);
    connextConfig = await initConnextClient({
      adapterAddress: connextAdapterAddress,
      provider,
      signer: wallet,
      config: {
        autoForwardEnabled: connextAutoForwardEnabled,
        // Whole tokens; the client scales them by each token's decimals.
        autoForwardThreshold:
          process.env.CONNEXT_AUTO_FORWARD_THRESHOLD || "100",
        minForwardAmount: process.env.CONNEXT_MIN_FORWARD_AMOUNT || "10",
      },
    });
    connextInitialized = true;
    logger.info(
      `[Connext] Initialized - destination domain: ${connextConfig.destinationDomain}`
    );
    logger.info(
      `[Connext] Auto-forward: ${
        connextAutoForwardEnabled ? "ENABLED" : "DISABLED"
      }`
    );
    return true;
  } catch (err) {
    logger.error(`[Connext] Initialization failed: ${err.message}`);
    return false;
  }
}

/**
 * Check and forward profits via Connext if threshold is met
 * @param {string} token - Token address to forward
 * @param {BigNumber} profitAmount - Amount of profit from latest trade
 * @returns {Object} - Detailed Connext status including forwarding result
 */
async function checkAndForwardProfits(token, profitAmount) {
  if (!connextInitialized) {
    return {
      forwarded: false,
      reason: "Connext not initialized",
      connextEnabled: false,
      autoForwardEnabled: false,
    };
  }

  try {
    // Get current accumulated profits for status
    const accumulatedBalance = await getAccumulatedProfits(token);
    const pendingTransfersList = getPendingTransfers();

    // Check if auto-forward should be triggered
    const autoForwardCheck = await checkAutoForward(token);
    const decimals = await tokenDecimals(token);

    const baseStatus = {
      connextEnabled: true,
      autoForwardEnabled: connextAutoForwardEnabled,
      accumulatedProfits: accumulatedBalance.toString(),
      accumulatedProfitsFormatted: ethers.utils.formatUnits(
        accumulatedBalance,
        decimals
      ),
      pendingTransfers: pendingTransfersList.length,
      threshold: autoForwardCheck.threshold
        ? ethers.utils.formatUnits(autoForwardCheck.threshold, decimals)
        : null,
    };

    if (autoForwardCheck.shouldForward) {
      logger.info(
        `[Connext] Auto-forward threshold reached, forwarding ${ethers.utils.formatUnits(
          autoForwardCheck.balance,
          decimals
        )} tokens`
      );

      const result = await forwardProfits({
        token,
        amount: autoForwardCheck.balance,
      });

      if (result.success) {
        logger.info(
          `[Connext] Profits forwarded successfully! TX: ${result.txHash}, Transfer ID: ${result.transferId}`
        );
        return {
          ...baseStatus,
          forwarded: true,
          txHash: result.txHash,
          transferId: result.transferId,
          amount: result.amount,
          amountFormatted: ethers.utils.formatUnits(result.amount, decimals),
          relayerFee: result.relayerFee,
          tracked: result.tracked,
        };
      } else {
        logger.warn(
          `[Connext] Forward failed: ${result.error || result.reason}`
        );
        return {
          ...baseStatus,
          forwarded: false,
          reason: result.error || result.reason,
        };
      }
    } else {
      const balanceFormatted = autoForwardCheck.balance
        ? ethers.utils.formatUnits(autoForwardCheck.balance, decimals)
        : "0";
      logger.info(
        `[Connext] Below auto-forward threshold: ${balanceFormatted} / ${
          baseStatus.threshold || "N/A"
        }`
      );
      return {
        ...baseStatus,
        forwarded: false,
        reason: autoForwardCheck.reason,
        currentBalance: balanceFormatted,
      };
    }
  } catch (err) {
    logger.error(`[Connext] Error checking/forwarding profits: ${err.message}`);
    return {
      connextEnabled: true,
      autoForwardEnabled: connextAutoForwardEnabled,
      forwarded: false,
      reason: err.message,
      error: true,
    };
  }
}

/**
 * Manually forward accumulated profits
 * @param {string} token - Token address
 * @param {BigNumber|string} amount - Amount to forward (optional, forwards all if not specified)
 */
async function manualForwardProfits(token, amount) {
  if (!connextInitialized) {
    throw new Error("Connext not initialized");
  }

  let forwardAmount = amount;
  if (!forwardAmount) {
    forwardAmount = await getAccumulatedProfits(token);
  }

  return forwardProfits({ token, amount: forwardAmount });
}

/**
 * Get Connext status and accumulated profits
 */
async function getConnextStatus(token) {
  const adapterConfigured = !!process.env.CONNEXT_ADAPTER_ADDRESS;

  if (!connextInitialized) {
    return {
      initialized: false,
      configured: adapterConfigured,
      autoForwardEnabled: false,
      reason: adapterConfigured
        ? "Initialization pending or failed"
        : "Adapter not configured",
    };
  }

  try {
    const destInfo = await getDestinationInfo();
    const accumulated = token
      ? await getAccumulatedProfits(token)
      : BigNumber.from(0);
    const pendingTransfersList = getPendingTransfers();
    const recentHistory = getTransferHistory(10);

    return {
      initialized: true,
      configured: true,
      autoForwardEnabled: connextAutoForwardEnabled,
      destination: destInfo,
      accumulatedProfits: accumulated.toString(),
      accumulatedProfitsFormatted: ethers.utils.formatUnits(
        accumulated,
        token ? await tokenDecimals(token) : 18
      ),
      pendingTransfers: {
        count: pendingTransfersList.length,
        transfers: pendingTransfersList,
      },
      recentTransfers: {
        count: recentHistory.length,
        transfers: recentHistory,
      },
      thresholds: {
        autoForwardThreshold:
          process.env.CONNEXT_AUTO_FORWARD_THRESHOLD || "100",
        minForwardAmount: process.env.CONNEXT_MIN_FORWARD_AMOUNT || "10",
      },
    };
  } catch (err) {
    return {
      initialized: true,
      configured: true,
      autoForwardEnabled: connextAutoForwardEnabled,
      error: err.message,
    };
  }
}

/**
 * Get Connext transfer history
 * @param {number} limit - Max entries to return
 */
function getConnextTransferHistory(limit = 20) {
  if (!connextInitialized) {
    return { error: "Connext not initialized", transfers: [] };
  }
  return {
    transfers: getTransferHistory(limit),
    pendingCount: getPendingTransfers().length,
  };
}

/**
 * Get pending Connext transfers
 */
function getPendingConnextTransfers() {
  if (!connextInitialized) {
    return { error: "Connext not initialized", transfers: [] };
  }
  return {
    transfers: getPendingTransfers(),
    count: getPendingTransfers().length,
  };
}

/**
 * Check status of a specific Connext transfer
 * @param {string} transferId - Transfer ID to check
 */
async function checkConnextTransferStatus(transferId) {
  if (!connextInitialized) {
    return { error: "Connext not initialized" };
  }
  return checkTransferStatus(transferId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordinator: Run simulateAndExecuteArbChain on Each Configured Chain
// ─────────────────────────────────────────────────────────────────────────────
async function simulateAndExecuteArb(useFlashbots = true, options = {}) {
  return simulateAndExecuteArbChain(DEFAULT_CHAIN, true, options);
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Update Functions (for server API)
// ─────────────────────────────────────────────────────────────────────────────
let minBorrowAmountOverride = null;
let simulationInputAmountOverride = null;

function updateMinBorrowAmount(amount) {
  if (amount === null || amount === undefined) {
    minBorrowAmountOverride = null;
    logger.info("Min borrow amount override cleared");
    return;
  }
  minBorrowAmountOverride = BigNumber.from(amount.toString());
  logger.info(
    `Min borrow amount override set to: ${ethers.utils.formatUnits(
      minBorrowAmountOverride,
      18
    )}`
  );
}

function updateSimulationInputAmount(amount) {
  if (amount === null || amount === undefined) {
    simulationInputAmountOverride = null;
    logger.info("Simulation input amount override cleared");
    return;
  }
  simulationInputAmountOverride = BigNumber.from(amount.toString());
  logger.info(
    `Simulation input amount override set to: ${ethers.utils.formatUnits(
      simulationInputAmountOverride,
      18
    )}`
  );
}

async function getCurrentMarketData() {
  const { provider } = getChainContext(DEFAULT_CHAIN);

  try {
    const gasPrice = await provider.getGasPrice();
    const slippage = await getDynamicSlippage();
    const dailyPnL = await computeDailyPnL();

    return {
      gasPrice: ethers.utils.formatUnits(gasPrice, "gwei"),
      gasPriceWei: gasPrice.toString(),
      slippageBips: slippage,
      dailyPnL: ethers.utils.formatUnits(dailyPnL, 18),
      dailyPnLWei: dailyPnL.toString(),
      minBorrowOverride: minBorrowAmountOverride
        ? ethers.utils.formatUnits(minBorrowAmountOverride, 18)
        : null,
      simulationInputOverride: simulationInputAmountOverride
        ? ethers.utils.formatUnits(simulationInputAmountOverride, 18)
        : null,
      rlEpsilon: slippageAgent.epsilon,
      rlLastAction: slippageAgent.lastAction,
      timestamp: Date.now(),
    };
  } catch (err) {
    logger.error(`getCurrentMarketData error: ${err.message}`);
    return {
      error: err.message,
      timestamp: Date.now(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports & Standalone Loop
// ─────────────────────────────────────────────────────────────────────────────
module.exports.simulateAndExecuteArb = simulateAndExecuteArb;
module.exports.getDynamicSlippage = getDynamicSlippage;
module.exports.getAllRoutes = getAllRoutes;
module.exports.DEFAULT_CHAIN = DEFAULT_CHAIN;
module.exports.computeDailyPnL = computeDailyPnL;
module.exports.__cache = cache;
module.exports.getRecentOpportunities = () =>
  require("./bot/coordinator")
    .getCoordinator()
    .ledger.recent(50)
    .filter((r) => r.status === "SIMULATED")
    .map((r) => ({
      ...r,
      chain: "ethereum",
      timestamp: r.updatedAt,
      borrowAmount: BigNumber.from(r.borrowAmount),
      estimatedOut: BigNumber.from(r.economics.expectedFinalAmount),
      gasEstimate: BigNumber.from(r.economics.estimatedGasUnits),
      gasPrice: BigNumber.from(0),
      gasCostDai: BigNumber.from(r.economics.estimatedGasCostBorrowToken),
      premiumWei: BigNumber.from(r.flashloanPremium),
      netProfit: BigNumber.from(r.economics.expectedNetProfit),
    }));
module.exports.getCurrentMarketData = getCurrentMarketData;
module.exports.updateMinBorrowAmount = updateMinBorrowAmount;
module.exports.updateSimulationInputAmount = updateSimulationInputAmount;
module.exports.resetSlippagePolicy = function resetSlippagePolicy() {
  slippageAgent.resetPolicy();
  rlAction.set(0);
  rlEpsilon.set(slippageAgent.epsilon);
  return {
    epsilon: slippageAgent.epsilon,
    continuous: slippageAgent.continuous,
    actions: slippageAgent.actions ? [...slippageAgent.actions] : [],
  };
};

// Connext cross-chain exports
module.exports.initConnext = initConnext;
module.exports.checkAndForwardProfits = checkAndForwardProfits;
module.exports.manualForwardProfits = manualForwardProfits;
module.exports.getConnextStatus = getConnextStatus;
module.exports.getConnextTransferHistory = getConnextTransferHistory;
module.exports.getPendingConnextTransfers = getPendingConnextTransfers;
module.exports.checkConnextTransferStatus = checkConnextTransferStatus;

// Network configuration exports
module.exports.getTokenAddresses = getTokenAddresses;
module.exports.getDexRouters = getDexRouters;
module.exports.getAaveConfig = getAaveConfig;
module.exports.getCachedTokenAddresses = getCachedTokenAddresses;
module.exports.getCachedDexRouters = getCachedDexRouters;

// WebSocket connection health exports
module.exports.getConnectionStatus = getConnectionStatus;
module.exports.getSubscriptionStats = getSubscriptionStats;

// ─────────────────────────────────────────────────────────────────────────────
// Tier-1 Feature Exports and Initialization
// ─────────────────────────────────────────────────────────────────────────────

// Risk manager exports
module.exports.getRiskReport = getPerformanceReport;
module.exports.pauseTrading = () => {
  require("./bot/stateMachine").tradingState.pause();
  return riskManager.pause("Manual pause requested");
};
module.exports.resumeTrading = () => {
  require("./bot/stateMachine").tradingState.paper();
  return riskManager.resume();
};
module.exports.forceResumeTrading = () => {
  require("./bot/stateMachine").tradingState.paper();
  return riskManager.forceResume();
};
module.exports.getRiskAlerts = () => riskManager.getAlerts();

// Multi-relay exports
module.exports.getRelayStats = getRelayStats;

// Incremental graph exports
module.exports.getGraphStats = getGraphStats;

// Feature flags export
module.exports.getTier1FeatureStatus = () => ({
  multiRelay: ENABLE_MULTI_RELAY,
  riskManager: ENABLE_RISK_MANAGER,
  incrementalGraph: ENABLE_INCREMENTAL_GRAPH,
  mempoolMonitor: ENABLE_MEMPOOL_MONITOR,
  dynamicTips: ENABLE_DYNAMIC_TIPS,
});

/**
 * Execute a backrun opportunity detected from mempool
 * @param {Object} opportunity - Backrun opportunity from mempool monitor
 * @param {string} chain - Chain identifier
 */
async function executeBackrun() {
  return {
    executed: false,
    reason: "Backrunning is disabled in the production profile",
  };
}

/**
 * Initialize Tier-1 features (call once at startup)
 */
async function initializeTier1Features(provider) {
  const results = {
    rpcManager: false,
    mempoolMonitor: false,
    riskManager: false,
  };

  // Initialize RPC manager with failover
  try {
    const rpcCount = await initRpcManager();
    if (rpcCount > 0) {
      rpcManager.startHealthMonitoring();
      results.rpcManager = true;
      logger.info(`[Tier1] RPC Manager initialized with ${rpcCount} endpoints`);
    }
  } catch (err) {
    logger.warn(`[Tier1] RPC Manager init failed: ${err.message}`);
  }

  // Initialize mempool monitor if enabled
  if (ENABLE_MEMPOOL_MONITOR && provider) {
    try {
      const mempoolMonitor = getMempoolMonitor(provider);
      await mempoolMonitor.start();

      // Listen for backrun opportunities
      mempoolMonitor.on("backrun_opportunity", async (opportunity) => {
        logger.info(
          `[Tier1] Backrun opportunity detected: ${opportunity.estimatedProfitEth.toFixed(
            6
          )} ETH ` + `(target tx: ${opportunity.targetTx.slice(0, 10)}...)`
        );

        // Execute backrun if profitable and within risk limits
        try {
          const result = await executeBackrun(opportunity, DEFAULT_CHAIN);
          if (result.executed) {
            logger.info(`[Tier1] Backrun executed successfully`);
          } else {
            logger.debug(`[Tier1] Backrun skipped: ${result.reason}`);
          }
        } catch (err) {
          logger.warn(`[Tier1] Backrun execution error: ${err.message}`);
        }
      });

      results.mempoolMonitor = true;
      logger.info("[Tier1] Mempool monitor started");
    } catch (err) {
      logger.warn(`[Tier1] Mempool monitor init failed: ${err.message}`);
    }
  }

  // Risk manager is already initialized as singleton
  if (ENABLE_RISK_MANAGER) {
    results.riskManager = true;
    logger.info("[Tier1] Risk manager enabled");
  }

  logger.info(
    `[Tier1] Feature initialization complete: ${JSON.stringify(results)}`
  );
  return results;
}

module.exports.initializeTier1Features = initializeTier1Features;
module.exports.executeBackrun = executeBackrun;

if (require.main === module) {
  require("../scripts/run-bot")
    .runBot()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
