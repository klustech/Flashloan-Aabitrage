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
const ENABLE_MEMPOOL_MONITOR = process.env.MEMPOOL_MONITORING === "true";
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
let initBalancer;
let getBalancerQuote;
if (features.balancer) {
  ({ initBalancer, getBalancerQuote } = require("./scripts/balancerUtils"));
}
let getCurveQuote;
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

const RECENT_OPPORTUNITY_LIMIT = 5;
const recentOpportunities = [];

function cloneSwapDataForStore(data) {
  return {
    borrowToken: data.borrowToken,
    borrowAmount: data.borrowAmount ? data.borrowAmount.toString() : undefined,
    steps: (data.steps || []).map((s) => ({
      dexType: s.dexType,
      router: s.router,
      tokenIn: s.tokenIn,
      tokenOut: s.tokenOut,
      minAmountOut: ethers.BigNumber.isBigNumber(s.minAmountOut)
        ? s.minAmountOut.toString()
        : String(s.minAmountOut ?? "0"),
      v3Fee: s.v3Fee,
    })),
    minProfit: data.minProfit ? data.minProfit.toString() : "0",
    route: data.route,
  };
}

function recordOpportunity(opportunity) {
  recentOpportunities.unshift(opportunity);
  if (recentOpportunities.length > RECENT_OPPORTUNITY_LIMIT) {
    recentOpportunities.length = RECENT_OPPORTUNITY_LIMIT;
  }

  // Emit event for real-time WebSocket broadcast
  eventBus.emitOpportunity(opportunity);
}

function getRecentOpportunities() {
  return recentOpportunities.slice();
}

// Whether to broadcast arb txs to the public mempool when private relays fail.
// Off by default — a public arbitrage tx gets front-run/sandwiched.
const ALLOW_PUBLIC_FALLBACK =
  process.env.ALLOW_PUBLIC_MEMPOOL_FALLBACK === "true";

// Off-chain circuit breaker — gates trading on cascading losses / failures.
const circuitBreaker = getCircuitBreaker({
  dailyDrawdownLimitDAI: parseFloat(
    process.env.DAILY_DRAWDOWN_LIMIT_DAI || "500"
  ),
});

// Feed a real execution outcome (success/revert) to the circuit breaker. Idle
// "no opportunity" cycles must NOT be recorded here, or the breaker trips on a
// quiet market.
function recordTradeOutcome({ success, profit, gasPrice }) {
  try {
    circuitBreaker.recordResult({
      success: Boolean(success),
      profit: ethers.BigNumber.isBigNumber(profit)
        ? profit
        : ethers.BigNumber.from(profit || 0),
      gasPrice,
    });
  } catch (e) {
    logger.warn(`[circuitBreaker] recordResult failed: ${e.message}`);
  }
}

// Helper wrapped with safeAsync using the configured logger
const safeFetchReserves = safeAsync(fetchMulticallReservesForRoute, logger);

process.on("unhandledRejection", (reason) => {
  logger.error(
    `Unhandled Rejection: ${reason instanceof Error ? reason.message : reason}`
  );
});

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught Exception: ${err.stack || err.message}`);
  arbFailure.labels("uncaught_exception").inc();
  sendSlackAlert(`Uncaught Exception in bot process: ${err.message}`);
});

const throwIfAborted = (signal) => {
  if (signal?.aborted) {
    const abortError = new Error("Arbitrage execution aborted");
    abortError.name = "AbortError";
    abortError.metricReason = "timeout";
    throw abortError;
  }
};

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
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

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

// ─────────────────────────────────────────────────────────────────────────────
// Global constants (parsed as ints/floats)
// ─────────────────────────────────────────────────────────────────────────────
const SLIPPAGE_DEFAULT_INT = SLIPPAGE_DEFAULT_BIPS
  ? parseInt(SLIPPAGE_DEFAULT_BIPS, 10)
  : parseInt(OPTIONAL_ENV_DEFAULTS.SLIPPAGE_DEFAULT_BIPS, 10);
const GAS_CEILING_BN = ethers.utils.parseUnits(
  GAS_PRICE_CEILING || OPTIONAL_ENV_DEFAULTS.GAS_PRICE_CEILING,
  "gwei"
);
const ZSCORE_THRESH = parseFloat(
  ZSCORE_THRESHOLD || OPTIONAL_ENV_DEFAULTS.ZSCORE_THRESHOLD
);
const ML_TOP_K = parseInt(ML_TOPK || OPTIONAL_ENV_DEFAULTS.ML_TOPK, 10);
const BUNDLE_COUNT = parseInt(
  FLASHBOTS_BUNDLE_COUNT || OPTIONAL_ENV_DEFAULTS.FLASHBOTS_BUNDLE_COUNT,
  10
);
const CB_NEG_THRESH_INT = parseInt(
  CB_NEG_THRESHOLD || OPTIONAL_ENV_DEFAULTS.CB_NEG_THRESHOLD,
  10
);
const DAILY_DD_LIMIT_DAI = ethers.utils.parseUnits(
  DAILY_DRAWDOWN_LIMIT_DAI || OPTIONAL_ENV_DEFAULTS.DAILY_DRAWDOWN_LIMIT_DAI,
  18
);
const REALTIME_POOL_LIMIT = parseInt(
  REALTIME_POOL_COUNT || OPTIONAL_ENV_DEFAULTS.REALTIME_POOL_COUNT,
  10
);
const ROUTE_TOPN_LIMIT = parseInt(
  DYNAMIC_ROUTE_TOPN || OPTIONAL_ENV_DEFAULTS.DYNAMIC_ROUTE_TOPN,
  10
);
const ROUTE_MAX_HOPS = parseInt(
  DYNAMIC_ROUTE_HOPS || OPTIONAL_ENV_DEFAULTS.DYNAMIC_ROUTE_HOPS,
  10
);
const FLASHLOAN_PREMIUM_INT = parseInt(
  FLASHLOAN_PREMIUM_BIPS || OPTIONAL_ENV_DEFAULTS.FLASHLOAN_PREMIUM_BIPS,
  10
);
const PRIO_PERCENT_INT = parseInt(
  PRIO_PERCENT || OPTIONAL_ENV_DEFAULTS.PRIO_PERCENT,
  10
);
const PRIO_FEE_MAX = ethers.utils.parseUnits(
  PRIO_FEE_MAX_GWEI || OPTIONAL_ENV_DEFAULTS.PRIO_FEE_MAX_GWEI,
  "gwei"
);
const TIP_RETRY_LIMIT = parseInt(
  TIP_RETRY_COUNT || OPTIONAL_ENV_DEFAULTS.TIP_RETRY_COUNT,
  10
);
const TIP_MULTIPLIER_NUM_INT = parseInt(
  TIP_MULTIPLIER_NUM || OPTIONAL_ENV_DEFAULTS.TIP_MULTIPLIER_NUM,
  10
);
const TIP_MULTIPLIER_DEN_INT = parseInt(
  TIP_MULTIPLIER_DEN || OPTIONAL_ENV_DEFAULTS.TIP_MULTIPLIER_DEN,
  10
);

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

  // Prefer V3 if available, fall back to V2
  if (aaveConfig.v3) {
    return {
      version: 3,
      poolAddressProvider:
        AAVE_LENDING_POOL_ADDRESS_PROVIDER || aaveConfig.v3.poolAddressProvider,
      pool: aaveConfig.v3.pool,
    };
  }
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
// ─────────────────────────────────────────────────────────────────────────────
// Heuristic state
// ─────────────────────────────────────────────────────────────────────────────
let consecutiveNegatives = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions: Slippage, Aave Liquidity & Borrow Calculations
// ─────────────────────────────────────────────────────────────────────────────
function calculateMinOut(amountOut, slippageBips) {
  return amountOut
    .mul(BigNumber.from(10000 - slippageBips))
    .div(BigNumber.from(10000));
}

async function getAvailableLiquidity(token, chain) {
  const { provider } = getChainContext(chain);
  const providerAddr = AAVE_LENDING_POOL_ADDRESS_PROVIDER;
  const lpProvider = new ethers.Contract(
    providerAddr,
    ["function getLendingPool() view returns (address)"],
    provider
  );
  let poolAddr;
  try {
    poolAddr = await lpProvider.getLendingPool();
  } catch (err) {
    logger.error(
      `[${chain}] Failed to get Aave LendingPool address: ${err.message}`
    );
    return BigNumber.from(0);
  }
  const lendingPool = new ethers.Contract(
    poolAddr,
    [
      "function getReserveData(address) view returns (uint256 totalLiquidity, uint256 availableLiquidity, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)",
    ],
    provider
  );
  try {
    const reserveData = await lendingPool.getReserveData(tokenAddresses[token]);
    logger.info(
      `[${chain}] Aave available liquidity for ${token}: ${ethers.utils.formatUnits(
        reserveData.availableLiquidity,
        18
      )}`
    );
    return reserveData.availableLiquidity;
  } catch (err) {
    logger.error(`[${chain}] Failed reserveData for ${token}: ${err.message}`);
    return BigNumber.from(0);
  }
}

async function getOptimalBorrowAmount(token, chain) {
  const availableLiquidity = await getAvailableLiquidity(token, chain);
  if (availableLiquidity.isZero()) {
    logger.info(
      `[${chain}] Aave reports zero available liquidity for ${token}.`
    );
    return BigNumber.from(0);
  }
  // Upper bound for the optimal-sizing search (the per-route profit-maximising
  // size is chosen later in selectBestRoute). Capped by Aave liquidity and a
  // configurable ceiling so we never propose an absurd borrow.
  const ceiling = ethers.utils.parseUnits(
    process.env.MAX_BORROW_DAI || "100000",
    18
  );
  const cap = ceiling.lte(availableLiquidity) ? ceiling : availableLiquidity;
  logger.info(
    `[${chain}] Borrow ceiling for ${token}: ${ethers.utils.formatUnits(
      cap,
      18
    )}`
  );
  return cap;
}

// ─────────────────────────────────────────────────────────────────────────────
// Statistical Filtering: Z-Score Computation
// ─────────────────────────────────────────────────────────────────────────────
function computeZScore(values) {
  if (!values.length) return [];
  const mean = stats.mean(values);
  const stdev = stats.standardDeviation(values);
  return values.map((p) => (p - mean) / (stdev || 1));
}

/**
 * Compute multi-metric Z-score combining price ratio and liquidity
 * This provides better filtering by considering both opportunity size and execution reliability.
 *
 * @param {Array} routes - Array of route definitions
 * @param {object} weights - Weights for each metric { priceRatio: 0.7, liquidity: 0.3 }
 * @returns {number[]} - Composite Z-scores
 */
function computeMultiMetricZScore(
  routes,
  weights = { priceRatio: 0.7, liquidity: 0.3 }
) {
  if (!routes.length) return [];

  // Extract metrics
  const priceRatios = routes.map((r) => r.estimatedPriceRatio || 1);
  const liquidities = routes.map((r) => {
    // Get minimum liquidity across all hops (bottleneck)
    if (r.hops && r.hops.length > 0) {
      const hopLiqs = r.hops
        .map((h) => h.liquidity || h.reserveUSD || 0)
        .filter((l) => l > 0);
      return hopLiqs.length > 0 ? Math.min(...hopLiqs) : 0;
    }
    return r.liquidity || 0;
  });

  // Compute individual Z-scores
  const priceZScores = computeZScore(priceRatios);
  const liquidityZScores = computeZScore(liquidities);

  // Combine with weights - higher price ratio is better, higher liquidity is better
  // For price ratio: positive Z-score means above average (good)
  // For liquidity: positive Z-score means above average (good)
  const compositeScores = routes.map((_, i) => {
    const priceComponent = priceZScores[i] * weights.priceRatio;
    const liquidityComponent = liquidityZScores[i] * weights.liquidity;
    return priceComponent + liquidityComponent;
  });

  return compositeScores;
}

// ─────────────────────────────────────────────────────────────────────────────
// ML Feature Enrichment: Compute missing features for routes
// ─────────────────────────────────────────────────────────────────────────────

// Gas cost estimates by DEX type (in gas units)
const GAS_ESTIMATES = {
  uniswap_v2: 60000,
  sushiswap_v2: 60000,
  uniswap_v3: 100000,
  balancer: 120000,
  curve: 150000,
  default: 80000,
};

/**
 * Query historical success count for routes from the database
 * @param {Array} routeDefs - Array of route definitions
 * @returns {Map} - Map of route hash to success count
 */
async function getHistoricalSuccessCounts(routeDefs) {
  const successMap = new Map();

  if (!isDbEnabled() || !dbPool) {
    return successMap;
  }

  try {
    // Query successful trades from last 7 days, grouped by route
    const result = await dbPool.query(`
      SELECT route, COUNT(*) as success_count
      FROM trades
      WHERE status = 'success'
        AND timestamp > NOW() - INTERVAL '7 days'
      GROUP BY route
    `);

    for (const row of result.rows) {
      successMap.set(row.route, parseInt(row.success_count, 10));
    }
  } catch (err) {
    logger.warn(
      `[enrichRoutes] Failed to query historical success: ${err.message}`
    );
  }

  return successMap;
}

/**
 * Generate a unique key for a route (for matching with historical data)
 * @param {object} route - Route definition
 * @returns {string} - Route key
 */
function getRouteKey(route) {
  if (!route.hops || !route.hops.length) return "";
  return route.hops
    .map((h) => `${h.poolAddress || h.tokenA}-${h.dex || "v2"}`)
    .join("->");
}

/**
 * Estimate gas cost for a route based on DEX types and hop count
 * @param {object} route - Route definition
 * @returns {number} - Estimated gas units
 */
function estimateGasCost(route) {
  if (!route.hops || !route.hops.length) return GAS_ESTIMATES.default;

  let totalGas = 21000; // Base transaction cost
  for (const hop of route.hops) {
    const dexType = hop.dex || "uniswap_v2";
    totalGas += GAS_ESTIMATES[dexType] || GAS_ESTIMATES.default;
  }

  return totalGas;
}

/**
 * Enrich routes with computed features for ML scoring
 * @param {Array} routeDefs - Array of route definitions
 * @returns {Promise<Array>} - Enriched route definitions
 */
async function enrichRoutesWithFeatures(routeDefs) {
  if (!routeDefs || !routeDefs.length) return routeDefs;

  // Get market volatility (cached, from CoinGecko)
  let marketVolatility = 2; // Default 2%
  try {
    marketVolatility = await getVolatility();
  } catch (err) {
    logger.warn(`[enrichRoutes] Failed to get volatility: ${err.message}`);
  }

  // Get historical success counts
  const successMap = await getHistoricalSuccessCounts(routeDefs);

  // Enrich each route
  for (const route of routeDefs) {
    // 1. Volatility: Base market volatility adjusted by route complexity
    // More hops = more compounding slippage risk
    const hopMultiplier = route.hops ? 1 + (route.hops.length - 2) * 0.1 : 1;
    route.volatility = marketVolatility * hopMultiplier;

    // 2. Estimated gas cost based on DEX types
    route.estimatedGasCost = estimateGasCost(route);

    // 3. Historical success count from DB
    const routeKey = getRouteKey(route);
    route.historicalSuccessCount = successMap.get(routeKey) || 0;

    // 4. Compute aggregate fee if not already set
    if (!route.fee && route.hops) {
      route.fee = route.hops.reduce(
        (sum, h) => sum + (h.feeBps || h.fee || 30),
        0
      );
    }

    // 5. Compute aggregate liquidity if not already set
    if (!route.liquidity && route.hops) {
      const liquidities = route.hops
        .map((h) => h.liquidity || h.reserveUSD || 0)
        .filter((l) => l > 0);
      route.liquidity = liquidities.length > 0 ? Math.min(...liquidities) : 0;
    }
  }

  logger.info(
    `[enrichRoutes] Enriched ${
      routeDefs.length
    } routes with features (volatility=${marketVolatility.toFixed(2)}%)`
  );

  return routeDefs;
}

// ─────────────────────────────────────────────────────────────────────────────
// ML Scoring: Attach score to each route via ML microservice (with heuristic fallback)
// ─────────────────────────────────────────────────────────────────────────────
const mlScorer = require("./scripts/mlScorer");

async function scoreRoutesWithML(routeDefs) {
  try {
    // First enrich routes with computed features
    const enrichedRoutes = await enrichRoutesWithFeatures(routeDefs);

    const features = enrichedRoutes.map((r) => [
      r.hops.length,
      r.liquidity || 0,
      r.fee || 3000,
      r.volatility || 0,
      r.estimatedGasCost || 0,
      r.historicalSuccessCount || 0,
    ]);

    // Use mlScorer which has both ML endpoint and heuristic fallback
    const probabilities = await mlScorer.score(features);

    enrichedRoutes.forEach((r, i) => {
      r.score = probabilities[i] || 0;
    });

    logger.info(
      `[scoreRoutesWithML] Assigned scores to ${
        enrichedRoutes.length
      } routes (using ${
        ML_MODEL_ENDPOINT ? "ML endpoint" : "heuristic fallback"
      }).`
    );

    return enrichedRoutes.sort((a, b) => b.score - a.score);
  } catch (err) {
    logger.warn(
      `[scoreRoutesWithML] Scoring error: ${err.message}. Proceeding without ranking.`
    );
    return routeDefs;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parallel Simulation via Worker Threads (using workerSimulator.js)
// ─────────────────────────────────────────────────────────────────────────────
function parallelSimulate(routes, amountIn, slippageBips) {
  return new Promise((resolve) => {
    const results = [];
    let completed = 0;
    routes.forEach((route) => {
      const worker = new Worker(
        path.join(__dirname, "scripts", "workerSimulator.js"),
        {
          workerData: { route, amountIn: amountIn.toString(), slippageBips },
        }
      );
      worker.on("message", (msg) => {
        if (msg.error) {
          logger.warn(`Worker error for route ${msg.routeId}: ${msg.error}`);
          results.push({
            routeId: msg.routeId,
            result: BigNumber.from(0),
          });
        } else {
          results.push({
            routeId: msg.routeId,
            /* worker guarantees a wei-scaled string → safe BigNumber */
            result: BigNumber.from(msg.result),
          });
        }
        completed++;
        if (completed === routes.length) {
          logger.info(
            `Parallel simulation completed for ${routes.length} routes.`
          );
          resolve(results);
        }
      });
      worker.on("error", () => {
        completed++;
        if (completed === routes.length) {
          logger.warn(
            `Parallel simulation encountered errors but finished all ${routes.length} routes.`
          );
          resolve(results);
        }
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch Top Liquidity Pools & Generate Routes per Chain
// ─────────────────────────────────────────────────────────────────────────────
async function getAllRoutes(chain) {
  const topN = ROUTE_TOPN_LIMIT;
  const minLiq =
    DYNAMIC_ROUTE_MIN_LIQUIDITY_USD ||
    MIN_LIQUIDITY ||
    OPTIONAL_ENV_DEFAULTS.MIN_LIQUIDITY;

  let routes = [];
  try {
    routes = await routeFinder({
      startToken: tokenAddresses.DAI,
      topN,
      minLiquidityUSD: minLiq,
      maxHops: ROUTE_MAX_HOPS,
      allowLongCycles: ALLOW_LNG_CYCLES === "true",
      chain,
    });
    logger.info(
      `[${chain}] routeFinder returned ${routes.length} routes (topN=${topN}, minLiq=${minLiq}).`
    );
    return routes;
  } catch (err) {
    logger.warn(`[${chain}] Dynamic route building failed: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Select Best Route by Simulating (possibly parallelized)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Price-impact-aware evaluation of a route. Builds oriented per-hop reserves from
 * the live caches (exact V2; V3 via virtual reserves) and returns the
 * profit-maximising borrow size plus the realistic net profit at that size.
 * Returns { confident:false } when any hop lacks local reserve data (Curve/
 * Balancer) so those routes defer to the coarse simulator + on-chain guard.
 */
function evaluateRouteRealistic(route, borrowToken, maxInput, premiumBps) {
  try {
    if (!route || !Array.isArray(route.hops) || route.hops.length === 0) {
      return { confident: false };
    }
    const borrow = borrowToken.toLowerCase();
    let current = borrow;
    const hops = [];

    for (const hop of route.hops) {
      const a = (hop.tokenA || "").toLowerCase();
      const b = (hop.tokenB || "").toLowerCase();
      if (!a || !b || !hop.poolAddress) return { confident: false };

      let tokenIn, tokenOut;
      if (a === current) {
        tokenIn = a;
        tokenOut = b;
      } else if (b === current) {
        tokenIn = b;
        tokenOut = a;
      } else if (hops.length === 0) {
        tokenIn = a;
        tokenOut = b;
      } else {
        return { confident: false }; // broken token continuity
      }
      current = tokenOut;

      const dex = (hop.dex || "uniswap_v2").toLowerCase();
      const feeBps = Number.isFinite(hop.feeBps)
        ? hop.feeBps
        : dex.includes("v3") && hop.fee
        ? Math.max(1, Math.round(hop.fee / 100))
        : 30;
      // V2 & V3 both sort token0 = lower address.
      const inIsToken0 = tokenIn < tokenOut;

      let reserveIn, reserveOut;
      if (dex.includes("v3")) {
        const c = v3PriceCache.get(hop.poolAddress);
        if (!c || !c.sqrtPriceX96 || !c.liquidity) return { confident: false };
        const { reserve0, reserve1 } = ammV3VirtualReserves(
          c.sqrtPriceX96,
          c.liquidity
        );
        if (reserve0.lte(0) || reserve1.lte(0)) return { confident: false };
        reserveIn = inIsToken0 ? reserve0 : reserve1;
        reserveOut = inIsToken0 ? reserve1 : reserve0;
      } else if (
        dex === "uniswap_v2" ||
        dex === "sushiswap_v2" ||
        dex === "sushiswap"
      ) {
        const c = reserveCache.get(hop.poolAddress);
        if (!c || c.reserve0 == null || c.reserve1 == null) {
          return { confident: false };
        }
        const r0 = BigNumber.from(c.reserve0);
        const r1 = BigNumber.from(c.reserve1);
        if (r0.lte(0) || r1.lte(0)) return { confident: false };
        reserveIn = inIsToken0 ? r0 : r1;
        reserveOut = inIsToken0 ? r1 : r0;
      } else {
        return { confident: false }; // Curve/Balancer: no local reserve model
      }
      hops.push({ reserveIn, reserveOut, feeBps });
    }

    if (current !== borrow) return { confident: false }; // must cycle back to borrow token

    const { input, output, profit } = findOptimalInput({
      hops,
      maxInput,
      premiumBps,
    });
    return { confident: true, optimalInput: input, output, profit };
  } catch (_) {
    return { confident: false };
  }
}

async function selectBestRoute(amountIn, slippageBips, routeList) {
  let best = null;
  let bestOut = BigNumber.from(0);

  // Use multi-metric Z-score combining price ratio and liquidity
  // This provides better filtering by considering both opportunity size and execution reliability
  const multiMetricZScores = computeMultiMetricZScore(routeList);

  // Filter routes with composite Z-score above threshold (positive = above average)
  let candidates = routeList.filter(
    (r, i) => multiMetricZScores[i] > ZSCORE_THRESH
  );

  logger.info(
    `[selectBestRoute] Multi-metric Z-score filtered ${routeList.length} routes down to ${candidates.length} (threshold=${ZSCORE_THRESH}).`
  );

  if (!candidates.length) {
    // Fallback: take top 50% by composite score if none exceed threshold
    const sortedByScore = routeList
      .map((r, i) => ({ route: r, zScore: multiMetricZScores[i] }))
      .sort((a, b) => b.zScore - a.zScore)
      .slice(0, Math.max(1, Math.floor(routeList.length / 2)))
      .map((item) => item.route);

    candidates = sortedByScore;
    logger.info(
      `[selectBestRoute] No routes exceeded threshold; using top ${candidates.length} by composite score.`
    );
  }

  candidates = await scoreRoutesWithML(candidates);
  candidates = candidates.slice(0, ML_TOP_K);
  logger.info(
    `After ML scoring, retaining top ${candidates.length} routes for simulation.`
  );

  let optimalBorrow = BigNumber.from(0);
  const simStart = Date.now();

  // Price-impact-aware ranking: evaluate each candidate's REAL net profit at its
  // optimal trade size. This filters out phantom spot-only cycles before they
  // ever reach an on-chain gas estimate, and picks the profit-maximising size.
  const evaluated = candidates
    .map((route) => ({
      route,
      ev: evaluateRouteRealistic(
        route,
        tokenAddresses.DAI,
        amountIn,
        FLASHLOAN_PREMIUM_INT
      ),
    }))
    .filter((e) => e.ev && e.ev.confident && e.ev.profit.gt(0));
  evaluated.sort((a, b) => (b.ev.profit.gt(a.ev.profit) ? 1 : -1));

  if (evaluated.length) {
    const top = evaluated[0];
    best = top.route;
    bestOut = top.ev.output;
    optimalBorrow = top.ev.optimalInput;
    logger.info(
      `[selectBestRoute] impact-aware winner id=${
        best.id
      } size=${ethers.utils.formatUnits(
        optimalBorrow,
        18
      )} DAI projProfit=${ethers.utils.formatUnits(top.ev.profit, 18)} DAI`
    );
  } else {
    // No confident-profitable route (e.g. Curve/Balancer hops without local
    // reserve data). Fall back to the coarse worker simulator; the on-chain
    // profit-or-revert guard still protects execution.
    const sims = await parallelSimulate(candidates, amountIn, slippageBips);
    sims.forEach(({ routeId, result }) => {
      const route = candidates.find((r) => r.id === routeId);
      if (result.gt(bestOut)) {
        bestOut = result;
        best = route;
      }
    });
    if (best) optimalBorrow = amountIn;
    logger.info(
      `[selectBestRoute] no impact-aware winner; used coarse simulation fallback.`
    );
  }

  const simEnd = Date.now();
  simulationHistogram.observe((simEnd - simStart) / 1000);
  avgLatency.set(simEnd - simStart);
  logger.info(`Route evaluation took ${simEnd - simStart} ms.`);

  if (!best) {
    logger.info(`No route yielded positive output after evaluation.`);
  }

  return { bestRoute: best, bestOut, optimalBorrow };
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
// On-Chain Sanity Check - Verify prices before execution
// ─────────────────────────────────────────────────────────────────────────────
const SANITY_CHECK_MAX_DEVIATION_BPS = 100; // 1% max price deviation allowed

/**
 * Performs on-chain sanity check before execution.
 * Verifies that pool reserves/prices haven't moved significantly since simulation.
 * @param {Object} route - The route to check
 * @param {Object} provider - Ethers provider for on-chain calls
 * @returns {Promise<{passed: boolean, reason?: string, details?: Object}>}
 */
async function performOnChainSanityCheck(route, provider) {
  if (!route || !route.hops || route.hops.length === 0) {
    return { passed: true, reason: "No hops to check" };
  }

  const deviations = [];
  const pairInterface = new ethers.utils.Interface([
    "function getReserves() view returns (uint112,uint112,uint32)",
  ]);
  const v3Interface = new ethers.utils.Interface([
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  ]);

  for (const hop of route.hops) {
    if (!hop.poolAddress || !ethers.utils.isAddress(hop.poolAddress)) continue;

    try {
      const dex = hop.dex || "uniswap_v2";

      if (dex === "uniswap_v2" || dex === "sushiswap_v2") {
        // V2 pools - check reserves
        const cached = reserveCache.get(hop.poolAddress);
        if (!cached) continue;

        const contract = new ethers.Contract(
          hop.poolAddress,
          pairInterface,
          provider
        );
        const [r0, r1] = await contract.getReserves();
        const onChainR0 = r0.toString();
        const onChainR1 = r1.toString();

        // Calculate deviation for reserve0
        const cachedR0 = BigNumber.from(cached.reserve0);
        const freshR0 = BigNumber.from(onChainR0);
        if (!cachedR0.isZero()) {
          const diff0 = freshR0.sub(cachedR0).abs();
          const devBps0 = diff0.mul(10000).div(cachedR0);
          deviations.push({
            pool: hop.poolAddress,
            dex,
            metric: "reserve0",
            devBps: devBps0.toNumber(),
          });
        }

        // Calculate deviation for reserve1
        const cachedR1 = BigNumber.from(cached.reserve1);
        const freshR1 = BigNumber.from(onChainR1);
        if (!cachedR1.isZero()) {
          const diff1 = freshR1.sub(cachedR1).abs();
          const devBps1 = diff1.mul(10000).div(cachedR1);
          deviations.push({
            pool: hop.poolAddress,
            dex,
            metric: "reserve1",
            devBps: devBps1.toNumber(),
          });
        }
      } else if (dex === "uniswap_v3") {
        // V3 pools - check sqrtPriceX96
        const cached = v3PriceCache.get(hop.poolAddress);
        if (!cached) continue;

        const contract = new ethers.Contract(
          hop.poolAddress,
          v3Interface,
          provider
        );
        const slot0 = await contract.slot0();
        const onChainPrice = slot0.sqrtPriceX96.toString();

        const cachedPrice = BigNumber.from(cached.sqrtPriceX96);
        const freshPrice = BigNumber.from(onChainPrice);
        if (!cachedPrice.isZero()) {
          const diff = freshPrice.sub(cachedPrice).abs();
          const devBps = diff.mul(10000).div(cachedPrice);
          deviations.push({
            pool: hop.poolAddress,
            dex,
            metric: "sqrtPriceX96",
            devBps: devBps.toNumber(),
          });
        }
      }
    } catch (err) {
      logger.warn(
        `[sanityCheck] Failed to verify pool ${hop.poolAddress}: ${err.message}`
      );
      // Don't fail the check if we can't read one pool - might be a transient RPC issue
    }
  }

  // Check if any deviation exceeds threshold
  const maxDeviation = Math.max(...deviations.map((d) => d.devBps), 0);
  const failedPools = deviations.filter(
    (d) => d.devBps > SANITY_CHECK_MAX_DEVIATION_BPS
  );

  if (failedPools.length > 0) {
    const reason = `Price deviation exceeds ${
      SANITY_CHECK_MAX_DEVIATION_BPS / 100
    }% for ${failedPools.length} pool(s): ${failedPools
      .map((p) => `${p.pool.slice(0, 10)}... (${p.devBps / 100}%)`)
      .join(", ")}`;
    logger.warn(`[sanityCheck] FAILED: ${reason}`);
    return {
      passed: false,
      reason,
      details: {
        maxDeviationBps: maxDeviation,
        failedPools,
        allDeviations: deviations,
      },
    };
  }

  logger.info(
    `[sanityCheck] PASSED: Max deviation ${maxDeviation / 100}% (threshold ${
      SANITY_CHECK_MAX_DEVIATION_BPS / 100
    }%)`
  );
  return {
    passed: true,
    details: { maxDeviationBps: maxDeviation, checkedPools: deviations.length },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Simulation & Execution Loop for One Chain
// ─────────────────────────────────────────────────────────────────────────────
async function simulateAndExecuteArbChain(
  chain,
  useFlashbots = true,
  options = {}
) {
  throwIfAborted(options.signal);
  const { provider, wallet, uniRouter, sushiRouter, arbContract } =
    getChainContext(chain);

  let currentSlippage = SLIPPAGE_DEFAULT_INT;
  let reward = -1;

  logger.info(`[${chain}] === Arbitrage Cycle Start ===`);
  arbAttempts.inc();

  // Circuit-breaker gate: skip the whole cycle if the breaker is open/emergency.
  const cbStatus = circuitBreaker.canTrade();
  if (!cbStatus.allowed) {
    logger.warn(
      `[${chain}] Circuit breaker ${cbStatus.state}: ${cbStatus.reason}. Skipping cycle.`
    );
    arbFailure.labels("circuitBreakerOpen").inc();
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }

  // Risk management: skip cycle if daily losses exceed limit
  try {
    const dailyPnL = await computeDailyPnL();
    const ddLimit = DAILY_DD_LIMIT_DAI;
    const pnLStr = dailyPnL.toString();
    const isNeg = pnLStr.startsWith("-");
    const absPnL = isNeg ? BigNumber.from(pnLStr.slice(1)) : dailyPnL;
    if (isNeg && absPnL.gte(ddLimit) && ddLimit.gt(0)) {
      logger.warn(
        `[${chain}] Daily drawdown limit reached (${ethers.utils.formatUnits(
          dailyPnL,
          18
        )} < -${ethers.utils.formatUnits(ddLimit, 18)}), skipping cycle.`
      );
      arbFailure.labels("drawdownLimit").inc();
      slippageAgent.update(reward);
      rlEpsilon.set(slippageAgent.epsilon);
      return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
    }
  } catch (err) {
    logger.warn(`[${chain}] drawdown check failed: ${err.message}`);
  }

  // 1. Check gas price
  let gasPrice;
  try {
    gasPrice = await provider.getGasPrice();
    logger.info(
      `[${chain}] Current gas price: ${ethers.utils.formatUnits(
        gasPrice,
        "gwei"
      )} Gwei.`
    );
  } catch (err) {
    logger.warn(`[${chain}] getGasPrice() error: ${err.message}`);
    arbFailure.labels("gasFetchError").inc();
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }
  if (gasPrice.gt(GAS_CEILING_BN)) {
    logger.info(
      `[${chain}] Gas price ${ethers.utils.formatUnits(
        gasPrice,
        "gwei"
      )} Gwei above ceiling ${ethers.utils.formatUnits(
        GAS_CEILING_BN,
        "gwei"
      )} Gwei—skipping cycle.`
    );
    arbFailure.labels("gasAboveCeiling").inc();
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }

  // 2. Build dynamic routes
  const ROUTES_TO_CHECK = await getAllRoutes(chain);
  logger.info(
    `[${chain}] getAllRoutes returned ${ROUTES_TO_CHECK.length} routes.`
  );
  if (!ROUTES_TO_CHECK.length) {
    arbFailure.labels("noRoutes").inc();
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }

  // 3. Ensure reserveCache is up to date - Extract all pools from route hops
  const allPoolsFromRoutes = [];
  for (const route of ROUTES_TO_CHECK.slice(0, REALTIME_POOL_LIMIT)) {
    if (route.hops && Array.isArray(route.hops)) {
      for (const hop of route.hops) {
        if (hop.poolAddress && ethers.utils.isAddress(hop.poolAddress)) {
          allPoolsFromRoutes.push({
            address: hop.poolAddress,
            dex: hop.dex || "uniswap_v2",
            poolId: hop.poolId, // For Balancer
          });
        }
      }
    } else if (route.poolAddress && ethers.utils.isAddress(route.poolAddress)) {
      // Fallback for flat pool structures
      allPoolsFromRoutes.push({
        address: route.poolAddress,
        dex: route.dex || "uniswap_v2",
        poolId: route.poolId,
      });
    }
  }

  // Deduplicate pools by address
  const seenPools = new Set();
  const uniquePools = allPoolsFromRoutes.filter((p) => {
    if (seenPools.has(p.address.toLowerCase())) return false;
    seenPools.add(p.address.toLowerCase());
    return true;
  });

  // Classify pools by DEX type
  const v2Pools = uniquePools
    .filter((p) => p.dex === "uniswap_v2" || p.dex === "sushiswap_v2")
    .map((p) => p.address);
  const v3Pools = uniquePools
    .filter((p) => p.dex === "uniswap_v3")
    .map((p) => p.address);
  const balancerPools = uniquePools
    .filter((p) => p.dex === "balancer")
    .map((p) => p.poolId || p.address);
  const curvePools = uniquePools
    .filter((p) => p.dex === "curve")
    .map((p) => p.address);

  logger.info(
    `[${chain}] Pool classification: V2=${v2Pools.length}, V3=${v3Pools.length}, Balancer=${balancerPools.length}, Curve=${curvePools.length}`
  );

  // 3a. Subscribe to V2 pools (Sync events)
  if (v2Pools.length > 0) {
    logger.info(
      `[${chain}] Subscribing to ${v2Pools.length} V2 pools for Sync events.`
    );
    await initSubscriptions(v2Pools);
  }

  // 3b. Subscribe to V3 pools (Swap events) if INCLUDE_V3 is enabled
  if (INCLUDE_V3 === "true" && v3Pools.length > 0) {
    logger.info(
      `[${chain}] Subscribing to ${v3Pools.length} V3 pools for Swap events.`
    );
    await initV3Subscriptions(v3Pools);
  }

  // 3c. Subscribe to Balancer pools if INCLUDE_BALANCER is enabled
  if (INCLUDE_BALANCER === "true" && balancerPools.length > 0) {
    logger.info(
      `[${chain}] Subscribing to ${balancerPools.length} Balancer pools for Swap events.`
    );
    await initBalancerSubscriptions(balancerPools);
  }

  // 3d. Subscribe to Curve pools if INCLUDE_CURVE is enabled
  if (INCLUDE_CURVE === "true" && curvePools.length > 0) {
    logger.info(
      `[${chain}] Subscribing to ${curvePools.length} Curve pools for TokenExchange events.`
    );
    await initCurveSubscriptions(curvePools);
  }

  // Fetch initial reserves for V2 pools not yet cached
  for (const poolAddr of v2Pools) {
    if (
      !reserveCache.has(poolAddr) ||
      Date.now() - reserveCache.get(poolAddr).timestamp > 5000
    ) {
      const ok = await safeFetchReserves({ poolAddress: poolAddr });
      if (ok) {
        logger.info(
          `[${chain}] Fetched multicall reserves for pool ${poolAddr}`
        );
      }
    }
  }

  // Log subscription stats
  const subStats = getSubscriptionStats();
  logger.info(
    `[${chain}] Subscription stats: V2=${subStats.v2.subscriptions}, V3=${subStats.v3.subscriptions}, Balancer=${subStats.balancer.subscriptions}, Curve=${subStats.curve.subscriptions}`
  );

  // 4. Get dynamic slippage
  let slipBips;
  try {
    const baseSlip = await getDynamicSlippage();
    slipBips = slippageAgent.select(baseSlip);
    logger.info(
      `[${chain}] RL-adjusted slippage: ${slipBips} bips (base ${baseSlip}).`
    );
    rlAction.set(slippageAgent.lastAction || 0);
    rlEpsilon.set(slippageAgent.epsilon);
  } catch {
    slipBips = slippageAgent.select(SLIPPAGE_DEFAULT_INT);
    logger.warn(`[${chain}] Using default slippage: ${slipBips} bips.`);
    rlAction.set(slippageAgent.lastAction || 0);
    rlEpsilon.set(slippageAgent.epsilon);
  }
  currentSlippage = slipBips;

  // 5. Determine borrow amount
  let borrowDAI = await getOptimalBorrowAmount("DAI", chain);
  if (borrowDAI.isZero()) {
    logger.info(`[${chain}] No available DAI liquidity to borrow—skipping.`);
    arbFailure.labels("noLiquidity").inc();
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }

  // 6. Select best route via simulation
  const { bestRoute, bestOut, optimalBorrow } = await selectBestRoute(
    borrowDAI,
    slipBips,
    ROUTES_TO_CHECK
  );
  if (!bestRoute) {
    logger.info(`[${chain}] No profitable route found after simulation.`);
    consecutiveNegatives++;
    arbFailure.labels("noProfitableRoute").inc();
    // "No profitable route" is a normal idle condition, not a fault — it must NOT
    // pause the on-chain contract. Real failures are handled by the off-chain
    // circuit breaker via recordTradeOutcome().
    if (consecutiveNegatives >= CB_NEG_THRESH_INT) {
      logger.debug(
        `[${chain}] ${consecutiveNegatives} consecutive idle cycles (no profitable route).`
      );
    }
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }
  logger.info(
    `[${chain}] Selected best route id=${
      bestRoute.id
    }, estimatedOut=${ethers.utils.formatUnits(bestOut, 18)} DAI.`
  );
  consecutiveNegatives = 0;

  // Resize the borrow to the per-route profit-maximising amount (price-impact
  // aware), never exceeding the available-liquidity ceiling.
  if (optimalBorrow && optimalBorrow.gt(0) && optimalBorrow.lte(borrowDAI)) {
    borrowDAI = optimalBorrow;
    logger.info(
      `[${chain}] Optimal borrow size: ${ethers.utils.formatUnits(
        borrowDAI,
        18
      )} DAI.`
    );
  }

  // Rebuild executable steps for the chosen route
  buildStepsFromHops(bestRoute);

  // 7. Compute total debt and net profit
  const premBps = FLASHLOAN_PREMIUM_INT;
  const totalDebtDAI = borrowDAI.mul(10000 + premBps).div(10000);
  const potentialProfitDAI = bestOut.sub(totalDebtDAI);
  logger.info(
    `[${chain}] potentialProfitDAI (after premium): ${ethers.utils.formatUnits(
      potentialProfitDAI,
      18
    )} DAI.`
  );
  const minProfitThreshold = ethers.utils.parseUnits(
    MIN_PROFIT_DAI || OPTIONAL_ENV_DEFAULTS.MIN_PROFIT_DAI,
    18
  );
  if (potentialProfitDAI.lte(minProfitThreshold)) {
    logger.info(
      `[${chain}] Not profitable after flashloan premium (threshold ${MIN_PROFIT_DAI}).`
    );
    arbFailure.labels("notProfitableAfterPremium").inc();
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }

  // 8. Re-fetch fresh reserves for bestRoute
  const freshOk = await safeFetchReserves(bestRoute.hops);
  if (freshOk) {
    logger.info(`[${chain}] Fetched fresh reserves for best route.`);
  }

  // 9. Build the multi-DEX ArbitrageData bundle (re-quoted on-chain hop-by-hop).
  let arbData;
  try {
    arbData = await buildArbitrageData(
      bestRoute,
      {
        slippageBips: slipBips,
        minProfit: minProfitThreshold,
        borrowToken: tokenAddresses.DAI,
        borrowAmount: borrowDAI,
      },
      provider
    );
    logger.info(
      `[${chain}] buildArbitrageData returned ${arbData.steps.length}-step route.`
    );
  } catch (err) {
    logger.error(`[${chain}] buildArbitrageData error: ${err.message}`);
    arbFailure.labels("swapDataFail").inc();
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }

  // 10. Encode initiateFlashLoan calldata + estimate gas against the REAL
  //     entrypoint (the Aave executeOperation callback can only be called by the
  //     pool, so estimating it from the bot wallet always reverts).
  let flashloanCalldata;
  try {
    flashloanCalldata = arbContract.interface.encodeFunctionData(
      "initiateFlashLoan",
      [arbData]
    );
  } catch (err) {
    logger.error(
      `[${chain}] Failed to encode initiateFlashLoan calldata: ${err.message}`
    );
    arbFailure.labels("calldataEncodeFail").inc();
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }

  let estimateGas;
  try {
    estimateGas = await arbContract.estimateGas.initiateFlashLoan(arbData);
    logger.info(
      `[${chain}] Gas estimate for initiateFlashLoan: ${estimateGas.toString()}`
    );
  } catch (err) {
    logger.error(
      `[${chain}] estimateGas.initiateFlashLoan() failed (likely unprofitable at execution): ${err.message}`
    );
    arbFailure.labels("gasEstimateFail").inc();
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }

  // 11. Convert gas cost to DAI
  let estCostDAI;
  try {
    const estCostETH = gasPrice.mul(estimateGas);
    const amounts = await uniRouter.getAmountsOut(estCostETH, [
      tokenAddresses.WETH,
      tokenAddresses.DAI,
    ]);
    estCostDAI = amounts[amounts.length - 1];
    logger.info(
      `[${chain}] Estimated gas cost in DAI: ${ethers.utils.formatUnits(
        estCostDAI,
        18
      )}`
    );
  } catch (err) {
    logger.error(`[${chain}] Cannot convert gasCost ETH→DAI: ${err.message}`);
    arbFailure.labels("gasConvertFail").inc();
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }

  const netDAI = potentialProfitDAI.sub(estCostDAI);
  logger.info(
    `[${chain}] Net DAI (after gas): ${ethers.utils.formatUnits(
      netDAI,
      18
    )} DAI.`
  );

  try {
    recordOpportunity({
      id: bestRoute.id,
      chain,
      timestamp: Date.now(),
      swapData: cloneSwapDataForStore(arbData),
      borrowAmount: borrowDAI,
      estimatedOut: bestOut,
      gasEstimate: estimateGas,
      gasPrice,
      gasCostDai: estCostDAI,
      premiumBips: premBps,
      premiumWei: totalDebtDAI.sub(borrowDAI),
      netProfit: netDAI,
    });
  } catch (err) {
    logger.warn(`Failed to record opportunity snapshot: ${err.message}`);
  }

  if (netDAI.lte(minProfitThreshold)) {
    logger.info(
      `[${chain}] Net profit ${ethers.utils.formatUnits(
        netDAI,
        18
      )} below threshold ${ethers.utils.formatUnits(
        minProfitThreshold,
        18
      )} DAI.`
    );
    arbFailure.labels("netBelowMinProfit").inc();
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }
  avgProfit.set(parseFloat(ethers.utils.formatUnits(netDAI, 18)));

  // 11b. Risk Manager Validation (Tier-1 Feature)
  if (ENABLE_RISK_MANAGER) {
    try {
      const riskValidation = validateTrade({
        volumeDai: parseFloat(ethers.utils.formatUnits(borrowDAI, 18)),
        expectedProfitDai: parseFloat(ethers.utils.formatUnits(netDAI, 18)),
        route: bestRoute.id,
      });

      if (!riskValidation.valid) {
        logger.warn(
          `[${chain}] Risk validation FAILED: ${riskValidation.errors.join(
            ", "
          )}`
        );
        arbFailure.labels("riskValidationFailed").inc();
        slippageAgent.update(reward);
        rlEpsilon.set(slippageAgent.epsilon);
        return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
      }
      logger.info(
        `[${chain}] Risk validation PASSED. Remaining daily risk: ${riskValidation.riskMetrics.remainingRisk.toFixed(
          2
        )}%`
      );
    } catch (err) {
      logger.warn(
        `[${chain}] Risk validation error (proceeding): ${err.message}`
      );
    }
  }

  // 11c. On-chain sanity check before execution
  try {
    const sanityResult = await performOnChainSanityCheck(bestRoute, provider);
    if (!sanityResult.passed) {
      logger.warn(
        `[${chain}] On-chain sanity check FAILED: ${sanityResult.reason}`
      );
      arbFailure.labels("sanityCheckFailed").inc();
      slippageAgent.update(reward);
      rlEpsilon.set(slippageAgent.epsilon);
      return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
    }
    logger.info(`[${chain}] On-chain sanity check PASSED.`);
  } catch (err) {
    logger.warn(
      `[${chain}] Sanity check error (proceeding anyway): ${err.message}`
    );
    // Don't block execution on sanity check errors - it's a safety feature, not a hard requirement
  }

  // 12. Attempt Flashbots bundle
  let flashbotsSuccess = false;
  if (useFlashbots) {
    try {
      const fbProvider = await FlashbotsBundleProvider.create(
        provider,
        wallet,
        FLASHBOTS_RELAY_URL
      );
      logger.info(`[${chain}] FlashbotsProvider created.`);

      const feeHistory = await provider.send("eth_feeHistory", [
        1,
        "latest",
        [25],
      ]);
      let baseFeeNext = BigNumber.from(feeHistory.baseFeePerGas.slice(-1)[0])
        .mul(BigNumber.from(1025))
        .div(BigNumber.from(1000));
      const monthlyPrio = baseFeeNext
        .mul(BigNumber.from(PRIO_PERCENT_INT))
        .div(BigNumber.from(100));
      const maxPrio = PRIO_FEE_MAX;
      let chosenPrio = monthlyPrio.gt(maxPrio) ? maxPrio : monthlyPrio;
      logger.info(
        `[${chain}] Base fee Next: ${ethers.utils.formatUnits(
          baseFeeNext,
          "gwei"
        )} Gwei, chosen priority fee: ${ethers.utils.formatUnits(
          chosenPrio,
          "gwei"
        )} Gwei.`
      );

      const signedBundles = [];
      for (let i = 0; i < BUNDLE_COUNT; i++) {
        const tx = {
          to: arbContract.address,
          data: flashloanCalldata,
          gasLimit: estimateGas.mul(12).div(10),
          maxFeePerGas: baseFeeNext.add(chosenPrio),
          maxPriorityFeePerGas: chosenPrio,
        };
        const signed = await fbProvider.signBundle([
          { signer: wallet, transaction: tx },
        ]);
        signedBundles.push(signed);
        logger.info(`[${chain}] Signed Flashbots bundle #${i}.`);
      }

      const blockNumber = await provider.getBlockNumber();
      logger.info(
        `[${chain}] Current block number: ${blockNumber}. Attempting bundle at block ${
          blockNumber + 1
        }.`
      );
      const respArray = await Promise.all(
        signedBundles.map((sb) => fbProvider.sendRawBundle(sb, blockNumber + 1))
      );

      for (let i = 0; i < respArray.length; i++) {
        const resp = respArray[i];
        const waitRes = await resp.wait();
        if (waitRes === 0) {
          logger.info(`[${chain}] Flashbots bundle #${i} included.`);
          flashbotsSuccess = true;
          break;
        } else {
          logger.warn(
            `[${chain}] Flashbots bundle #${i} not included (waitRes=${waitRes}).`
          );
        }
      }

      if (!flashbotsSuccess) {
        logger.info(
          `[${chain}] No bundle included on first attempt. Retrying up to ${TIP_RETRY_LIMIT} times.`
        );
        for (
          let attempt = 0;
          attempt < TIP_RETRY_LIMIT && !flashbotsSuccess;
          attempt++
        ) {
          chosenPrio = chosenPrio
            .mul(BigNumber.from(TIP_MULTIPLIER_NUM_INT))
            .div(BigNumber.from(TIP_MULTIPLIER_DEN_INT));
          if (chosenPrio.gt(maxPrio)) chosenPrio = maxPrio;

          const txRetry = {
            to: arbContract.address,
            data: flashloanCalldata,
            gasLimit: estimateGas.mul(12).div(10),
            maxFeePerGas: baseFeeNext.add(chosenPrio),
            maxPriorityFeePerGas: chosenPrio,
          };
          const signedRetry = await fbProvider.signBundle([
            { signer: wallet, transaction: txRetry },
          ]);
          const respRetry = await fbProvider.sendRawBundle(
            signedRetry,
            blockNumber + attempt + 1
          );
          const waitRetry = await respRetry.wait();
          if (waitRetry === 0) {
            logger.info(
              `[${chain}] Flashbots bundle retry #${attempt + 1} included.`
            );
            flashbotsSuccess = true;
            break;
          } else {
            logger.warn(
              `[${chain}] Flashbots bundle retry #${
                attempt + 1
              } not included (waitRetry=${waitRetry}).`
            );
          }
        }
      }

      if (flashbotsSuccess) {
        arbSuccess.inc();
        const tradeResult = await insertTrade({
          route: arbData.route,
          profit: netDAI,
          txHash: "flashbots-bundle",
          timestamp: Date.now(),
          status: "flashbots",
        });
        if (tradeResult?.ok) {
          logger.info(`[${chain}] Trade recorded as flashbots.`);
        } else if (tradeResult?.error?.code === "DB_DISABLED") {
          logger.info(
            `[${chain}] Persistence disabled; flashbots trade not stored.`
          );
        } else if (tradeResult?.error) {
          logger.warn(
            `[${chain}] Failed to persist flashbots trade (${tradeResult.error.code}): ${tradeResult.error.message}`
          );
        }
        reward = parseFloat(ethers.utils.formatUnits(netDAI, 18));
        recordTradeOutcome({ success: true, profit: netDAI, gasPrice });

        // Record trade in risk manager (Tier-1 Feature)
        if (ENABLE_RISK_MANAGER) {
          try {
            recordTrade({
              profitDai: ethers.utils.formatUnits(netDAI, 18),
              volumeDai: ethers.utils.formatUnits(borrowDAI, 18),
              gasUsed: estimateGas.toString(),
              gasCostDai: ethers.utils.formatUnits(estCostDAI, 18),
              route: bestRoute.id,
              success: true,
            });
            logger.info(`[${chain}] Trade recorded in risk manager.`);
          } catch (rmErr) {
            logger.warn(
              `[${chain}] Risk manager record failed: ${rmErr.message}`
            );
          }
        }

        return { executed: true, estimatedProfitInDai: netDAI };
      } else {
        logger.warn(
          `[${chain}] Flashbots bundles failed—falling back to multi-relay or public TX.`
        );
      }
    } catch (err) {
      logger.warn(`[${chain}] Flashbots error: ${err.message}`);
    }
  }

  // 12b. Multi-Relay Bundle Submission (Tier-1 Feature)
  if (ENABLE_MULTI_RELAY && !flashbotsSuccess) {
    try {
      logger.info(`[${chain}] Attempting multi-relay bundle submission...`);

      // Calculate optimal tip using dynamic tip calculator
      let optimalTip;
      if (ENABLE_DYNAMIC_TIPS) {
        const gasCompetition = await analyzeGasCompetition(provider);
        const competitionLevel = estimateCompetitionLevel({
          profitUsd: parseFloat(ethers.utils.formatUnits(netDAI, 18)),
          isPopularPair: false,
        });

        optimalTip = calculateOptimalTip({
          expectedProfitWei: netDAI,
          gasUsed: estimateGas,
          baseFeePerGas: gasPrice,
          competitionLevel,
          blocksUntilTarget: 1,
          urgency: "normal",
        });

        logger.info(
          `[${chain}] Dynamic tip: ${ethers.utils.formatUnits(
            optimalTip.tipWei,
            "ether"
          )} ETH ` +
            `(${
              optimalTip.tipBps / 100
            }% of profit), competition: ${competitionLevel}`
        );
      } else {
        // Fallback to simple tip calculation
        optimalTip = {
          priorityFeePerGas: ethers.utils.parseUnits("2", "gwei"),
          maxFeePerGas: gasPrice.add(ethers.utils.parseUnits("2", "gwei")),
        };
      }

      const blockNumber = await provider.getBlockNumber();
      const targetBlock = blockNumber + 1;

      // Build and sign the transaction
      const tx = {
        to: arbContract.address,
        data: flashloanCalldata,
        gasLimit: estimateGas.mul(12).div(10),
        maxFeePerGas:
          optimalTip.maxFeePerGas || gasPrice.add(optimalTip.priorityFeePerGas),
        maxPriorityFeePerGas: optimalTip.priorityFeePerGas,
        chainId: parseInt(process.env.CHAIN_ID || "1"),
        nonce: await wallet.getTransactionCount("pending"),
        type: 2,
      };

      const signedTx = await wallet.signTransaction(tx);

      // Submit to all relays in parallel
      const relayResults = await submitToAllRelays(
        wallet,
        [signedTx],
        targetBlock,
        {
          timeout: 5000,
        }
      );

      logger.info(
        `[${chain}] Multi-relay submission: ${relayResults.successful}/${relayResults.totalRelays} succeeded`
      );

      // Check if any relay succeeded (we'll verify inclusion separately)
      if (relayResults.successful > 0) {
        // Wait briefly for potential inclusion
        await new Promise((resolve) => setTimeout(resolve, 15000));

        // Check if transaction was included
        const receipt = await provider.getTransactionReceipt(
          ethers.utils.keccak256(signedTx)
        );
        if (receipt && receipt.status === 1) {
          logger.info(`[${chain}] Multi-relay bundle INCLUDED!`);
          arbSuccess.inc();

          const tradeResult = await insertTrade({
            route: arbData.route,
            profit: netDAI,
            txHash: receipt.transactionHash,
            timestamp: Date.now(),
            status: "multi-relay",
          });

          if (tradeResult?.ok) {
            logger.info(`[${chain}] Trade recorded as multi-relay.`);
          }

          reward = parseFloat(ethers.utils.formatUnits(netDAI, 18));

          if (ENABLE_RISK_MANAGER) {
            recordTrade({
              profitDai: ethers.utils.formatUnits(netDAI, 18),
              volumeDai: ethers.utils.formatUnits(borrowDAI, 18),
              gasUsed: receipt.gasUsed.toString(),
              gasCostDai: ethers.utils.formatUnits(estCostDAI, 18),
              route: bestRoute.id,
              success: true,
            });
          }

          recordTradeOutcome({ success: true, profit: netDAI, gasPrice });
          slippageAgent.update(reward);
          rlEpsilon.set(slippageAgent.epsilon);
          return { executed: true, estimatedProfitInDai: netDAI };
        }
      }

      logger.warn(
        `[${chain}] Multi-relay bundles not included—falling back to public TX.`
      );
    } catch (err) {
      logger.warn(`[${chain}] Multi-relay error: ${err.message}`);
    }
  }

  // 13. Public fallback transaction — DISABLED by default. An arbitrage tx in the
  //     public mempool is trivially front-run/sandwiched, so we only broadcast it
  //     when explicitly opted in via ALLOW_PUBLIC_MEMPOOL_FALLBACK=true.
  if (!ALLOW_PUBLIC_FALLBACK) {
    logger.warn(
      `[${chain}] Private submission failed; public mempool fallback disabled — dropping opportunity.`
    );
    arbFailure.labels("privateOnlyDropped").inc();
    reward = -1;
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    recordTradeOutcome({ success: false, profit: BigNumber.from(0), gasPrice });
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }
  try {
    logger.info(
      `[${chain}] Sending public initiateFlashLoan transaction (fallback opted-in).`
    );
    const txResp = await arbContract.initiateFlashLoan(arbData, {
      gasLimit: estimateGas.mul(12).div(10),
    });
    logger.info(`[${chain}] Public TX sent: ${txResp.hash}`);
    await txResp.wait();
    logger.info(`[${chain}] Public TX mined: ${txResp.hash}`);
    arbSuccess.inc();
    const tradeResult = await insertTrade({
      route: arbData.route,
      profit: netDAI,
      txHash: txResp.hash,
      timestamp: Date.now(),
      status: "public",
    });
    if (tradeResult?.ok) {
      logger.info(`[${chain}] Trade recorded as public.`);
    } else if (tradeResult?.error?.code === "DB_DISABLED") {
      logger.info(`[${chain}] Persistence disabled; public trade not stored.`);
    } else if (tradeResult?.error) {
      logger.warn(
        `[${chain}] Failed to persist public trade (${tradeResult.error.code}): ${tradeResult.error.message}`
      );
    }
    reward = parseFloat(ethers.utils.formatUnits(netDAI, 18));
    recordTradeOutcome({ success: true, profit: netDAI, gasPrice });
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: true, estimatedProfitInDai: netDAI };
  } catch (err) {
    logger.error(`[${chain}] Public TX failed: ${err.message}`);
    arbFailure.labels("publicTxFail").inc();
    reward = -1;
    recordTradeOutcome({ success: false, profit: BigNumber.from(0), gasPrice });
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Connext Cross-Chain Profit Forwarding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize Connext client for cross-chain profit forwarding
 * NOTE: Connext is ENABLED BY DEFAULT when CONNEXT_ADAPTER_ADDRESS is set.
 * Set CONNEXT_AUTO_FORWARD=false to disable auto-forwarding.
 */
async function initConnext(chain) {
  const connextAdapterAddress = process.env.CONNEXT_ADAPTER_ADDRESS;
  if (!connextAdapterAddress) {
    logger.info(
      "[Connext] CONNEXT_ADAPTER_ADDRESS not set, cross-chain forwarding disabled"
    );
    return false;
  }

  // Auto-forward is ENABLED by default when adapter is configured
  // Set CONNEXT_AUTO_FORWARD=false to explicitly disable
  const autoForwardEnv = process.env.CONNEXT_AUTO_FORWARD;
  connextAutoForwardEnabled = autoForwardEnv !== "false"; // Enabled unless explicitly "false"

  try {
    const { provider, wallet } = getChainContext(chain);
    connextConfig = await initConnextClient({
      adapterAddress: connextAdapterAddress,
      provider,
      signer: wallet,
      config: {
        autoForwardEnabled: connextAutoForwardEnabled,
        autoForwardThreshold: ethers.utils.parseUnits(
          process.env.CONNEXT_AUTO_FORWARD_THRESHOLD || "100",
          18
        ),
        minForwardAmount: ethers.utils.parseUnits(
          process.env.CONNEXT_MIN_FORWARD_AMOUNT || "10",
          18
        ),
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

    const baseStatus = {
      connextEnabled: true,
      autoForwardEnabled: connextAutoForwardEnabled,
      accumulatedProfits: accumulatedBalance.toString(),
      accumulatedProfitsFormatted: ethers.utils.formatUnits(
        accumulatedBalance,
        18
      ),
      pendingTransfers: pendingTransfersList.length,
      threshold: autoForwardCheck.threshold
        ? ethers.utils.formatUnits(autoForwardCheck.threshold, 18)
        : null,
    };

    if (autoForwardCheck.shouldForward) {
      logger.info(
        `[Connext] Auto-forward threshold reached, forwarding ${ethers.utils.formatUnits(
          autoForwardCheck.balance,
          18
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
          amountFormatted: ethers.utils.formatUnits(result.amount, 18),
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
        ? ethers.utils.formatUnits(autoForwardCheck.balance, 18)
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
      accumulatedProfitsFormatted: ethers.utils.formatUnits(accumulated, 18),
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
  throwIfAborted(options.signal);
  const chains = [DEFAULT_CHAIN];
  let outcome = { executed: false, estimatedProfitInDai: BigNumber.from(0) };

  // Initialize Connext on first run if not already done
  if (!connextInitialized && process.env.CONNEXT_ADAPTER_ADDRESS) {
    await initConnext(DEFAULT_CHAIN);
  }

  for (const chain of chains) {
    try {
      const res = await simulateAndExecuteArbChain(
        chain,
        useFlashbots,
        options
      );
      if (res.executed) {
        outcome = res;

        // Check and forward profits after successful arbitrage
        // Connext is enabled by default when adapter address is configured
        if (connextInitialized) {
          const forwardResult = await checkAndForwardProfits(
            tokenAddresses.DAI,
            res.estimatedProfitInDai
          );
          outcome.connextForward = forwardResult;
          outcome.connextStatus = {
            initialized: true,
            autoForwardEnabled: connextAutoForwardEnabled,
            ...forwardResult,
          };
        } else if (process.env.CONNEXT_ADAPTER_ADDRESS) {
          // Connext configured but not initialized - include status
          outcome.connextStatus = {
            initialized: false,
            reason: "Adapter configured but initialization failed",
          };
        }
      }
    } catch (err) {
      logger.error(`[${chain}] Fatal error in cycle: ${err.message}`);
    }
  }

  return outcome;
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
module.exports.getRecentOpportunities = getRecentOpportunities;
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
module.exports.pauseTrading = () => riskManager.pause("Manual pause requested");
module.exports.resumeTrading = () => riskManager.resume();
module.exports.forceResumeTrading = () => riskManager.forceResume();
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
async function executeBackrun(opportunity, chain = DEFAULT_CHAIN) {
  const MIN_BACKRUN_PROFIT_ETH = parseFloat(
    process.env.MIN_BACKRUN_PROFIT_ETH || "0.005"
  );

  try {
    // Check minimum profit threshold
    if (opportunity.estimatedProfitEth < MIN_BACKRUN_PROFIT_ETH) {
      logger.debug(
        `[Backrun] Skipped: profit ${opportunity.estimatedProfitEth} ETH below threshold`
      );
      return { executed: false, reason: "below_threshold" };
    }

    // Validate with risk manager
    if (ENABLE_RISK_MANAGER) {
      const validation = validateTrade({
        volumeDai: opportunity.estimatedProfitEth * 2000, // Rough ETH->DAI conversion
        expectedProfitDai: opportunity.estimatedProfitEth * 2000,
        route: `backrun-${opportunity.targetTx.slice(0, 10)}`,
      });

      if (!validation.valid) {
        logger.warn(
          `[Backrun] Risk validation failed: ${validation.errors.join(", ")}`
        );
        return {
          executed: false,
          reason: "risk_validation_failed",
          errors: validation.errors,
        };
      }
    }

    const { provider, wallet, arbContract, uniRouter } = getChainContext(chain);

    // Get current gas price and calculate competitive priority fee
    const gasPrice = await provider.getGasPrice();
    const targetGasPrice = ethers.BigNumber.from(
      opportunity.targetGasPrice || gasPrice
    );

    // Our gas price must be higher than target to be included after
    const ourPriorityFee = targetGasPrice.mul(110).div(100); // 10% higher
    const baseFee = gasPrice.sub(ethers.utils.parseUnits("2", "gwei")); // Estimate base fee

    logger.info(
      `[Backrun] Executing backrun for target ${opportunity.targetTx.slice(
        0,
        10
      )}... ` +
        `estimated profit: ${opportunity.estimatedProfitEth.toFixed(6)} ETH`
    );

    // Build the backrun swap transaction
    // For a backrun, we swap in the opposite direction of the target
    if (!opportunity.path || opportunity.path.length < 2) {
      logger.warn("[Backrun] No path available for backrun");
      return { executed: false, reason: "no_path" };
    }

    const reversePath = [...opportunity.path].reverse();
    const amountIn = ethers.utils.parseEther(
      (opportunity.estimatedProfitEth * 10).toFixed(6) // Size the trade based on profit
    );

    // Build swap transaction
    const deadline = Math.floor(Date.now() / 1000) + 120; // 2 minutes
    const swapData = uniRouter.interface.encodeFunctionData(
      "swapExactTokensForTokens",
      [
        amountIn,
        0, // Accept any amount out (we're backrunning, price is favorable)
        reversePath,
        arbContract.address,
        deadline,
      ]
    );

    const tx = {
      to: uniRouter.address,
      data: swapData,
      gasLimit: ethers.BigNumber.from(300_000),
      maxFeePerGas: baseFee.add(ourPriorityFee),
      maxPriorityFeePerGas: ourPriorityFee,
      chainId: parseInt(process.env.CHAIN_ID || "1"),
      nonce: await wallet.getTransactionCount(),
      type: 2,
    };

    const signedTx = await wallet.signTransaction(tx);
    const blockNumber = await provider.getBlockNumber();
    const targetBlock = blockNumber + 1;

    // Submit via multi-relay if enabled
    if (ENABLE_MULTI_RELAY) {
      const relayResults = await submitToAllRelays(
        wallet,
        [signedTx],
        targetBlock,
        {
          timeout: 3000, // Faster timeout for backruns
        }
      );

      logger.info(
        `[Backrun] Multi-relay submission: ${relayResults.successful}/${relayResults.totalRelays} succeeded`
      );

      if (relayResults.successful > 0) {
        // Record to risk manager
        if (ENABLE_RISK_MANAGER) {
          recordTrade({
            profitDai: (opportunity.estimatedProfitEth * 2000).toString(),
            volumeDai: (opportunity.estimatedProfitEth * 2000 * 10).toString(),
            gasUsed: "300000",
            gasCostDai: ethers.utils.formatUnits(
              tx.maxFeePerGas.mul(300000),
              18
            ),
            route: `backrun-${opportunity.targetTx.slice(0, 10)}`,
            success: true,
          });
        }

        return { executed: true, relayResults };
      }
    } else {
      // Direct submission (not recommended for backruns due to MEV)
      logger.warn(
        "[Backrun] Multi-relay disabled, skipping backrun to avoid MEV"
      );
      return { executed: false, reason: "multi_relay_disabled" };
    }

    return { executed: false, reason: "no_relay_success" };
  } catch (err) {
    logger.error(`[Backrun] Execution failed: ${err.message}`);
    return { executed: false, reason: "error", error: err.message };
  }
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
  (async () => {
    while (true) {
      await simulateAndExecuteArb();
      await new Promise((r) => setTimeout(r, 10_000));
    }
  })();
}
