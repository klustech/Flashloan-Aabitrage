/**
 * server/botLogic.js
 *
 * Main bot logic for Flashloan Arbitrage (Updated to N-hop SwapData per blueprint),
 * adjusted so helper requires point into server/scripts/, and using minimal router ABIs
 * (instead of loading Quoter.json, which is not a valid router ABI).
 *
 * Added comprehensive logger.info statements at each major step.
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const fs = require("fs");
const axios = require("axios");
const winston = require("winston");
const { ethers, BigNumber } = require("ethers");
const {
  FlashbotsBundleProvider,
} = require("@flashbots/ethers-provider-bundle");
const { Worker } = require("worker_threads");
const stats = require("simple-statistics");
const client = require("prom-client");

// ─────────────────────────────────────────────────────────────────────────────
// Reintroduced: CoinGecko Caching & Dynamic Slippage (exactly from original)
// ─────────────────────────────────────────────────────────────────────────────
const cache = {
  coinGecko: {},
  dynamicSlippage: null,
  duration: 60_000, // 1 minute
};

async function getCachedCoinGeckoPrice(coinId, vsCurrency) {
  const cacheKey = `${coinId}_${vsCurrency}`;
  const now = Date.now();
  if (
    cache.coinGecko[cacheKey] &&
    now - cache.coinGecko[cacheKey].timestamp < cache.duration
  ) {
    return cache.coinGecko[cacheKey].data;
  }
  const { data } = await axios.get(
    "https://api.coingecko.com/api/v3/simple/price",
    {
      params: {
        ids: coinId,
        vs_currencies: vsCurrency,
        include_24hr_change: "true",
      },
    }
  );
  cache.coinGecko[cacheKey] = { data, timestamp: now };
  return data;
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
    const dynamic = Math.min(
      parseInt(process.env.SLIPPAGE_DEFAULT_BIPS || "50", 10) +
        Math.round(vol * 5),
      200
    );
    cache.dynamicSlippage = { value: dynamic, timestamp: now };
    logger.info(`Dynamic Slippage determined: ${dynamic} bips`);
    return dynamic;
  } catch (err) {
    logger.warn(
      `Slippage fetch error (${err.message}), using default: ${parseInt(
        process.env.SLIPPAGE_DEFAULT_BIPS || "50",
        10
      )} bips`
    );
    return parseInt(process.env.SLIPPAGE_DEFAULT_BIPS || "50", 10);
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
const { initBalancer, getBalancerQuote } = require("./scripts/balancerUtils");
const { getCurveQuote } = require("./scripts/curveUtils");

// ─────────────────────────────────────────────────────────────────────────────
// Imports: PostgreSQL Client for Trade Persistence (server/dbClient.js)
// ─────────────────────────────────────────────────────────────────────────────
const { insertTrade, query } = require("./dbClient");

// ─────────────────────────────────────────────────────────────────────────────
// Imports: Slack Alert Utility (from server/scripts/)
// ─────────────────────────────────────────────────────────────────────────────
const { sendSlackAlert } = require("./scripts/slackUtils");

// ─────────────────────────────────────────────────────────────────────────────
// Prometheus Metrics Setup
// ─────────────────────────────────────────────────────────────────────────────
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics();

const arbAttempts = new client.Counter({
  name: "arb_attempts_total",
  help: "Total number of arbitrage attempts",
});
const arbSuccess = new client.Counter({
  name: "arb_success_total",
  help: "Total number of successful arbitrage trades",
});
const arbFailure = new client.Counter({
  name: "arb_failure_total",
  help: "Total number of failed arbitrage trades",
  labelNames: ["reason"],
});
const avgLatency = new client.Gauge({
  name: "avg_latency_ms",
  help: "Average latency in route simulation",
});
const avgProfit = new client.Gauge({
  name: "avg_profit_dai",
  help: "Average profit in DAI",
});
const simulationHistogram = new client.Histogram({
  name: "simulation_time_seconds",
  help: "Time taken to simulate a route",
  buckets: [0.1, 0.5, 1, 2, 5],
});

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

// ─────────────────────────────────────────────────────────────────────────────
// Environment & Config (adjusted)
// ─────────────────────────────────────────────────────────────────────────────
const {
  PRIVATE_KEY,
  MAINNET_RPC_URL,
  ARB_RPC_URL,
  OP_RPC_URL,
  ETH_ARB_CONTRACT,
  AAVE_LENDING_POOL_ADDRESS_PROVIDER,
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
  DAILY_DRAWDOWN_LIMIT,
  SLACK_WEBHOOK_URL,
  SERVER_PORT,
  PG_USER,
  PG_HOST,
  PG_DB,
  PG_PASSWORD,
  PG_PORT,
  TOKENS_DAI,
  TOKENS_WETH,
  TOKENS_USDC,
  TOKENS_USDT,
  TOKENS_UNI,
  UNISWAP_ROUTER_ADDRESS,
  SUSHISWAP_ROUTER_ADDRESS,
} = process.env;

if (
  !PRIVATE_KEY ||
  !ETH_ARB_CONTRACT ||
  !AAVE_LENDING_POOL_ADDRESS_PROVIDER ||
  !MAINNET_RPC_URL ||
  !TOKENS_DAI ||
  !TOKENS_WETH
) {
  throw new Error("Missing required .env fields.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Providers for Ethereum, Arbitrum, Optimism
// ─────────────────────────────────────────────────────────────────────────────
const providers = {
  ethereum: new ethers.providers.JsonRpcProvider({
    url: MAINNET_RPC_URL,
    timeout: 120_000,
  }),
  arbitrum: ARB_RPC_URL
    ? new ethers.providers.JsonRpcProvider({
        url: ARB_RPC_URL,
        timeout: 120_000,
      })
    : null,
  optimism: OP_RPC_URL
    ? new ethers.providers.JsonRpcProvider({
        url: OP_RPC_URL,
        timeout: 120_000,
      })
    : null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Wallets for each chain
// ─────────────────────────────────────────────────────────────────────────────
const wallets = {
  ethereum: new ethers.Wallet(PRIVATE_KEY, providers.ethereum),
  arbitrum: providers.arbitrum
    ? new ethers.Wallet(PRIVATE_KEY, providers.arbitrum)
    : null,
  optimism: providers.optimism
    ? new ethers.Wallet(PRIVATE_KEY, providers.optimism)
    : null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Arbitrage contract addresses per chain (must be set in .env)
// ─────────────────────────────────────────────────────────────────────────────
const arbContractAddresses = {
  ethereum: ETH_ARB_CONTRACT,
  arbitrum: process.env.ARB_ARB_CONTRACT,
  optimism: process.env.OP_ARB_CONTRACT,
};

// ─────────────────────────────────────────────────────────────────────────────
// Global constants (parsed as ints/floats)
// ─────────────────────────────────────────────────────────────────────────────
const SLIPPAGE_BIPS_INT = SLIPPAGE_BIPS ? parseInt(SLIPPAGE_BIPS, 10) : 0;
const SLIPPAGE_DEFAULT_INT = SLIPPAGE_DEFAULT_BIPS
  ? parseInt(SLIPPAGE_DEFAULT_BIPS, 10)
  : 50;
const GAS_CEILING_BN = GAS_PRICE_CEILING
  ? ethers.utils.parseUnits(GAS_PRICE_CEILING, "gwei")
  : ethers.utils.parseUnits("50", "gwei");
const ZSCORE_THRESH = ZSCORE_THRESHOLD ? parseFloat(ZSCORE_THRESHOLD) : 3;
const ML_TOP_K = ML_TOPK ? parseInt(ML_TOPK, 10) : 50;
const BUNDLE_COUNT = FLASHBOTS_BUNDLE_COUNT
  ? parseInt(FLASHBOTS_BUNDLE_COUNT, 10)
  : 3;
const CB_NEG_THRESH_INT = CB_NEG_THRESHOLD ? parseInt(CB_NEG_THRESHOLD, 10) : 5;
const DAILY_DD_LIMIT_FLOAT = DAILY_DRAWDOWN_LIMIT
  ? parseFloat(DAILY_DRAWDOWN_LIMIT)
  : 0.01;

// ─────────────────────────────────────────────────────────────────────────────
// Token & DEX Setup (addresses must be in .env)
// ─────────────────────────────────────────────────────────────────────────────
const tokenAddresses = {
  DAI: TOKENS_DAI,
  WETH: TOKENS_WETH,
  USDC: TOKENS_USDC,
  USDT: TOKENS_USDT,
  UNI: TOKENS_UNI,
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
// Helpers to instantiate DEX routers per chain
// ─────────────────────────────────────────────────────────────────────────────
function getUniRouter(chain) {
  return new ethers.Contract(
    UNISWAP_ROUTER_ADDRESS,
    minimalRouterABI,
    wallets[chain]
  );
}
function getSushiRouter(chain) {
  return new ethers.Contract(
    SUSHISWAP_ROUTER_ADDRESS,
    minimalRouterABI,
    wallets[chain]
  );
}

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
  const providerAddr = AAVE_LENDING_POOL_ADDRESS_PROVIDER;
  const lpProvider = new ethers.Contract(
    providerAddr,
    ["function getLendingPool() view returns (address)"],
    providers[chain]
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
    providers[chain]
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
    const features = routeDefs.map((r) => ({
      routeLength: r.steps.length,
      liquidityUSD: r.liquidity || 0,
      feeTier: r.fee || 3000,
      volatility: r.volatility || 0,
      estimatedGasCost: r.estimatedGasCost || 0,
      historicalSuccess: r.historicalSuccessCount || 0,
    }));
    const mlRes = await axios.post(
      `http://localhost:${process.env.ML_PORT}/score`,
      features
    );
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
        results.push({
          routeId: msg.routeId,
          result: BigNumber.from(msg.result),
        });
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
  const topN = Number(DYNAMIC_ROUTE_TOPN || 20);
  const minLiq = DYNAMIC_ROUTE_MIN_LIQUIDITY_USD || MIN_LIQUIDITY || "100000";

  let routes = [];
  try {
    routes = await routeFinder({
      startToken: tokenAddresses.DAI,
      topN,
      minLiquidityUSD: minLiq,
      maxHops: Number(DYNAMIC_ROUTE_HOPS || 3),
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
// Compute Daily PnL over the last 24h (using dbClient.query)
// ─────────────────────────────────────────────────────────────────────────────
async function computeDailyPnL() {
  try {
    const res = await query(
      `SELECT SUM(profit) AS total_profit FROM trades WHERE timestamp >= NOW() - INTERVAL '24 HOURS';`
    );
    const profit = res.rows[0].total_profit
      ? BigNumber.from(res.rows[0].total_profit)
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
async function simulateAndExecuteArbChain(chain, useFlashbots = true) {
  const provider = providers[chain];
  const wallet = wallets[chain];
  const uniRouter = getUniRouter(chain);
  const sushiRouter = getSushiRouter(chain);
  const arbContract = new ethers.Contract(
    arbContractAddresses[chain],
    arbitrageABI,
    wallet
  );

  logger.info(`[${chain}] === Arbitrage Cycle Start ===`);
  arbAttempts.inc();

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
    return false;
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
    return false;
  }

  // 2. Build dynamic routes
  const ROUTES_TO_CHECK = await getAllRoutes(chain);
  logger.info(
    `[${chain}] getAllRoutes returned ${ROUTES_TO_CHECK.length} routes.`
  );
  if (!ROUTES_TO_CHECK.length) {
    arbFailure.labels("noRoutes").inc();
    return false;
  }

  // 3. Ensure reserveCache is up to date
  const topPools = ROUTES_TO_CHECK.slice(0, REALTIME_POOL_COUNT || 100).map(
    (r) => r.poolAddress
  );
  logger.info(
    `[${chain}] Subscribing to ${topPools.length} pools for reserve updates.`
  );
  await initSubscriptions(topPools);
  for (const poolAddr of topPools) {
    if (
      !reserveCache.has(poolAddr) ||
      Date.now() - reserveCache.get(poolAddr).timestamp > 5000
    ) {
      try {
        await fetchMulticallReservesForRoute({ poolAddress: poolAddr });
        logger.info(
          `[${chain}] Fetched multicall reserves for pool ${poolAddr}`
        );
      } catch {
        logger.warn(
          `[${chain}] Failed to fetch multicall reserves for pool ${poolAddr}`
        );
      }
    }
  }

  // 4. Get dynamic slippage
  let slipBips;
  try {
    slipBips = await getDynamicSlippage();
  } catch {
    slipBips = SLIPPAGE_DEFAULT_INT;
    logger.warn(`[${chain}] Using default slippage: ${slipBips} bips.`);
  }

  // 5. Determine borrow amount
  const borrowDAI = await getOptimalBorrowAmount("DAI", chain);
  if (borrowDAI.isZero()) {
    logger.info(`[${chain}] No available DAI liquidity to borrow—skipping.`);
    arbFailure.labels("noLiquidity").inc();
    return false;
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
    return false;
  }
  logger.info(
    `[${chain}] Selected best route id=${
      bestRoute.id
    }, estimatedOut=${ethers.utils.formatUnits(bestOut, 18)} DAI.`
  );
  consecutiveNegatives = 0;

  // 7. Compute total debt and net profit
  const premBps = parseInt(FLASHLOAN_PREMIUM_BIPS || "9", 10);
  const totalDebtDAI = borrowDAI.mul(10000 + premBps).div(10000);
  const potentialProfitDAI = bestOut.sub(totalDebtDAI);
  logger.info(
    `[${chain}] potentialProfitDAI (after premium): ${ethers.utils.formatUnits(
      potentialProfitDAI,
      18
    )} DAI.`
  );
  if (potentialProfitDAI.lte(BigNumber.from(MIN_PROFIT_DAI || "1"))) {
    logger.info(
      `[${chain}] Not profitable after flashloan premium (threshold ${MIN_PROFIT_DAI}).`
    );
    arbFailure.labels("notProfitableAfterPremium").inc();
    return false;
  }

  // 8. Re-fetch fresh reserves for bestRoute
  try {
    await fetchMulticallReservesForRoute(bestRoute);
    logger.info(`[${chain}] Fetched fresh reserves for best route.`);
  } catch {
    logger.warn(`[${chain}] Failed to fetch fresh reserves for best route.`);
  }

  // 9. Build SwapData via swapDataBuilder
  let swapData;
  try {
    swapData = await buildSwapDataFromDynamic(
      {
        steps: bestRoute.steps,
        routeTokens: bestRoute.routeTokens,
        fees: bestRoute.fees || [],
        curveIndices: bestRoute.curveIndices || {},
      },
      {
        slippageBips: SLIPPAGE_DEFAULT_INT,
        minProfit: BigNumber.from(MIN_PROFIT_DAI || "1"),
        borrowToken: tokenAddresses.DAI,
        borrowAmount: borrowDAI.toString(),
      }
    );
    logger.info(`[${chain}] swapDataBuilder returned SwapData successfully.`);
  } catch (err) {
    logger.error(`[${chain}] swapDataBuilder error: ${err.message}`);
    arbFailure.labels("swapDataFail").inc();
    return false;
  }

  // 10. Encode SwapData and estimate gas
  let paramsEncoded;
  try {
    paramsEncoded = ethers.utils.defaultAbiCoder.encode(
      ["SwapData"],
      [swapData]
    );
    logger.info(`[${chain}] Encoded SwapData successfully.`);
  } catch (err) {
    logger.error(`[${chain}] Failed to encode SwapData: ${err.message}`);
    arbFailure.labels("calldataEncodeFail").inc();
    return false;
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
    return false;
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
    return false;
  }

  const netDAI = potentialProfitDAI.sub(estCostDAI);
  logger.info(
    `[${chain}] Net DAI (after gas): ${ethers.utils.formatUnits(
      netDAI,
      18
    )} DAI.`
  );
  if (netDAI.lte(BigNumber.from(MIN_PROFIT_DAI || "1"))) {
    logger.info(
      `[${chain}] Net profit ${ethers.utils.formatUnits(
        netDAI,
        18
      )} below threshold ${ethers.utils.formatUnits(
        BigNumber.from(MIN_PROFIT_DAI || "1"),
        18
      )} DAI.`
    );
    arbFailure.labels("netBelowMinProfit").inc();
    return false;
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
        .mul(BigNumber.from(PRIO_PERCENT || 10))
        .div(BigNumber.from(100));
      const maxPrio = ethers.utils.parseUnits(
        PRIO_FEE_MAX_GWEI || "50",
        "gwei"
      );
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
          `[${chain}] No bundle included on first attempt. Retrying up to ${TIP_RETRY_COUNT} times.`
        );
        for (
          let attempt = 0;
          attempt < TIP_RETRY_COUNT && !flashbotsSuccess;
          attempt++
        ) {
          chosenPrio = chosenPrio
            .mul(BigNumber.from(TIP_MULTIPLIER_NUM || 12))
            .div(BigNumber.from(TIP_MULTIPLIER_DEN || 10));
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
        await insertTrade({
          route: swapData.route,
          profit: netDAI,
          txHash: "flashbots-bundle",
          timestamp: Date.now(),
          status: "flashbots",
        });
        logger.info(`[${chain}] Trade recorded as flashbots.`);
        return true;
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
    await insertTrade({
      route: swapData.route,
      profit: netDAI,
      txHash: txResp.hash,
      timestamp: Date.now(),
      status: "public",
    });
    logger.info(`[${chain}] Trade recorded as public.`);
    return true;
  } catch (err) {
    logger.error(`[${chain}] Public TX failed: ${err.message}`);
    arbFailure.labels("publicTxFail").inc();
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordinator: Run simulateAndExecuteArbChain on Each Configured Chain
// ─────────────────────────────────────────────────────────────────────────────
async function simulateAndExecuteArb() {
  const chains = ["ethereum"];
  if (providers.arbitrum) chains.push("arbitrum");
  if (providers.optimism) chains.push("optimism");

  for (const chain of chains) {
    try {
      await simulateAndExecuteArbChain(chain, true);
    } catch (err) {
      logger.error(`[${chain}] Fatal error in cycle: ${err.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports & Standalone Loop
// ─────────────────────────────────────────────────────────────────────────────
module.exports.simulateAndExecuteArb = simulateAndExecuteArb;

if (require.main === module) {
  (async () => {
    while (true) {
      await simulateAndExecuteArb();
      await new Promise((r) => setTimeout(r, 10_000));
    }
  })();
}
