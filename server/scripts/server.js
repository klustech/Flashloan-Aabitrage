// server/scripts/server.js

/**
 * Express API for the Flashloan Arbitrage Bot.
 *  - Exposes endpoints to fetch live market data (DAI→WETH), read bot logs, trigger arbitrage, update settings, and metrics.
 *  - Runs a scheduled job every minute to invoke simulateAndExecuteArb(...) if botSettings.botActive is true.
 */

const express = require("express");
const path = require("path");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");
const fs = require("fs");
const readline = require("readline");
const winston = require("winston");
const { ethers } = require("ethers");
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
} = loadBotLogic();

// ─────────────────────────────────────────────────────────────────────────────
// Slack Alerts Utility
// ─────────────────────────────────────────────────────────────────────────────
const { sendSlackAlert } = require("./slackUtils");

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

const { getRecentTrades } = loadDbClient();

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
  if (!resolved.startsWith(LOGS_BASE_DIR + path.sep) && resolved !== LOGS_BASE_DIR) {
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

// Optional x-api-key auth (if you set API_KEY in .env)
app.use((req, res, next) => {
  const { API_KEY } = process.env;
  if (!API_KEY) return next();
  if (req.headers["x-api-key"] !== API_KEY) return res.sendStatus(401);
  next();
});

app.use(cors());
app.use(express.json());

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
    (typeof err.message === "string" && err.message.includes("Circuit breaker"));
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

async function runArbWithTimeout(useFlashbots, contextLabel) {
  const timeoutMs = ARB_TIMEOUT_MS;
  const controller = new AbortController();
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
    signal: controller.signal,
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
    const isTimeout = err.name === "AbortError" || err.metricReason === "timeout";
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
    arbPromise.catch(() => {});
  }
}

const getHealthStatus = () => {
  const now = Date.now();
  const stale =
    workerStatus.lastRunAt && now - workerStatus.lastRunAt > HEALTH_STALE_THRESHOLD_MS;
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

const rawInitialSettings = {
  ...settingsDefaults,
  flashbotsDefault:
    process.env.FLASHBOTS_DEFAULT === undefined
      ? settingsDefaults.flashbotsDefault
      : process.env.FLASHBOTS_DEFAULT === "true",
  pollingInterval:
    parseOptionalInt(process.env.POLLING_INTERVAL) ??
    settingsDefaults.pollingInterval,
  gasPriceCeiling:
    parseOptionalInt(process.env.GAS_PRICE_CEILING) ??
    settingsDefaults.gasPriceCeiling,
  slippageBips:
    parseOptionalInt(process.env.SLIPPAGE_BIPS) ?? settingsDefaults.slippageBips,
  minBorrowAmount:
    parseOptionalInt(process.env.MIN_BORROW_AMOUNT) ??
    settingsDefaults.minBorrowAmount,
  simulationInputAmount:
    parseOptionalInt(process.env.SIMULATION_INPUT_AMOUNT) ??
    settingsDefaults.simulationInputAmount,
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

      const route = {
        name: "DAI→WETH→DAI (Uni)",
        steps: [
          {
            description: "DAI→WETH",
            simulate: (amt) => (amt / 2000) * 0.995,
          },
          {
            description: "WETH→DAI",
            simulate: (amt) => amt * 2000 * 1.03 * 0.995,
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

      const result = await determineProfit(
        providerInfura,
        route,
        borrowAmountWei,
        ethers.BigNumber.from("200000"),
        botSettings.slippageBips,
        simulationConfig,
        borrowAmountNumber
      );

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

    const borrowAmountBN = ethers.BigNumber.from(latestOpportunity.borrowAmount);
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
    res.json(botSettings);
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
          `Settings validation failed: ${JSON.stringify(details)} | payload=${JSON.stringify(
            req.body
          )}`
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

      logger.info(`Settings updated: ${JSON.stringify(botSettings)}`);
      res.json({ status: "ok", settings: botSettings });
    } catch (err) {
      err.statusCode = err.statusCode || 500;
      err.publicMessage = err.publicMessage || "update failed";
      err.metricReason = err.metricReason || "settings_error";
      throw err;
    }
  })
);

// POST /api/start-bot
app.post(
  "/api/start-bot",
  withErrorBoundary("start_bot", (_req, res) => {
    botSettings.botActive = true;
    logger.info("Bot started");
    recordWorkerState({ lastTimeoutAt: null, lastErrorMessage: null });
    res.json({ status: "ok", settings: botSettings });
  })
);

// POST /api/stop-bot
app.post(
  "/api/stop-bot",
  withErrorBoundary("stop_bot", (_req, res) => {
    botSettings.botActive = false;
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
// Cron: scheduled arbitrage checks (once per minute)
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== "test") {
  cron.schedule(
    "* * * * *",
    withCronBoundary("scheduler", async () => {
      if (!botSettings.botActive) {
        recordWorkerState({ running: false });
        return;
      }

      const startTime = Date.now();
      arbAttempts.inc();

      const result = await runArbWithTimeout(
        botSettings.flashbotsDefault,
        "scheduler"
      );
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
        logger.info("Scheduler: executed arb");
      } else {
        arbFailure.labels("no_opportunity").inc();
        logger.info("Scheduler: no opportunity");
      }
    })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Serve React front-end build
// ─────────────────────────────────────────────────────────────────────────────
const buildPath = path.join(__dirname, "../../frontend/build");
if (process.env.NODE_ENV !== "test") {
  app.use(express.static(buildPath));
  app.get("*", (_req, res) => res.sendFile(path.join(buildPath, "index.html")));
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
const start = (port = PORT) =>
  app.listen(port, () => logger.info(`🟢  API listening on :${port}`));

if (require.main === module) {
  start(PORT);
}

module.exports = { app, start };
