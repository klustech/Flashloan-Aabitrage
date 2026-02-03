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
    select(baseBips) {
      this.lastAction = 0;
      return baseBips;
    },
    update() {},
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
    /* eslint-disable no-constant-condition */
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
const { buildSwapDataFromDynamic } = require("./scripts/swapDataBuilder");

// ─────────────────────────────────────────────────────────────────────────────
// Imports: Price Ingestion & Multicall Cache (from server/scripts/)
// ─────────────────────────────────────────────────────────────────────────────
const {
  initSubscriptions,
  reserveCache,
  fetchMulticallReservesForRoute,
} = require("./scripts/priceIngestion");

// ─────────────────────────────────────────────────────────────────────────────
// Imports: DEX Quote Utilities (from server/scripts/)
// ─────────────────────────────────────────────────────────────────────────────
const { getV3Quote } = require("./scripts/v3Utils");
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
const { insertTrade, pool: dbPool, isDbEnabled, waitForPoolReady } = require("./dbClient");

// ─────────────────────────────────────────────────────────────────────────────
// Imports: Slack Alert Utility (from server/scripts/)
// ─────────────────────────────────────────────────────────────────────────────
const { sendSlackAlert } = require("./scripts/slackUtils");
const { buildStepsFromHops } = require("../utils/buildStepsFromHops");
const safeAsync = require("../utils/safeAsync");

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
    token: data.token,
    paths: data.paths.map((path) => [...path]),
    minOuts: data.minOuts.map((value) =>
      ethers.BigNumber.isBigNumber(value)
        ? value
        : ethers.BigNumber.from(value)
    ),
    minProfit: ethers.BigNumber.from(data.minProfit),
    route: data.route,
  };
}

function recordOpportunity(opportunity) {
  recentOpportunities.unshift(opportunity);
  if (recentOpportunities.length > RECENT_OPPORTUNITY_LIMIT) {
    recentOpportunities.length = RECENT_OPPORTUNITY_LIMIT;
  }
}

function getRecentOpportunities() {
  return recentOpportunities.slice();
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
  ZSCORE_THRESHOLD: "3",
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
const DEFAULT_CHAIN = "ethereum";

const chainContexts = new Map();

function getChainContext(chain) {
  if (!chainContexts.has(chain)) {
    const provider = new ethers.providers.JsonRpcProvider({
      url: MAINNET_RPC_URL,
      timeout: 120_000,
    });
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const context = {
      provider,
      wallet,
      arbContract: new ethers.Contract(
        VALID_CONTRACT_ADDRESS,
        arbitrageABI,
        wallet
      ),
    };
    context.uniRouter = new ethers.Contract(
      UNISWAP_ROUTER_ADDRESS,
      minimalRouterABI,
      wallet
    );
    context.sushiRouter = new ethers.Contract(
      SUSHISWAP_ROUTER_ADDRESS,
      minimalRouterABI,
      wallet
    );
    chainContexts.set(chain, context);
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
  continuous:
    (RL_CONTINUOUS || OPTIONAL_ENV_DEFAULTS.RL_CONTINUOUS) === "true",
  maxOffsetBips: parseFloat(
    RL_MAX_OFFSET_BIPS || OPTIONAL_ENV_DEFAULTS.RL_MAX_OFFSET_BIPS,
  ),
  epsilonStart: parseFloat(
    RL_EPSILON_START || OPTIONAL_ENV_DEFAULTS.RL_EPSILON_START,
  ),
  epsilonMin: parseFloat(
    RL_EPSILON_MIN || OPTIONAL_ENV_DEFAULTS.RL_EPSILON_MIN,
  ),
  epsilonDecay: parseFloat(
    RL_EPSILON_DECAY || OPTIONAL_ENV_DEFAULTS.RL_EPSILON_DECAY,
  ),
  alpha: parseFloat(RL_ALPHA || OPTIONAL_ENV_DEFAULTS.RL_ALPHA),
  saveDebounceMs: parseInt(
    RL_SAVE_DEBOUNCE_MS || OPTIONAL_ENV_DEFAULTS.RL_SAVE_DEBOUNCE_MS,
    10,
  ),
  metrics: { rlAction, rlEpsilon },
  logger,
});

// ─────────────────────────────────────────────────────────────────────────────
// Token & DEX Setup (addresses must be in .env)
// ─────────────────────────────────────────────────────────────────────────────
const tokenAddresses = {
  DAI: (TOKENS_DAI || "").toLowerCase(),
  WETH: (TOKENS_WETH || "").toLowerCase(),
  USDC: (TOKENS_USDC || "").toLowerCase(),
  USDT: (TOKENS_USDT || "").toLowerCase(),
  UNI: (TOKENS_UNI || "").toLowerCase(),
};

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
  const trial = ethers.utils.parseUnits("100", 18);
  const chosen = trial.lte(availableLiquidity) ? trial : availableLiquidity;
  logger.info(
    `[${chain}] Optimal borrow amount for ${token}: ${ethers.utils.formatUnits(
      chosen,
      18
    )}`
  );
  return chosen;
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

// ─────────────────────────────────────────────────────────────────────────────
// ML Scoring: Attach score to each route via ML microservice
// ─────────────────────────────────────────────────────────────────────────────
async function scoreRoutesWithML(routeDefs) {
  try {
    if (!ML_MODEL_ENDPOINT) {
      return routeDefs;
    }
    const features = routeDefs.map((r) => [
      r.hops.length,
      r.liquidity || 0,
      r.fee || 3000,
      r.volatility || 0,
      r.estimatedGasCost || 0,
      r.historicalSuccessCount || 0,
    ]);
    const mlRes = await axios.post(ML_MODEL_ENDPOINT, {
      features,
    });
    const probabilities = mlRes.data.probabilities;
    routeDefs.forEach((r, i) => {
      r.score = probabilities[i];
    });
    logger.info(
      `ML scoring assigned probabilities to ${routeDefs.length} routes.`
    );
    return routeDefs.sort((a, b) => b.score - a.score);
  } catch (err) {
    logger.warn(
      `ML scoring error: ${err.message}. Proceeding without ML ranking.`
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
async function selectBestRoute(amountIn, slippageBips, routeList) {
  let best = null;
  let bestOut = BigNumber.from(0);

  const stableValues = routeList.map((r) => r.estimatedPriceRatio || 1);
  const zScores = computeZScore(stableValues);
  let candidates = routeList.filter(
    (r, i) => Math.abs(zScores[i]) > ZSCORE_THRESH
  );
  logger.info(
    `Filtered ${routeList.length} routes down to ${candidates.length} by Z-score threshold ${ZSCORE_THRESH}.`
  );
  if (!candidates.length) {
    candidates = routeList;
    logger.info(
      `No routes exceeded Z-score threshold; using all ${routeList.length} as candidates.`
    );
  }

  candidates = await scoreRoutesWithML(candidates);
  candidates = candidates.slice(0, ML_TOP_K);
  logger.info(
    `After ML scoring, retaining top ${candidates.length} routes for simulation.`
  );

  // Workers will compile hops into executable steps

  const simStart = Date.now();
  const sims = await parallelSimulate(candidates, amountIn, slippageBips);
  const simEnd = Date.now();
  simulationHistogram.observe((simEnd - simStart) / 1000);
  avgLatency.set(simEnd - simStart);
  logger.info(`Simulation took ${simEnd - simStart} ms.`);

  sims.forEach(({ routeId, result }) => {
    const route = candidates.find((r) => r.id === routeId);
    if (result.gt(bestOut)) {
      bestOut = result;
      best = route;
    }
  });

  if (best) {
    logger.info(
      `Best route chosen: id=${
        best.id
      }, estimatedOut=${ethers.utils.formatUnits(bestOut, 18)} DAI.`
    );
  } else {
    logger.info(`No route yielded positive output after simulation.`);
  }

  return { bestRoute: best, bestOut };
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
      logger.info("PostgreSQL persistence disabled; skipping daily PnL computation.");
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
async function simulateAndExecuteArbChain(chain, useFlashbots = true, options = {}) {
  throwIfAborted(options.signal);
  const { provider, wallet, uniRouter, sushiRouter, arbContract } =
    getChainContext(chain);

  let currentSlippage = SLIPPAGE_DEFAULT_INT;
  let reward = -1;

  logger.info(`[${chain}] === Arbitrage Cycle Start ===`);
  arbAttempts.inc();

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

  // 3. Ensure reserveCache is up to date
  const topPools = ROUTES_TO_CHECK.slice(0, REALTIME_POOL_LIMIT)
    .map((r) => r.poolAddress)
    .filter((addr) => addr && ethers.utils.isAddress(addr));
  logger.info(
    `[${chain}] Subscribing to ${topPools.length} pools for reserve updates.`
  );
  await initSubscriptions(topPools);
  for (const poolAddr of topPools) {
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
  const borrowDAI = await getOptimalBorrowAmount("DAI", chain);
  if (borrowDAI.isZero()) {
    logger.info(`[${chain}] No available DAI liquidity to borrow—skipping.`);
    arbFailure.labels("noLiquidity").inc();
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }

  // 6. Select best route via simulation
  const { bestRoute, bestOut } = await selectBestRoute(
    borrowDAI,
    slipBips,
    ROUTES_TO_CHECK
  );
  if (!bestRoute) {
    logger.info(`[${chain}] No profitable route found after simulation.`);
    consecutiveNegatives++;
    arbFailure.labels("noProfitableRoute").inc();
    if (consecutiveNegatives >= CB_NEG_THRESH_INT) {
      try {
        await arbContract.pause();
        await sendSlackAlert(
          `[${chain}] Circuit breaker: paused after ${CB_NEG_THRESH_INT} negative cycles.`
        );
        logger.info(`[${chain}] Contract paused via circuit breaker.`);
      } catch (err) {
        logger.error(`[${chain}] Failed to pause contract: ${err.message}`);
      }
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

  // 9. Build SwapData via swapDataBuilder
  let swapData;
  try {
    swapData = await buildSwapDataFromDynamic(
      bestRoute,
      {
        slippageBips: SLIPPAGE_DEFAULT_INT,
        minProfit: minProfitThreshold,
        borrowToken: tokenAddresses.DAI,
        borrowAmount: borrowDAI,
      },
      provider
    );
    logger.info(`[${chain}] swapDataBuilder returned SwapData successfully.`);
  } catch (err) {
    logger.error(`[${chain}] swapDataBuilder error: ${err.message}`);
    arbFailure.labels("swapDataFail").inc();
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }

  // 10. Encode SwapData and estimate gas
  let paramsEncoded;
  try {
    const swapDataTupleType = "tuple(address token,address[][] paths,uint256[] minOuts,uint256 minProfit,string route)";
    paramsEncoded = ethers.utils.defaultAbiCoder.encode(
      [swapDataTupleType],
      [swapData]
    );
    logger.info(`[${chain}] Encoded SwapData successfully.`);
  } catch (err) {
    logger.error(`[${chain}] Failed to encode SwapData: ${err.message}`);
    arbFailure.labels("calldataEncodeFail").inc();
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }

  let estimateGas;
  try {
    estimateGas = await arbContract.estimateGas.executeOperation(
      [swapData.token],
      [borrowDAI],
      [borrowDAI.mul(premBps).div(10000)],
      arbContract.address,
      paramsEncoded
    );
    logger.info(
      `[${chain}] Gas estimate for executeOperation: ${estimateGas.toString()}`
    );
  } catch (err) {
    logger.error(
      `[${chain}] estimateGas.executeOperation() failed: ${err.message}`
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
      swapData: cloneSwapDataForStore(swapData),
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
          data: arbContract.interface.encodeFunctionData("initiateFlashLoan", [
            swapData.token,
            borrowDAI,
            paramsEncoded,
          ]),
          gasLimit: BigNumber.from(2_000_000),
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
            data: arbContract.interface.encodeFunctionData(
              "initiateFlashLoan",
              [swapData.token, borrowDAI, paramsEncoded]
            ),
            gasLimit: BigNumber.from(2_000_000),
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
          route: swapData.route,
          profit: netDAI,
          txHash: "flashbots-bundle",
          timestamp: Date.now(),
          status: "flashbots",
        });
        if (tradeResult?.ok) {
          logger.info(`[${chain}] Trade recorded as flashbots.`);
        } else if (tradeResult?.error?.code === "DB_DISABLED") {
          logger.info(`[${chain}] Persistence disabled; flashbots trade not stored.`);
        } else if (tradeResult?.error) {
          logger.warn(
            `[${chain}] Failed to persist flashbots trade (${tradeResult.error.code}): ${tradeResult.error.message}`
          );
        }
        reward = parseFloat(ethers.utils.formatUnits(netDAI, 18));
        return { executed: true, estimatedProfitInDai: netDAI };
      } else {
        logger.warn(
          `[${chain}] Flashbots bundles failed—falling back to public TX.`
        );
      }
    } catch (err) {
      logger.warn(`[${chain}] Flashbots error: ${err.message}`);
    }
  }

  // 13. Public fallback transaction
  try {
    logger.info(`[${chain}] Sending public initiateFlashLoan transaction.`);
    const txResp = await arbContract.initiateFlashLoan(
      swapData.token,
      borrowDAI,
      paramsEncoded,
      { gasLimit: BigNumber.from(2_000_000) }
    );
    logger.info(`[${chain}] Public TX sent: ${txResp.hash}`);
    await txResp.wait();
    logger.info(`[${chain}] Public TX mined: ${txResp.hash}`);
    arbSuccess.inc();
    const tradeResult = await insertTrade({
      route: swapData.route,
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
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: true, estimatedProfitInDai: netDAI };
  } catch (err) {
    logger.error(`[${chain}] Public TX failed: ${err.message}`);
    arbFailure.labels("publicTxFail").inc();
    reward = -1;
    slippageAgent.update(reward);
    rlEpsilon.set(slippageAgent.epsilon);
    return { executed: false, estimatedProfitInDai: BigNumber.from(0) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordinator: Run simulateAndExecuteArbChain on Each Configured Chain
// ─────────────────────────────────────────────────────────────────────────────
async function simulateAndExecuteArb(useFlashbots = true, options = {}) {
  throwIfAborted(options.signal);
  const chains = [DEFAULT_CHAIN];
  let outcome = { executed: false, estimatedProfitInDai: BigNumber.from(0) };

  for (const chain of chains) {
    try {
      const res = await simulateAndExecuteArbChain(chain, useFlashbots, options);
      if (res.executed) outcome = res;
    } catch (err) {
      logger.error(`[${chain}] Fatal error in cycle: ${err.message}`);
    }
  }

  return outcome;
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

if (require.main === module) {
  (async () => {
    while (true) {
      await simulateAndExecuteArb();
      await new Promise((r) => setTimeout(r, 10_000));
    }
  })();
}
