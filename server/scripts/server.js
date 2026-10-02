// server/scripts/server.js

/**
 * Express API for the Flashloan Arbitrage Bot.
 *  - Exposes endpoints to fetch live market data (DAI→WETH), read bot logs, trigger arbitrage, update settings, and metrics.
 *  - Coalesces new-block notifications into bounded deterministic arbitrage scans.
 */

const express = require("express");
const path = require("path");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const readline = require("readline");
const winston = require("winston");
const { ethers } = require("ethers");
const http = require("http");

// WebSocket support for real-time updates
let WebSocket;
try {
  WebSocket = require("ws");
} catch (e) {
  // ws package not installed, WebSocket support disabled
  WebSocket = null;
}

// Event bus for cross-module communication
const eventBus = require("../utils/eventBus");
const { getEnv, loadRequired } = require("../../utils/config");
const {
  determineProfit,
  getSimulationConfig,
} = require("../../utils/profitDetermination");
const {
  settingsSchema,
  settingsUpdateSchema,
  settingsDefaults,
  formatValidationErrors,
} = require("../utils/settingsSchema");
// Shared Prometheus metrics (registry + concrete instruments)
const {
  register,
  arbAttempts,
  arbSuccess,
  arbFailure,
  avgLatency,
  avgProfit,
  simulationHistogram,
} = require("../metricsRegistry");

loadRequired([
  "MAINNET_RPC_URL",
  "UNISWAP_ROUTER_ADDRESS",
  "SUSHISWAP_ROUTER_ADDRESS",
  "TOKENS_DAI",
  "TOKENS_WETH",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Bot logic & helpers
// ─────────────────────────────────────────────────────────────────────────────
const loadBotLogic = () => {
  if (process.env.NODE_ENV === "test") {
    return {
      simulateAndExecuteArb: async () => ({ executed: false }),
      getCurrentMarketData: async () => ({ opportunities: [] }),
      updateMinBorrowAmount: () => {},
      updateSimulationInputAmount: () => {},
      getRecentOpportunities: () => [],
      resetSlippagePolicy: () => ({ reset: true }),
      initConnext: async () => false,
      getConnextStatus: async () => ({ initialized: false }),
      manualForwardProfits: async () => ({ success: false }),
      getConnextTransferHistory: () => ({ transfers: [] }),
      getPendingConnextTransfers: () => ({ transfers: [], count: 0 }),
      checkConnextTransferStatus: async () => ({ status: "unknown" }),
      getAllRoutes: async () => [],
      getConnectionStatus: () => ({ mode: "none", isConnected: false }),
      getSubscriptionStats: () => ({
        v2: { subscriptions: 0, cached: 0 },
        v3: { subscriptions: 0, cached: 0 },
        balancer: { subscriptions: 0, cached: 0 },
        curve: { subscriptions: 0, cached: 0 },
      }),
      // Tier-1 mocks
      getRiskReport: () => ({
        totalTrades: 0,
        winRate: "N/A",
        isPaused: false,
      }),
      pauseTrading: () => {},
      resumeTrading: () => true,
      forceResumeTrading: () => true,
      getRiskAlerts: () => [],
      getRelayStats: () => ({}),
      getGraphStats: () => ({ totalPools: 0, totalEdges: 0 }),
      getTier1FeatureStatus: () => ({
        multiRelay: false,
        riskManager: false,
        incrementalGraph: false,
        mempoolMonitor: false,
        dynamicTips: false,
      }),
      initializeTier1Features: async () => ({
        rpcManager: false,
        mempoolMonitor: false,
        riskManager: false,
      }),
    };
  }
  return require("../botLogic");
};

const {
  simulateAndExecuteArb,
  getCurrentMarketData,
  updateMinBorrowAmount,
  updateSimulationInputAmount,
  getRecentOpportunities,
  resetSlippagePolicy,
  initConnext,
  getConnextStatus,
  manualForwardProfits,
  getConnextTransferHistory,
  getPendingConnextTransfers,
  checkConnextTransferStatus,
  getAllRoutes,
  getConnectionStatus,
  getSubscriptionStats,
  // Tier-1 feature exports
  getRiskReport,
  pauseTrading,
  resumeTrading,
  forceResumeTrading,
  getRiskAlerts,
  getRelayStats,
  getGraphStats,
  getTier1FeatureStatus,
  initializeTier1Features,
} = loadBotLogic();

// Connext monitoring functions (direct import to avoid circular deps)
const loadConnextMonitoring = () => {
  if (process.env.NODE_ENV === "test") {
    return {
      startMonitoring: () => {},
      stopMonitoring: () => {},
      getMonitoringStatus: () => ({ enabled: false, running: false }),
      updateMonitoringConfig: () => ({ enabled: false }),
    };
  }
  try {
    return require("./connextClient");
  } catch (e) {
    return {
      startMonitoring: () => {},
      stopMonitoring: () => {},
      getMonitoringStatus: () => ({ enabled: false, running: false }),
      updateMonitoringConfig: () => ({ enabled: false }),
    };
  }
};

const {
  startMonitoring: startConnextMonitoring,
  stopMonitoring: stopConnextMonitoring,
  getMonitoringStatus: getConnextMonitoringStatus,
  updateMonitoringConfig: updateConnextMonitoringConfig,
} = loadConnextMonitoring();

// Timelock client state
let timelockInitialized = false;
let timelockInfo = null;

// Initialize timelock client if configured
const initTimelock = async () => {
  const timelockAddress = process.env.TIMELOCK_ADDRESS;
  const arbitrageAddress = process.env.CONTRACT_ADDRESS;

  if (!timelockAddress) {
    console.log("[Timelock] TIMELOCK_ADDRESS not set, timelock API disabled");
    return false;
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider({
      url: RPC_URL,
      timeout: 120_000,
    });

    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      console.warn(
        "[Timelock] PRIVATE_KEY not set, timelock will be read-only"
      );
    }

    const signer = privateKey ? new ethers.Wallet(privateKey, provider) : null;

    timelockInfo = await initTimelockClient({
      timelockAddress,
      arbitrageAddress,
      provider,
      signer,
    });

    timelockInitialized = true;
    console.log(`[Timelock] Initialized - minDelay: ${timelockInfo.minDelay}s`);
    return true;
  } catch (err) {
    console.error(`[Timelock] Initialization failed: ${err.message}`);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Slack Alerts Utility
// ─────────────────────────────────────────────────────────────────────────────
const { sendSlackAlert } = require("./slackUtils");

// ─────────────────────────────────────────────────────────────────────────────
// Timelock Utilities
// ─────────────────────────────────────────────────────────────────────────────
const {
  initTimelockClient,
  scheduleOperation,
  executeOperation,
  cancelOperation,
  getOperationStatus,
  schedulePause,
  scheduleUnpause,
  getRoles,
  computeOperationId,
} = require("./timelockUtils");

// ─────────────────────────────────────────────────────────────────────────────
// Circuit Breaker
// ─────────────────────────────────────────────────────────────────────────────
const { getCircuitBreaker } = require("./circuitBreaker");

// Thin accessors over the shared circuit-breaker singleton.
const getCircuitBreakerState = () => getCircuitBreaker().getStatus();
const resetCB = () => getCircuitBreaker().reset(true);

// ─────────────────────────────────────────────────────────────────────────────
// ML Scorer
// ─────────────────────────────────────────────────────────────────────────────
let mlScorer;
try {
  mlScorer = require("./mlScorer");
} catch (err) {
  mlScorer = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade history helpers
// ─────────────────────────────────────────────────────────────────────────────
const loadDbClient = () => {
  if (process.env.NODE_ENV === "test") {
    return {
      getRecentTrades: async () => [],
    };
  }
  return require("../dbClient");
};

const { getRecentTrades: getLegacyRecentTrades } = loadDbClient();
async function getRecentTrades(limit = 100) {
  if (process.env.NODE_ENV === "test") return getLegacyRecentTrades(limit);
  return require("../bot/coordinator").getCoordinator().ledger.recent(10000)
    .filter(r=>r.mode==="LIVE" && ["INCLUDED","REVERTED"].includes(r.status) && r.token?.symbol==="DAI")
    .slice(0,limit).map(r=>({id:r.id,route:r.swapData?.route||r.route?.strategy,profit:ethers.utils.formatUnits(r.realizedNetProfit,r.token.decimals),txHash:r.txHash,timestamp:new Date(r.updatedAt).toISOString(),status:r.status,token:r.token}));
}

// ─────────────────────────────────────────────────────────────────────────────
// DEX ABIs & Provider for real-time quotes (market-data endpoint)
// ─────────────────────────────────────────────────────────────────────────────
const UniswapABI = require("./abis/UniswapV2Router02.json");
const SushiABI = require("./abis/SushiSwapRouter.json");

const RPC_URL = process.env.MAINNET_RPC_URL;

// Single provider with timeout
const provider = new ethers.providers.JsonRpcProvider({
  url: RPC_URL,
  timeout: 120_000,
});
const UNI_ROUTER = process.env.UNISWAP_ROUTER_ADDRESS;
const SUSHI_ROUTER = process.env.SUSHISWAP_ROUTER_ADDRESS;
const DAI_ADDRESS = process.env.TOKENS_DAI;
const WETH_ADDRESS = process.env.TOKENS_WETH;

const { promises: fsPromises, constants: fsConstants } = fs;
const LOGS_BASE_DIR = path.resolve(__dirname, "../../");

const sanitizeLogPath = (requestedPath = "bot.log") => {
  const normalized = path.normalize(String(requestedPath));
  const resolved = path.resolve(LOGS_BASE_DIR, normalized);
  if (
    !resolved.startsWith(LOGS_BASE_DIR + path.sep) &&
    resolved !== LOGS_BASE_DIR
  ) {
    throw new Error("invalid log path");
  }
  if (resolved === LOGS_BASE_DIR) {
    throw new Error("log path must reference a file");
  }
  return resolved;
};

// ─────────────────────────────────────────────────────────────────────────────
// Prometheus Metrics Setup
// ─────────────────────────────────────────────────────────────────────────────
// Prometheus metrics are created centrally in server/metricsRegistry.js so the API and
// bot share a single registry regardless of which component instantiates them.

// ─────────────────────────────────────────────────────────────────────────────
// Express init & middleware
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3001;

// Rate-limit: 30 requests per 5 minutes per IP
app.use(
  rateLimit({
    windowMs: 300_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests – slow down 🙏",
  })
);

// CORS restricted to explicitly configured origins. With CORS_ORIGIN unset,
// cross-origin browser requests are blocked (same-origin / server-side only).
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({ origin: corsOrigins.length ? corsOrigins : false }));
app.use(express.json());

// Fail-closed x-api-key auth. Liveness/metrics stay open for probes; every other
// route requires a matching API_KEY. If API_KEY is unset the server refuses the
// request rather than running money-moving endpoints unauthenticated.
const OPEN_PATHS = new Set(["/healthz", "/health", "/metrics"]);
function safeKeyEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const c = require("crypto");
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return c.timingSafeEqual(ba, bb);
}
app.use((req, res, next) => {
  if (req.method === "OPTIONS" || OPEN_PATHS.has(req.path)) return next();
  const { API_KEY } = process.env;
  if (!API_KEY) {
    return res.status(503).json({
      error: "API_KEY is not configured; refusing unauthenticated request.",
    });
  }
  if (!safeKeyEqual(req.headers["x-api-key"], API_KEY)) {
    return res.sendStatus(401);
  }
  next();
});

const { tradingState } = require("../bot/stateMachine");
const coordinator = () => require("../bot/coordinator").getCoordinator();
app.get("/api/trading", (_req, res) => {
  try { res.json(coordinator().status()); } catch (err) { res.status(503).json({ error: err.message, trading: tradingState.snapshot() }); }
});
app.post("/api/trading/paper", (_req, res) => {
  tradingState.paper();
  botSettings.botActive = true;
  savePersistedSettings(botSettings);
  res.json({ trading: tradingState.snapshot() });
});
app.post("/api/trading/pause", (_req, res) => { tradingState.pause(); res.json({ trading: tradingState.snapshot() }); });
app.post("/api/trading/arm", async (_req, res) => {
  try { res.json({ trading: await coordinator().arm() }); } catch (err) { res.status(409).json({ error: err.message }); }
});
app.post("/api/trading/live", (_req, res) => {
  try { res.json({ trading: tradingState.live() }); } catch (err) { res.status(409).json({ error: err.message }); }
});
app.get("/api/trading/readiness", async (_req, res) => {
  try { res.json(await coordinator().checkReadiness()); } catch (err) { res.status(503).json({ ready: false, errors: [err.message] }); }
});
app.get("/api/executions", (_req, res) => {
  try { res.json({ executions: coordinator().ledger.recent(100), summary: coordinator().ledger.summary() }); } catch (err) { res.status(503).json({ error: err.message }); }
});

// Winston logger for server.log
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) =>
        `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "server.log" }),
  ],
});

const requireLogApiKey = (req, res, next) => {
  const { API_KEY } = process.env;
  if (!API_KEY) {
    logger.error("Log access requested but API_KEY is not configured");
    return res
      .status(500)
      .json({ error: "log access authentication is not configured" });
  }

  const providedKey = req.headers["x-api-key"]; // header names are lower-cased
  if (!providedKey) {
    return res.status(401).json({ error: "missing x-api-key header" });
  }

  if (providedKey !== API_KEY) {
    return res.status(403).json({ error: "invalid x-api-key" });
  }

  return next();
};

process.on("unhandledRejection", (reason) => {
  logger.error(
    `Unhandled Rejection: ${reason instanceof Error ? reason.message : reason}`
  );
});

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught Exception: ${err.stack || err.message}`);
  arbFailure.labels("uncaught_exception").inc();
  sendSlackAlert(`Uncaught Exception in API server: ${err.message}`);
});

const ARB_TIMEOUT_MS =
  parseInt(process.env.ARB_EXECUTION_TIMEOUT_MS, 10) || 120_000;
const HEALTH_STALE_THRESHOLD_MS =
  parseInt(process.env.HEALTH_STALE_THRESHOLD_MS, 10) || 300_000;

const workerStatus = {
  running: false,
  lastRunAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastTimeoutAt: null,
  lastErrorMessage: null,
};

const recordWorkerState = (patch = {}) => {
  Object.assign(workerStatus, patch);
};

const notifyError = (label, err) => {
  const reason = err.metricReason || label || "exception";
  try {
    arbFailure.labels(reason).inc();
  } catch (metricErr) {
    logger.warn(`Metric increment failed for ${reason}: ${metricErr.message}`);
  }
  logger.error(
    `[${label}] ${err.stack || err.message || "Unknown error encountered"}`
  );
  const shouldAlert =
    err.shouldAlert ??
    (typeof err.message === "string" &&
      err.message.includes("Circuit breaker"));
  if (shouldAlert) {
    sendSlackAlert(`[${label}] ${err.message}`);
  }
};

const withErrorBoundary = (label, handler) => (req, res, next) => {
  Promise.resolve()
    .then(() => handler(req, res, next))
    .catch((err) => {
      notifyError(label, err);
      next(err);
    });
};

const withCronBoundary = (label, handler) => async () => {
  try {
    await handler();
  } catch (err) {
    notifyError(label, err);
  }
};

const createTimeoutError = (timeoutMs, contextLabel) => {
  const timeoutError = new Error(
    `simulateAndExecuteArb timed out after ${timeoutMs}ms (${contextLabel})`
  );
  timeoutError.name = "AbortError";
  timeoutError.metricReason = "timeout";
  timeoutError.shouldAlert = false;
  return timeoutError;
};

async function runArbWithTimeout(useFlashbots, contextLabel, scanOptions = {}) {
  const timeoutMs = ARB_TIMEOUT_MS;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  scanOptions.signal?.addEventListener("abort", cancel, { once: true });
  if (scanOptions.signal?.aborted) cancel();
  recordWorkerState({ running: true, lastRunAt: Date.now() });

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = createTimeoutError(timeoutMs, contextLabel);
      controller.abort();
      reject(timeoutError);
    }, timeoutMs);
  });

  const arbPromise = simulateAndExecuteArb(useFlashbots, {
    ...scanOptions, signal: controller.signal,
  });

  try {
    const result = await Promise.race([arbPromise, timeoutPromise]);
    recordWorkerState({
      running: false,
      lastSuccessAt: Date.now(),
      lastErrorMessage: null,
      lastTimeoutAt: null,
    });
    return result;
  } catch (err) {
    const isTimeout =
      err.name === "AbortError" || err.metricReason === "timeout";
    recordWorkerState({
      running: false,
      lastErrorAt: Date.now(),
      lastErrorMessage: err.message,
      lastTimeoutAt: isTimeout ? Date.now() : workerStatus.lastTimeoutAt,
    });
    if (isTimeout) {
      botSettings.botActive = false;
      logger.error(
        `[${contextLabel}] simulateAndExecuteArb timed out after ${timeoutMs}ms. Bot paused.`
      );
      sendSlackAlert(
        `Arbitrage loop timed out in ${contextLabel}. Bot has been paused.`
      );
      err.shouldAlert = false;
      err.metricReason = "timeout";
      err.publicMessage = err.publicMessage || "arbitrage execution timed out";
    }
    if (!err.metricReason) {
      err.metricReason = "exception";
    }
    if (!err.publicMessage) {
      err.publicMessage = "arbitrage execution failed";
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    scanOptions.signal?.removeEventListener("abort", cancel);
    arbPromise.catch(() => {});
  }
}

const getHealthStatus = () => {
  const now = Date.now();
  const stale =
    workerStatus.lastRunAt &&
    now - workerStatus.lastRunAt > HEALTH_STALE_THRESHOLD_MS;
  const healthy =
    botSettings.botActive &&
    !workerStatus.running &&
    !stale &&
    !workerStatus.lastTimeoutAt;

  return {
    healthy,
    botActive: botSettings.botActive,
    running: workerStatus.running,
    stale,
    lastRunAt: workerStatus.lastRunAt,
    lastSuccessAt: workerStatus.lastSuccessAt,
    lastErrorAt: workerStatus.lastErrorAt,
    lastTimeoutAt: workerStatus.lastTimeoutAt,
    lastErrorMessage: workerStatus.lastErrorMessage,
  };
};

// Log each incoming request
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// In-memory bot settings
// ─────────────────────────────────────────────────────────────────────────────
const parseOptionalInt = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

// ─────────────────────────────────────────────────────────────────────────────
// Persistent Settings Storage
// ─────────────────────────────────────────────────────────────────────────────
const SETTINGS_FILE =
  process.env.SETTINGS_FILE || path.join(__dirname, "../.settings.json");

/**
 * Load persisted settings from disk
 * @returns {Object|null} Parsed settings or null if not found
 */
function loadPersistedSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      logger.info(
        "[Settings] No persisted settings file found, using defaults"
      );
      return null;
    }
    const data = fs.readFileSync(SETTINGS_FILE, "utf8");
    const settings = JSON.parse(data);
    logger.info(`[Settings] Loaded persisted settings from ${SETTINGS_FILE}`);
    return settings;
  } catch (err) {
    logger.warn(`[Settings] Failed to load persisted settings: ${err.message}`);
    return null;
  }
}

/**
 * Save settings to disk
 * @param {Object} settings - Settings to persist
 * @returns {boolean} Success status
 */
function savePersistedSettings(settings) {
  try {
    // Create a clean copy without internal state
    const toSave = {
      botActive: settings.botActive,
      flashbotsDefault: settings.flashbotsDefault,
      pollingInterval: settings.pollingInterval,
      gasPriceCeiling: settings.gasPriceCeiling,
      slippageBips: settings.slippageBips,
      minBorrowAmount: settings.minBorrowAmount,
      simulationInputAmount: settings.simulationInputAmount,
      _savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(toSave, null, 2), "utf8");
    logger.info(`[Settings] Persisted settings to ${SETTINGS_FILE}`);
    return true;
  } catch (err) {
    logger.error(`[Settings] Failed to persist settings: ${err.message}`);
    return false;
  }
}

// Load persisted settings if available
const persistedSettings = loadPersistedSettings();

// Priority: Environment variables > Persisted settings > Defaults
const rawInitialSettings = {
  ...settingsDefaults,
  // Apply persisted settings (if available)
  ...(persistedSettings || {}),
  // Environment variables take precedence over persisted settings
  flashbotsDefault:
    process.env.FLASHBOTS_DEFAULT === undefined
      ? persistedSettings?.flashbotsDefault ?? settingsDefaults.flashbotsDefault
      : process.env.FLASHBOTS_DEFAULT === "true",
  pollingInterval:
    parseOptionalInt(process.env.POLLING_INTERVAL) ??
    persistedSettings?.pollingInterval ??
    settingsDefaults.pollingInterval,
  gasPriceCeiling:
    parseOptionalInt(process.env.GAS_PRICE_CEILING) ??
    persistedSettings?.gasPriceCeiling ??
    settingsDefaults.gasPriceCeiling,
  slippageBips:
    parseOptionalInt(process.env.SLIPPAGE_BIPS) ??
    persistedSettings?.slippageBips ??
    settingsDefaults.slippageBips,
  minBorrowAmount:
    parseOptionalInt(process.env.MIN_BORROW_AMOUNT) ??
    persistedSettings?.minBorrowAmount ??
    settingsDefaults.minBorrowAmount,
  simulationInputAmount:
    parseOptionalInt(process.env.SIMULATION_INPUT_AMOUNT) ??
    persistedSettings?.simulationInputAmount ??
    settingsDefaults.simulationInputAmount,
  // Don't auto-start bot from persisted settings for safety
  botActive: process.env.BOT_AUTO_START === "true" ? true : false,
};

let botSettings;
const initialSettingsResult = settingsSchema.safeParse(rawInitialSettings);
if (!initialSettingsResult.success) {
  const details = formatValidationErrors(initialSettingsResult.error);
  logger.warn(
    `Invalid initial settings detected, falling back to defaults: ${JSON.stringify(
      details
    )}`
  );
  botSettings = settingsSchema.parse(settingsDefaults);
} else {
  botSettings = initialSettingsResult.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// REST endpoints
// ─────────────────────────────────────────────────────────────────────────────

// GET /metrics
// Expose Prometheus metrics
app.get(
  "/metrics",
  withErrorBoundary("metrics_endpoint", async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.send(await register.metrics());
  })
);

// GET /api/metrics-json
// Return metrics in JSON form for the front-end
app.get(
  "/api/metrics-json",
  withErrorBoundary("metrics_json", async (_req, res) => {
    try {
      const data = await register.getMetricsAsJSON();
      res.json(data);
    } catch (err) {
      err.statusCode = 500;
      err.publicMessage = "failed to fetch metrics";
      err.metricReason = err.metricReason || "metrics_json_error";
      throw err;
    }
  })
);

// GET /api/market-data
// Returns uniswapPrice and sushiPrice for 1 DAI → WETH,
// wraps getAmountsOut calls in try/catch to avoid errors.
app.get(
  "/api/market-data",
  withErrorBoundary("market_data", async (_req, res) => {
    try {
      if (!DAI_ADDRESS || !WETH_ADDRESS) {
        throw new Error("TOKENS_DAI or TOKENS_WETH is undefined in .env");
      }
      const uniswap = new ethers.Contract(UNI_ROUTER, UniswapABI, provider);
      const sushi = new ethers.Contract(SUSHI_ROUTER, SushiABI, provider);

      const amountIn = ethers.utils.parseUnits("1", 18);
      const tokenPath = [DAI_ADDRESS, WETH_ADDRESS];

      let uniswapPrice = "0";
      let sushiPrice = "0";

      // Attempt Uniswap quote
      try {
        const uniAmounts = await uniswap.getAmountsOut(amountIn, tokenPath);
        uniswapPrice = ethers.utils.formatUnits(uniAmounts[1], 18);
      } catch (err) {
        logger.error(`Uniswap getAmountsOut error: ${err.message}`);
        // Keep uniswapPrice as "0"
      }

      // Attempt SushiSwap quote
      try {
        const sushiAmounts = await sushi.getAmountsOut(amountIn, tokenPath);
        sushiPrice = ethers.utils.formatUnits(sushiAmounts[1], 18);
      } catch (err) {
        logger.error(`SushiSwap getAmountsOut error: ${err.message}`);
        // Keep sushiPrice as "0"
      }

      const payload = {
        tokenIn: "DAI",
        tokenOut: "WETH",
        uniswapPrice,
        sushiPrice,
      };

      logger.info(`Market data: ${JSON.stringify(payload)}`);
      res.json(payload);
    } catch (err) {
      err.statusCode = 500;
      err.publicMessage = "failed to fetch market data";
      err.metricReason = err.metricReason || "market_data_error";
      throw err;
    }
  })
);

// GET /api/bot-logs
// Returns the contents of bot.log as a JSON array
app.get(
  "/api/bot-logs",
  withErrorBoundary("bot_logs", (_req, res) => {
    try {
      const logs = fs
        .readFileSync("bot.log", "utf-8")
        .split("\n")
        .filter(Boolean);
      res.json(logs);
    } catch (err) {
      err.statusCode = 500;
      err.publicMessage = "failed to read bot.log";
      err.metricReason = err.metricReason || "bot_log_error";
      throw err;
    }
  })
);

// GET /api/simulate-profit
// Uses profitDetermination utility for a demo route
app.get(
  "/api/simulate-profit",
  withErrorBoundary("simulate_profit", async (_req, res) => {
    try {
      const providerInfura = new ethers.providers.JsonRpcProvider(
        process.env.MAINNET_RPC_URL
      );

      // Illustrative flat-rate round-trip (NOT live pricing). Real profitability
      // is computed from on-chain quotes in the bot's execution path.
      const route = {
        name: "DAI→WETH→DAI (Uni)",
        steps: [
          {
            description: "DAI→WETH",
            simulate: (amt) => (amt / 2000) * 0.995,
          },
          {
            description: "WETH→DAI",
            simulate: (amt) => amt * 2000 * 0.995,
          },
        ],
      };

      const borrowAmountNumber = botSettings.simulationInputAmount;
      const borrowAmountWei = ethers.utils.parseUnits(
        borrowAmountNumber.toString(),
        18
      );

      const simulationConfig = getSimulationConfig({
        ...botSettings,
        simulationInputAmount: borrowAmountNumber,
      });

      const result = await determineProfit({
        provider: providerInfura,
        route,
        inputAmount: borrowAmountWei,
        gasUsed: ethers.BigNumber.from("200000"),
        simConfig: simulationConfig,
        inputAmountHuman: borrowAmountNumber,
      });

      res.json(result);
    } catch (err) {
      err.statusCode = 500;
      err.publicMessage = "simulation failed";
      err.metricReason = err.metricReason || "simulation_error";
      throw err;
    }
  })
);

// GET /api/bot-logs
// Streams the requested log file and returns a paginated chunk of lines
app.get("/api/bot-logs", requireLogApiKey, async (req, res) => {
  const {
    offset: rawOffset = "0",
    limit: rawLimit = "100",
    file: requestedFile = "bot.log",
  } = req.query;

  const offset = Number.parseInt(rawOffset, 10);
  const limit = Number.parseInt(rawLimit, 10);

  if (Number.isNaN(offset) || offset < 0) {
    return res.status(400).json({ error: "offset must be a positive integer" });
  }

  if (Number.isNaN(limit) || limit <= 0) {
    return res.status(400).json({ error: "limit must be a positive integer" });
  }

  const cappedLimit = Math.min(limit, 500);

  const safeRequestedFile = Array.isArray(requestedFile)
    ? requestedFile[0]
    : requestedFile;

  let logPath;
  try {
    logPath = sanitizeLogPath(safeRequestedFile);
  } catch (err) {
    logger.warn(`Rejected log path '${safeRequestedFile}': ${err.message}`);
    return res.status(400).json({ error: "invalid log path" });
  }

  try {
    await fsPromises.access(logPath, fsConstants.R_OK);
  } catch (err) {
    logger.error(`Log access error for ${logPath}: ${err.message}`);
    return res.status(404).json({ error: "log file not found" });
  }

  const logs = [];
  let hasMore = false;
  let lineNumber = 0;

  const stream = fs.createReadStream(logPath, {
    encoding: "utf-8",
  });

  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (lineNumber >= offset) {
        if (logs.length < cappedLimit) {
          logs.push(line);
        } else {
          hasMore = true;
          break;
        }
      }
      lineNumber += 1;
    }
  } catch (err) {
    logger.error(`Log stream error for ${logPath}: ${err.message}`);
    return res.status(500).json({ error: "failed to stream log file" });
  } finally {
    rl.close();
    stream.destroy();
  }

  return res.json({
    file: path.basename(logPath),
    offset,
    limit: cappedLimit,
    logs,
    nextOffset: hasMore ? offset + cappedLimit : null,
    hasMore,
  });
});

// GET /api/trades
// Returns the most recent trade history entries
app.get("/api/trades", async (req, res) => {
  try {
    const { limit } = req.query;
    const trades = await getRecentTrades(limit);
    res.json(trades);
  } catch (err) {
    logger.error(`trade history error: ${err.message}`);
    res.status(500).json({ error: "failed to fetch trade history" });
  }
});

// GET /api/simulate-profit
// Returns a profit simulation based on the most recent on-chain opportunity
app.get("/api/simulate-profit", async (_req, res) => {
  try {
    const [latestOpportunity] = getRecentOpportunities();
    if (!latestOpportunity || !latestOpportunity.swapData) {
      res.status(204).send();
      return;
    }

    const borrowAmountBN = ethers.BigNumber.from(
      latestOpportunity.borrowAmount
    );
    const gasEstimateBN = ethers.BigNumber.from(latestOpportunity.gasEstimate);
    const gasPriceBN = ethers.BigNumber.from(latestOpportunity.gasPrice);
    const premiumWei = ethers.BigNumber.from(latestOpportunity.premiumWei);

    let midRateWei = null;
    if (WETH_ADDRESS && DAI_ADDRESS) {
      try {
        const uniRouter = new ethers.Contract(UNI_ROUTER, UniswapABI, provider);
        const amounts = await uniRouter.getAmountsOut(
          ethers.utils.parseEther("1"),
          [WETH_ADDRESS, DAI_ADDRESS]
        );
        midRateWei = amounts[amounts.length - 1];
      } catch (err) {
        logger.warn(`Mid-market fetch failed: ${err.message}`);
      }
    }

    const simulationConfig = getSimulationConfig({ ...botSettings });

    const profitResult = await determineProfit({
      provider,
      swapData: latestOpportunity.swapData,
      inputAmount: borrowAmountBN,
      gasEstimate: gasEstimateBN,
      gasPriceOverride: gasPriceBN,
      flashloanPremiumBips: latestOpportunity.premiumBips,
      flashloanPremiumWei: premiumWei,
      simConfig: simulationConfig,
      ethToDaiRate: midRateWei,
    });

    const payload = {
      route: latestOpportunity.swapData.route,
      chain: latestOpportunity.chain,
      timestamp: latestOpportunity.timestamp,
      aborted: profitResult.aborted,
      reason: profitResult.reason || null,
    };

    if (!profitResult.aborted || profitResult.details) {
      const borrowAmount = parseFloat(
        ethers.utils.formatUnits(borrowAmountBN, 18)
      );
      const estimatedOut =
        latestOpportunity.estimatedOut !== undefined
          ? parseFloat(
              ethers.utils.formatUnits(latestOpportunity.estimatedOut, 18)
            )
          : null;

      Object.assign(payload, {
        borrowAmount,
        estimatedOut,
        simulatedOutput: profitResult.simulatedOutput ?? 0,
        gasCostDAI: profitResult.gasCostDAI ?? 0,
        gasCostETH: profitResult.gasCostETH ?? 0,
        premiumDAI: profitResult.premiumDAI ?? 0,
        totalCostDAI: profitResult.totalCostDAI ?? 0,
        profit: profitResult.profit ?? 0,
      });

      if (profitResult.details) {
        payload.gasPriceGwei = parseFloat(
          ethers.utils.formatUnits(profitResult.details.gasPriceWei, "gwei")
        );
        payload.gasUsed = profitResult.details.gasUsed;
      }
    }

    res.json(payload);
  } catch (err) {
    logger.error(`simulate-profit error: ${err.message}`);
    res.status(500).json({ error: "simulation failed" });
  }
});

// POST /api/trigger-arbitrage?flashbots=true|false
app.post(
  "/api/trigger-arbitrage",
  withErrorBoundary("manual_trigger", async (req, res) => {
    const useFlashbots =
      req.query.flashbots === "true" || botSettings.flashbotsDefault;
    logger.info(`Manual trigger (flashbots=${useFlashbots})`);

    const startTime = Date.now();
    arbAttempts.inc();

    let result;
    try {
      result = await runArbWithTimeout(useFlashbots, "manual_trigger");
    } catch (err) {
      if (
        !err.publicMessage ||
        err.publicMessage === "arbitrage execution failed"
      ) {
        err.publicMessage =
          err.metricReason === "timeout"
            ? "arbitrage execution timed out"
            : "trigger failed";
      }
      throw err;
    }
    const elapsed = (Date.now() - startTime) / 1000;
    simulationHistogram.observe(elapsed);
    avgLatency.set(elapsed * 1000);

    if (result.executed) {
      arbSuccess.inc();
      const estimatedProfit = result?.estimatedProfitInDai;
      if (estimatedProfit !== undefined && estimatedProfit !== null) {
        const formattedProfit = parseFloat(
          ethers.utils.formatUnits(estimatedProfit, 18)
        );
        if (!Number.isNaN(formattedProfit)) {
          avgProfit.set(formattedProfit);
        }
      }
    } else {
      arbFailure.labels("no_opportunity").inc();
    }

    res.json(
      result.executed
        ? { status: "executed", message: "Arbitrage executed" }
        : { status: "noop", message: "No opportunity" }
    );
  })
);

// GET /api/settings
app.get(
  "/api/settings",
  withErrorBoundary("get_settings", (_req, res) => {
    res.json({
      ...botSettings,
      _persisted: fs.existsSync(SETTINGS_FILE),
      _settingsFile: SETTINGS_FILE,
    });
  })
);

// POST /api/settings/reset - Reset settings to defaults
app.post(
  "/api/settings/reset",
  withErrorBoundary("reset_settings", (_req, res) => {
    // Reset to defaults (keep bot inactive for safety)
    botSettings = { ...settingsDefaults, botActive: false };

    // Remove persisted settings file
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        fs.unlinkSync(SETTINGS_FILE);
        logger.info(
          `[Settings] Removed persisted settings file: ${SETTINGS_FILE}`
        );
      }
    } catch (err) {
      logger.warn(`[Settings] Failed to remove settings file: ${err.message}`);
    }

    logger.info("Settings reset to defaults");
    res.json({
      status: "ok",
      settings: botSettings,
      message: "Settings reset to defaults",
    });
  })
);

// POST /api/settings
// Validates and updates the configurable bot settings.
app.post(
  "/api/settings",
  withErrorBoundary("update_settings", (req, res) => {
    try {
      const parseResult = settingsUpdateSchema.safeParse(req.body);

      if (!parseResult.success) {
        const details = formatValidationErrors(parseResult.error);
        logger.warn(
          `Settings validation failed: ${JSON.stringify(
            details
          )} | payload=${JSON.stringify(req.body)}`
        );

        const validationError = new Error("Invalid settings");
        validationError.statusCode = 400;
        validationError.publicMessage = "Invalid settings";
        validationError.details = {
          fieldErrors: details.fieldErrors,
          formErrors: details.formErrors,
        };
        validationError.metricReason = "settings_validation";
        throw validationError;
      }

      const updates = parseResult.data;

      if (Object.keys(updates).length === 0) {
        const emptyPayloadError = new Error("No settings provided");
        emptyPayloadError.statusCode = 400;
        emptyPayloadError.publicMessage = "No settings provided";
        emptyPayloadError.details = {
          fieldErrors: {},
          formErrors: ["At least one setting must be provided"],
        };
        emptyPayloadError.metricReason = "settings_validation";
        throw emptyPayloadError;
      }

      botSettings = { ...botSettings, ...updates };

      if (updates.minBorrowAmount !== undefined) {
        updateMinBorrowAmount(updates.minBorrowAmount);
      }
      if (updates.simulationInputAmount !== undefined) {
        updateSimulationInputAmount(updates.simulationInputAmount);
      }

      if (process.env.NODE_ENV !== "test") {
        const overrides = coordinator().overrides;
        if (updates.gasPriceCeiling !== undefined) overrides.gasCeilingGwei = String(updates.gasPriceCeiling);
        if (updates.slippageBips !== undefined) overrides.slippageBps = updates.slippageBips;
        if (updates.minBorrowAmount !== undefined) overrides.minBorrowAmount = String(updates.minBorrowAmount);
        if (updates.simulationInputAmount !== undefined) overrides.maxBorrowAmount = String(updates.simulationInputAmount);
        tradingState.paper(); // Changed settings require fresh explicit LIVE arming.
      }
      // Persist settings to disk
      savePersistedSettings(botSettings);

      logger.info(`Settings updated: ${JSON.stringify(botSettings)}`);
      res.json({ status: "ok", settings: botSettings, persisted: true });
    } catch (err) {
      err.statusCode = err.statusCode || 500;
      err.publicMessage = err.publicMessage || "update failed";
      err.metricReason = err.metricReason || "settings_error";
      throw err;
    }
  })
);

if (botSettings.botActive) tradingState.paper();

// POST /api/start-bot
app.post(
  "/api/start-bot",
  withErrorBoundary("start_bot", (_req, res) => {
    tradingState.paper();
    botSettings.botActive = true;
    savePersistedSettings(botSettings);
    logger.info("Bot started");
    recordWorkerState({ lastTimeoutAt: null, lastErrorMessage: null });
    res.json({ status: "ok", settings: botSettings });
  })
);

// POST /api/stop-bot
app.post(
  "/api/stop-bot",
  withErrorBoundary("stop_bot", (_req, res) => {
    tradingState.stop();
    botSettings.botActive = false;
    savePersistedSettings(botSettings);
    logger.info("Bot stopped");
    recordWorkerState({ running: false });
    res.json({ status: "ok", settings: botSettings });
  })
);

// GET /healthz
app.get(
  "/healthz",
  withErrorBoundary("healthz", (_req, res) => {
    res.json(getHealthStatus());
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Centralized error handler
// ─────────────────────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const status = err.statusCode || err.status || 500;
  const message =
    status >= 500
      ? err.publicMessage || "Internal Server Error"
      : err.publicMessage || err.message;

  const payload = { error: message };
  if (err.details) {
    payload.details = err.details;
  }

  res.status(status).json(payload);
});

// POST /api/rl/reset
app.post("/api/rl/reset", (_req, res) => {
  try {
    const snapshot = resetSlippagePolicy();
    logger.info("RL slippage policy reset");
    res.json({ status: "ok", policy: snapshot });
  } catch (err) {
    logger.error(`RL reset error: ${err.message}`);
    res.status(500).json({ error: "reset failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Opportunities API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/opportunities
// Returns recent arbitrage opportunities detected by the bot
app.get("/api/opportunities", async (_req, res) => {
  try {
    const opportunities = getRecentOpportunities();
    const formatted = opportunities.map((opp) => ({
      id: opp.id,
      chain: opp.chain,
      timestamp: opp.timestamp,
      route: opp.swapData?.route || "Unknown",
      routeTokens: opp.swapData?.paths?.[0] || [],
      borrowAmount: opp.borrowAmount
        ? ethers.utils.formatUnits(opp.borrowAmount, 18)
        : "0",
      estimatedProfit: opp.netProfit
        ? ethers.utils.formatUnits(opp.netProfit, 18)
        : "0",
      gasCostDai: opp.gasCostDai
        ? ethers.utils.formatUnits(opp.gasCostDai, 18)
        : "0",
      netProfit: opp.netProfit
        ? ethers.utils.formatUnits(opp.netProfit, 18)
        : "0",
      hops:
        opp.swapData?.paths?.map((path, idx) => ({
          tokenA: path[0],
          tokenB: path[path.length - 1],
          dex: opp.swapData?.dexes?.[idx] || "uniswap_v2",
          poolAddress: opp.swapData?.pools?.[idx],
        })) || [],
      mlScore: opp.mlScore || null,
      liquidity: opp.liquidity || null,
      volatility: opp.volatility || null,
    }));
    res.json({ opportunities: formatted, count: formatted.length });
  } catch (err) {
    logger.error(`opportunities error: ${err.message}`);
    res.status(500).json({ error: "failed to fetch opportunities" });
  }
});

// GET /api/bot-status
// Returns comprehensive bot status including circuit breaker state
app.get("/api/bot-status", async (_req, res) => {
  try {
    const health = getHealthStatus();
    const cbState = getCircuitBreakerState();
    const marketData = await getCurrentMarketData();

    res.json({
      ...health,
      circuitBreaker: {
        state: cbState.state,
        canTrade: cbState.canTrade,
        reason: cbState.reason,
        consecutiveLosses: cbState.consecutiveLosses,
        consecutiveFailures: cbState.consecutiveFailures,
        dailyPnL: cbState.dailyPnL,
        cooldownRemaining: cbState.cooldownRemaining,
        triggerReason: cbState.triggerReason,
      },
      market: marketData,
      services: {
        database: true, // Would check actual DB connection
        mlService: mlScorer ? true : false,
        connext: await getConnextStatus()
          .then((s) => s.initialized)
          .catch(() => false),
        timelock: timelockInitialized,
        priceIngestion:
          typeof getConnectionStatus === "function"
            ? getConnectionStatus()
            : { mode: "unknown" },
      },
    });
  } catch (err) {
    logger.error(`bot-status error: ${err.message}`);
    res.status(500).json({ error: "failed to fetch bot status" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Circuit Breaker API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/circuit-breaker
app.get("/api/circuit-breaker", (_req, res) => {
  try {
    const state = getCircuitBreakerState();
    res.json(state);
  } catch (err) {
    logger.error(`circuit-breaker error: ${err.message}`);
    res.status(500).json({ error: "failed to get circuit breaker state" });
  }
});

// POST /api/circuit-breaker/reset
app.post("/api/circuit-breaker/reset", (_req, res) => {
  try {
    resetCB();
    logger.info("Circuit breaker reset");
    res.json({ status: "ok", state: getCircuitBreakerState() });
  } catch (err) {
    logger.error(`circuit-breaker reset error: ${err.message}`);
    res.status(500).json({ error: "failed to reset circuit breaker" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Connection Health API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/connection-status
// Returns WebSocket connection health and subscription stats
app.get("/api/connection-status", (_req, res) => {
  try {
    const connectionStatus =
      typeof getConnectionStatus === "function"
        ? getConnectionStatus()
        : { mode: "unknown", isConnected: false };
    const subscriptionStats =
      typeof getSubscriptionStats === "function"
        ? getSubscriptionStats()
        : { v2: {}, v3: {}, balancer: {}, curve: {} };

    res.json({
      connection: connectionStatus,
      subscriptions: subscriptionStats,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error(`connection-status error: ${err.message}`);
    res.status(500).json({ error: "failed to get connection status" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier-1 Features API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/tier1/status - Get Tier-1 feature status
app.get("/api/tier1/status", (_req, res) => {
  try {
    const status =
      typeof getTier1FeatureStatus === "function"
        ? getTier1FeatureStatus()
        : {
            multiRelay: false,
            riskManager: false,
            incrementalGraph: false,
            mempoolMonitor: false,
            dynamicTips: false,
          };

    res.json({
      features: status,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error(`tier1-status error: ${err.message}`);
    res.status(500).json({ error: "failed to get Tier-1 status" });
  }
});

// GET /api/tier1/risk-report - Get risk manager performance report
app.get("/api/tier1/risk-report", (_req, res) => {
  try {
    const report =
      typeof getRiskReport === "function"
        ? getRiskReport()
        : { error: "Risk manager not available" };

    res.json(report);
  } catch (err) {
    logger.error(`risk-report error: ${err.message}`);
    res.status(500).json({ error: "failed to get risk report" });
  }
});

// GET /api/tier1/risk-alerts - Get recent risk alerts
app.get("/api/tier1/risk-alerts", (_req, res) => {
  try {
    const alerts = typeof getRiskAlerts === "function" ? getRiskAlerts() : [];

    res.json({ alerts, count: alerts.length });
  } catch (err) {
    logger.error(`risk-alerts error: ${err.message}`);
    res.status(500).json({ error: "failed to get risk alerts" });
  }
});

// POST /api/tier1/pause-trading - Pause trading via risk manager
app.post("/api/tier1/pause-trading", (_req, res) => {
  try {
    if (typeof pauseTrading === "function") {
      pauseTrading();
      logger.info("Trading paused via API");
      res.json({ status: "ok", message: "Trading paused" });
    } else {
      res.status(400).json({ error: "Risk manager not available" });
    }
  } catch (err) {
    logger.error(`pause-trading error: ${err.message}`);
    res.status(500).json({ error: "failed to pause trading" });
  }
});

// POST /api/tier1/resume-trading - Resume trading via risk manager
app.post("/api/tier1/resume-trading", (_req, res) => {
  try {
    if (typeof resumeTrading === "function") {
      const resumed = resumeTrading();
      if (resumed) {
        logger.info("Trading resumed via API");
        res.json({ status: "ok", message: "Trading resumed" });
      } else {
        res.json({
          status: "cooldown",
          message: "Cooldown not elapsed, use force-resume if needed",
        });
      }
    } else {
      res.status(400).json({ error: "Risk manager not available" });
    }
  } catch (err) {
    logger.error(`resume-trading error: ${err.message}`);
    res.status(500).json({ error: "failed to resume trading" });
  }
});

// POST /api/tier1/force-resume-trading - Force resume (bypass cooldown)
app.post("/api/tier1/force-resume-trading", (_req, res) => {
  try {
    if (typeof forceResumeTrading === "function") {
      forceResumeTrading();
      logger.info("Trading force resumed via API");
      res.json({ status: "ok", message: "Trading force resumed" });
    } else {
      res.status(400).json({ error: "Risk manager not available" });
    }
  } catch (err) {
    logger.error(`force-resume error: ${err.message}`);
    res.status(500).json({ error: "failed to force resume trading" });
  }
});

// GET /api/tier1/relay-stats - Get multi-relay statistics
app.get("/api/tier1/relay-stats", (_req, res) => {
  try {
    const stats = typeof getRelayStats === "function" ? getRelayStats() : {};

    res.json({ relays: stats });
  } catch (err) {
    logger.error(`relay-stats error: ${err.message}`);
    res.status(500).json({ error: "failed to get relay stats" });
  }
});

// GET /api/tier1/graph-stats - Get incremental graph statistics
app.get("/api/tier1/graph-stats", (_req, res) => {
  try {
    const stats =
      typeof getGraphStats === "function"
        ? getGraphStats()
        : { totalPools: 0, totalEdges: 0 };

    res.json(stats);
  } catch (err) {
    logger.error(`graph-stats error: ${err.message}`);
    res.status(500).json({ error: "failed to get graph stats" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ML Stats API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/ml-stats
app.get("/api/ml-stats", async (_req, res) => {
  try {
    if (!mlScorer) {
      return res.json({
        available: false,
        message: "ML scorer not configured",
      });
    }

    // Get ML model stats if available
    const stats = mlScorer.getModelStats
      ? await mlScorer.getModelStats()
      : {
          modelVersion: "lightgbm-v1.0",
          lastTrained: new Date().toISOString(),
          accuracy: null,
          precision: null,
          recall: null,
          f1Score: null,
          auc: null,
          totalPredictions: 0,
          correctPredictions: 0,
          avgResponseTime: 0,
          featureImportance: [],
          recentPredictions: [],
        };

    res.json({ available: true, ...stats });
  } catch (err) {
    logger.error(`ml-stats error: ${err.message}`);
    res.status(500).json({ error: "failed to fetch ML stats" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Arbitrage Simulation API
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/simulate-arbitrage
app.post("/api/simulate-arbitrage", async (req, res) => {
  try {
    const { borrowAmount, borrowToken, route, slippageBps, gasPrice } =
      req.body;

    if (!borrowAmount || !route || !Array.isArray(route)) {
      return res.status(400).json({ error: "Invalid simulation parameters" });
    }

    // Simulate each hop
    const hops = [];
    let currentAmount = parseFloat(borrowAmount);

    for (const hop of route) {
      // Estimate price impact based on amount
      const priceImpact = Math.min(0.5, currentAmount / 1000000); // Rough estimate
      const slippage = (slippageBps || 50) / 10000;
      const outputAmount = currentAmount * (1 - priceImpact) * (1 - slippage);

      hops.push({
        tokenIn: hop.tokenIn,
        tokenOut: hop.tokenOut,
        dex: hop.dex,
        inputAmount: currentAmount.toFixed(6),
        outputAmount: outputAmount.toFixed(6),
        priceImpact: (priceImpact * 100).toFixed(4),
      });

      currentAmount = outputAmount;
    }

    // Calculate costs
    const gasCostEth = (gasPrice || 30) * 300000 * 1e-9;
    const grossProfit = currentAmount - parseFloat(borrowAmount);
    const netProfit = grossProfit - gasCostEth * 1800; // Rough ETH to token conversion

    // ML score (mock if ML not available)
    const mlScore = typeof mlScorer?.scoreRoute === "function"
      ? await mlScorer
          .scoreRoute({ hops, borrowAmount, gasPrice })
          .catch(() => 0.5)
      : 0.5 + Math.random() * 0.3;

    res.json({
      success: true,
      illustrative: true,
      executable: false,
      simulation: {
        borrowAmount: parseFloat(borrowAmount),
        borrowToken: borrowToken || "DAI",
        expectedReturn: currentAmount,
        grossProfit,
        gasCost: gasCostEth.toFixed(6),
        netProfit: netProfit.toFixed(6),
        slippage: ((slippageBps || 50) / 100).toFixed(2),
        priceImpact: hops
          .reduce((sum, h) => sum + parseFloat(h.priceImpact), 0)
          .toFixed(4),
        mlScore,
        hops,
      },
    });
  } catch (err) {
    logger.error(`simulate-arbitrage error: ${err.message}`);
    res.status(500).json({ error: "simulation failed", message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Connext Cross-Chain API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/connext/status
app.get("/api/connext/status", async (req, res) => {
  try {
    const token = req.query.token || process.env.TOKENS_DAI;
    const status = await getConnextStatus(token);
    res.json(status);
  } catch (err) {
    logger.error(`connext status error: ${err.message}`);
    res.status(500).json({ error: "failed to get connext status" });
  }
});

// POST /api/connext/forward
app.post("/api/connext/forward", async (req, res) => {
  if (process.env.NODE_ENV !== "test") return res.status(409).json({error:"Cross-chain forwarding disabled in the production profile"});
  try {
    const { token, amount } = req.body;

    if (!token) {
      return res.status(400).json({ error: "token address required" });
    }

    const result = await manualForwardProfits(token, amount);
    res.json(result);
  } catch (err) {
    logger.error(`connext forward error: ${err.message}`);
    res.status(500).json({ error: "forward failed", message: err.message });
  }
});

// GET /api/connext/transfers - Get transfer history
app.get("/api/connext/transfers", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const history = getConnextTransferHistory(limit);
    res.json(history);
  } catch (err) {
    logger.error(`connext transfers error: ${err.message}`);
    res.status(500).json({ error: "failed to get transfer history" });
  }
});

// GET /api/connext/transfers/pending - Get pending transfers
app.get("/api/connext/transfers/pending", async (_req, res) => {
  try {
    const pending = getPendingConnextTransfers();
    res.json(pending);
  } catch (err) {
    logger.error(`connext pending transfers error: ${err.message}`);
    res.status(500).json({ error: "failed to get pending transfers" });
  }
});

// GET /api/connext/transfers/:transferId - Check specific transfer status
app.get("/api/connext/transfers/:transferId", async (req, res) => {
  try {
    const { transferId } = req.params;
    const status = await checkConnextTransferStatus(transferId);
    res.json(status);
  } catch (err) {
    logger.error(`connext transfer status error: ${err.message}`);
    res.status(500).json({ error: "failed to check transfer status" });
  }
});

// GET /api/connext/monitoring - Get monitoring status
app.get("/api/connext/monitoring", async (_req, res) => {
  try {
    const status = getConnextMonitoringStatus();
    res.json(status);
  } catch (err) {
    logger.error(`connext monitoring status error: ${err.message}`);
    res.status(500).json({ error: "failed to get monitoring status" });
  }
});

// POST /api/connext/monitoring/start - Start monitoring
app.post("/api/connext/monitoring/start", async (_req, res) => {
  try {
    startConnextMonitoring();
    const status = getConnextMonitoringStatus();
    res.json({ message: "Monitoring started", ...status });
  } catch (err) {
    logger.error(`connext start monitoring error: ${err.message}`);
    res.status(500).json({ error: "failed to start monitoring" });
  }
});

// POST /api/connext/monitoring/stop - Stop monitoring
app.post("/api/connext/monitoring/stop", async (_req, res) => {
  try {
    stopConnextMonitoring();
    const status = getConnextMonitoringStatus();
    res.json({ message: "Monitoring stopped", ...status });
  } catch (err) {
    logger.error(`connext stop monitoring error: ${err.message}`);
    res.status(500).json({ error: "failed to stop monitoring" });
  }
});

// POST /api/connext/monitoring/config - Update monitoring configuration
app.post("/api/connext/monitoring/config", async (req, res) => {
  try {
    const newConfig = req.body;
    const status = updateConnextMonitoringConfig(newConfig);
    res.json({ message: "Configuration updated", ...status });
  } catch (err) {
    logger.error(`connext monitoring config error: ${err.message}`);
    res.status(500).json({ error: "failed to update monitoring config" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Timelock Governance API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/timelock/status
app.get("/api/timelock/status", async (_req, res) => {
  if (!timelockInitialized) {
    return res.json({ initialized: false, message: "Timelock not configured" });
  }

  try {
    res.json({
      initialized: true,
      minDelay: timelockInfo.minDelay.toString(),
      minDelayHours: timelockInfo.minDelay.toNumber() / 3600,
    });
  } catch (err) {
    logger.error(`timelock status error: ${err.message}`);
    res.status(500).json({ error: "failed to get timelock status" });
  }
});

// GET /api/timelock/operations/:operationId
app.get("/api/timelock/operations/:operationId", async (req, res) => {
  if (!timelockInitialized) {
    return res.status(400).json({ error: "Timelock not configured" });
  }

  try {
    const status = await getOperationStatus(req.params.operationId);
    res.json(status);
  } catch (err) {
    logger.error(`timelock operation status error: ${err.message}`);
    res.status(500).json({ error: "failed to get operation status" });
  }
});

// POST /api/timelock/schedule
app.post("/api/timelock/schedule", async (req, res) => {
  if (!timelockInitialized) {
    return res.status(400).json({ error: "Timelock not configured" });
  }

  try {
    const { operation, params } = req.body;

    let result;
    switch (operation) {
      case "pause":
        result = await schedulePause();
        break;
      case "unpause":
        result = await scheduleUnpause();
        break;
      case "custom":
        result = await scheduleOperation({
          target: params.target,
          value: params.value || 0,
          data: params.data,
          predecessor: params.predecessor,
          salt: params.salt,
          delay: params.delay,
          description: params.description,
        });
        break;
      default:
        return res
          .status(400)
          .json({ error: `Unknown operation: ${operation}` });
    }

    logger.info(`Timelock operation scheduled: ${operation}`);
    res.json(result);
  } catch (err) {
    logger.error(`timelock schedule error: ${err.message}`);
    res.status(500).json({ error: "schedule failed", message: err.message });
  }
});

// POST /api/timelock/execute/:operationId
app.post("/api/timelock/execute/:operationId", async (req, res) => {
  if (!timelockInitialized) {
    return res.status(400).json({ error: "Timelock not configured" });
  }

  try {
    const { target, value, data, predecessor, salt } = req.body;

    const result = await executeOperation({
      target,
      value: value || 0,
      data,
      predecessor,
      salt,
    });

    logger.info(`Timelock operation executed: ${req.params.operationId}`);
    res.json(result);
  } catch (err) {
    logger.error(`timelock execute error: ${err.message}`);
    res.status(500).json({ error: "execute failed", message: err.message });
  }
});

// POST /api/timelock/cancel/:operationId
app.post("/api/timelock/cancel/:operationId", async (req, res) => {
  if (!timelockInitialized) {
    return res.status(400).json({ error: "Timelock not configured" });
  }

  try {
    const result = await cancelOperation(req.params.operationId);
    logger.info(`Timelock operation cancelled: ${req.params.operationId}`);
    res.json(result);
  } catch (err) {
    logger.error(`timelock cancel error: ${err.message}`);
    res.status(500).json({ error: "cancel failed", message: err.message });
  }
});

// GET /api/timelock/roles/:address
app.get("/api/timelock/roles/:address", async (req, res) => {
  if (!timelockInitialized) {
    return res.status(400).json({ error: "Timelock not configured" });
  }

  try {
    const roles = await getRoles(req.params.address);
    res.json(roles);
  } catch (err) {
    logger.error(`timelock roles error: ${err.message}`);
    res.status(500).json({ error: "failed to get roles" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Gas Estimation API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/gas-estimate
app.get("/api/gas-estimate", async (_req, res) => {
  try {
    const gasPrice = await provider.getGasPrice();
    const feeData = await provider.getFeeData();

    res.json({
      gasPrice: ethers.utils.formatUnits(gasPrice, "gwei"),
      gasPriceWei: gasPrice.toString(),
      maxFeePerGas: feeData.maxFeePerGas
        ? ethers.utils.formatUnits(feeData.maxFeePerGas, "gwei")
        : null,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
        ? ethers.utils.formatUnits(feeData.maxPriorityFeePerGas, "gwei")
        : null,
      timestamp: Date.now(),
    });
  } catch (err) {
    logger.error(`gas-estimate error: ${err.message}`);
    res.status(500).json({ error: "failed to get gas estimate" });
  }
});

// GET /api/daily-stats
app.get("/api/daily-stats", async (_req, res) => {
  try {
    const trades = await getRecentTrades(100);

    // Calculate daily stats
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const todaysTrades = trades.filter(
      (t) => new Date(t.timestamp).getTime() > oneDayAgo
    );

    const totalProfit = todaysTrades.reduce(
      (sum, t) => sum + parseFloat(t.profit || 0),
      0
    );
    const successfulTrades = todaysTrades.filter(
      (t) =>
        t.status === "success" ||
        t.status === "public" ||
        t.status === "flashbots"
    );
    const totalGasSpent = todaysTrades.reduce(
      (sum, t) => sum + parseFloat(t.gasCost || 0),
      0
    );

    res.json({
      totalAttempts: todaysTrades.length,
      successfulTrades: successfulTrades.length,
      totalProfit: totalProfit.toFixed(4),
      totalGasSpent: totalGasSpent.toFixed(4),
      profitChange:
        todaysTrades.length > 0
          ? ((totalProfit / todaysTrades.length) * 100).toFixed(2)
          : 0,
      avgGasPrice:
        todaysTrades.length > 0
          ? (
              todaysTrades.reduce(
                (sum, t) => sum + parseFloat(t.gasPrice || 30),
                0
              ) / todaysTrades.length
            ).toFixed(1)
          : "30",
    });
  } catch (err) {
    logger.error(`daily-stats error: ${err.message}`);
    res.status(500).json({ error: "failed to get daily stats" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Block-driven arbitrage scheduling
// ─────────────────────────────────────────────────────────────────────────────
function startArbitrageScheduler() {
  const c = coordinator();
  if (c.scheduler) return c.scheduler;
  const { BlockScheduler } = require("../bot/blockScheduler");
  c.scheduler = new BlockScheduler({
    provider: c.provider,
    websocketUrl: process.env.MAINNET_WEBSOCKET,
    pollIntervalMs: c.profile.blockPollIntervalMs,
    enabled: () => botSettings.botActive || c.ledger.pending().length > 0,
    cancellable: () => Boolean(c.marketCache.head),
    budgetMs: () => c.marketCache.head ? c.profile.scanBudgetMs : 60000,
    onError: err => notifyError("block_scheduler", err),
    run: async options => {
      const startTime = Date.now();
      const result = await runArbWithTimeout(botSettings.flashbotsDefault, "block_scheduler", options);
      const elapsed = Date.now() - startTime;
      simulationHistogram.observe(elapsed / 1000);
      avgLatency.set(elapsed);
      if (result.executed) broadcastTradeExecuted({ ...result, timestamp: Date.now() });
    },
  }).start();
  return c.scheduler;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serve React front-end build
// ─────────────────────────────────────────────────────────────────────────────
const buildPath = path.join(__dirname, "../../frontend/build");
if (process.env.NODE_ENV !== "test") {
  app.use(express.static(buildPath));
  app.get("/{*path}", (_req, res) => res.sendFile(path.join(buildPath, "index.html")));
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Server for Real-Time Updates
// ─────────────────────────────────────────────────────────────────────────────
let wss = null;
const wsClients = new Set();

/**
 * Broadcast a message to all connected WebSocket clients
 * @param {string} type - Message type (e.g., "opportunity", "price_update", "trade_executed")
 * @param {Object} payload - Message payload
 */
function broadcastToClients(type, payload) {
  if (!wss || wsClients.size === 0) return;

  const message = JSON.stringify({ type, payload, timestamp: Date.now() });

  wsClients.forEach((client) => {
    if (client.readyState === WebSocket?.OPEN) {
      try {
        client.send(message);
      } catch (err) {
        logger.warn(`WebSocket send error: ${err.message}`);
      }
    }
  });
}

/**
 * Broadcast a new arbitrage opportunity
 * Transforms the internal opportunity format to the frontend format
 */
function broadcastOpportunity(opportunity) {
  // Transform BigNumber values to strings for JSON serialization
  const formatBigNumber = (bn) => {
    if (!bn) return "0";
    if (typeof bn === "string") return bn;
    if (bn._isBigNumber || bn.type === "BigNumber") {
      return ethers.utils.formatUnits(bn, 18);
    }
    return String(bn);
  };

  // Extract DEX path from swap data
  const extractDexPath = (swapData) => {
    if (!swapData || !swapData.paths) return [];
    // The paths array contains token addresses; we need to determine DEX from route
    if (swapData.route && typeof swapData.route === "string") {
      // Try to parse DEX names from the route string
      const dexes = [];
      if (swapData.route.includes("uniswap_v2")) dexes.push("uniswap_v2");
      if (swapData.route.includes("uniswap_v3")) dexes.push("uniswap_v3");
      if (swapData.route.includes("sushiswap")) dexes.push("sushiswap");
      if (swapData.route.includes("balancer")) dexes.push("balancer");
      if (swapData.route.includes("curve")) dexes.push("curve");
      return dexes.length > 0 ? dexes : ["uniswap_v2"]; // Default
    }
    return ["uniswap_v2"];
  };

  const formatted = {
    id: opportunity.id,
    chain: opportunity.chain || "ethereum",
    timestamp: opportunity.timestamp,
    route: opportunity.swapData?.route || "Unknown Route",
    dexPath: extractDexPath(opportunity.swapData),
    borrowAmount: formatBigNumber(opportunity.borrowAmount),
    estimatedOut: formatBigNumber(opportunity.estimatedOut),
    netProfit: formatBigNumber(opportunity.netProfit),
    gasCost: formatBigNumber(opportunity.gasCostDai),
    gasPrice: opportunity.gasPrice
      ? ethers.utils.formatUnits(opportunity.gasPrice, "gwei")
      : "0",
    mlScore: opportunity.mlScore || 0.5, // Default if not available
  };

  broadcastToClients("opportunity", formatted);
}

/**
 * Broadcast price update
 */
function broadcastPriceUpdate(priceData) {
  broadcastToClients("price_update", priceData);
}

/**
 * Broadcast trade execution result
 */
function broadcastTradeExecuted(tradeResult) {
  broadcastToClients("trade_executed", tradeResult);
}

/**
 * Initialize WebSocket server
 */
function initWebSocketServer(server) {
  if (!WebSocket) {
    logger.info(
      "[WebSocket] ws package not installed, real-time updates disabled"
    );
    return null;
  }

  wss = new WebSocket.Server({ server, path: "/ws", verifyClient: info => safeKeyEqual(info.req.headers["x-api-key"], process.env.API_KEY) });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    logger.info(`[WebSocket] Client connected from ${clientIp}`);
    wsClients.add(ws);

    // Send welcome message
    ws.send(
      JSON.stringify({
        type: "connected",
        payload: {
          message: "Connected to Flashloan Arbitrage Bot",
          serverTime: Date.now(),
        },
      })
    );

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data);
        // Handle client messages (e.g., subscribe to specific updates)
        if (message.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        }
      } catch (err) {
        logger.warn(`[WebSocket] Invalid message: ${err.message}`);
      }
    });

    ws.on("close", () => {
      wsClients.delete(ws);
      logger.info(
        `[WebSocket] Client disconnected (${wsClients.size} remaining)`
      );
    });

    ws.on("error", (err) => {
      logger.warn(`[WebSocket] Client error: ${err.message}`);
      wsClients.delete(ws);
    });
  });

  // Subscribe to event bus events and broadcast to clients
  eventBus.on("opportunity", (opportunity) => {
    broadcastOpportunity(opportunity);
  });

  eventBus.on("trade_executed", (result) => {
    broadcastTradeExecuted(result);
  });

  eventBus.on("price_update", (priceData) => {
    broadcastPriceUpdate(priceData);
  });

  eventBus.on("connext_transfer", (transferData) => {
    broadcastToClients("connext_transfer", transferData);
  });

  eventBus.on("circuit_breaker", (state) => {
    broadcastToClients("circuit_breaker", state);
  });

  logger.info(`[WebSocket] Server initialized on /ws path`);
  return wss;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
const start = async (port = PORT) => {
  // Initialize optional services
  if (process.env.TIMELOCK_ADDRESS) {
    await initTimelock();
  }

  if (process.env.CONNEXT_ADAPTER_ADDRESS) {
    await initConnext("ethereum").catch((err) => {
      logger.warn(`Connext initialization failed: ${err.message}`);
    });

    // Start Connext transfer monitoring
    if (process.env.CONNEXT_MONITORING !== "false") {
      startConnextMonitoring();
      logger.info("[Connext] Transfer monitoring started");
    }

    // Initialize Tier-1 features
    if (typeof initializeTier1Features === "function") {
      try {
        const tier1Results = await initializeTier1Features(provider);
        logger.info(
          `[Tier1] Initialization complete: ${JSON.stringify(tier1Results)}`
        );
      } catch (err) {
        logger.warn(`[Tier1] Initialization error: ${err.message}`);
      }
    }
  }

  // Create HTTP server for both Express and WebSocket
  const server = http.createServer(app);

  // Initialize WebSocket server
  initWebSocketServer(server);
  if (process.env.NODE_ENV !== "test") {
    const scheduler = startArbitrageScheduler();
    server.once("close", () => scheduler.stop());
  }

  return new Promise((resolve) => {
    server.listen(port, process.env.API_BIND_HOST || "127.0.0.1", () => {
      logger.info(`API listening on :${port}`);
      logger.info(`WebSocket available at ws://localhost:${port}/ws`);
      resolve(server);
    });
  });
};

if (require.main === module) {
  start(PORT);
}

module.exports = {
  app,
  start,
  // WebSocket broadcast functions for real-time updates
  broadcastOpportunity,
  broadcastPriceUpdate,
  broadcastTradeExecuted,
  broadcastToClients,
};
