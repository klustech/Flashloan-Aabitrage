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
const winston = require("winston");
const { ethers } = require("ethers");
const { getEnv, loadRequired } = require("../../utils/config");
const {
  determineProfit,
  getSimulationConfig,
} = require("../../utils/profitDetermination");
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
const {
  simulateAndExecuteArb,
  getCurrentMarketData,
  updateMinBorrowAmount,
  updateSimulationInputAmount,
  getRecentOpportunities,
} = require("../botLogic");

// ─────────────────────────────────────────────────────────────────────────────
// Slack Alerts Utility
// ─────────────────────────────────────────────────────────────────────────────
const { sendSlackAlert } = require("./slackUtils");

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

process.on("unhandledRejection", (reason) => {
  logger.error(
    `Unhandled Rejection: ${reason instanceof Error ? reason.message : reason}`
  );
});

process.on("uncaughtException", (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
  process.exit(1);
});

// Log each incoming request
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// In-memory bot settings
// ─────────────────────────────────────────────────────────────────────────────
let botSettings = {
  botActive: true,
  flashbotsDefault: process.env.FLASHBOTS_DEFAULT === "true",
  pollingInterval: 60,
  gasPriceCeiling: parseInt(process.env.GAS_PRICE_CEILING, 10) || 50,
  slippageBips: parseInt(process.env.SLIPPAGE_BIPS, 10) || 50,
  minBorrowAmount: parseInt(process.env.MIN_BORROW_AMOUNT, 10) || 100,
  simulationInputAmount:
    parseInt(process.env.SIMULATION_INPUT_AMOUNT, 10) || 1_000_000,
};

// ─────────────────────────────────────────────────────────────────────────────
// REST endpoints
// ─────────────────────────────────────────────────────────────────────────────

// GET /metrics
// Expose Prometheus metrics
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", register.contentType);
  res.send(await register.metrics());
});

// GET /api/metrics-json
// Return metrics in JSON form for the front-end
app.get("/api/metrics-json", async (_req, res) => {
  try {
    const data = await register.getMetricsAsJSON();
    res.json(data);
  } catch (err) {
    logger.error(`metrics-json error: ${err.message}`);
    res.status(500).json({ error: "failed to fetch metrics" });
  }
});

// GET /api/market-data
// Returns uniswapPrice and sushiPrice for 1 DAI → WETH,
// wraps getAmountsOut calls in try/catch to avoid errors.
app.get("/api/market-data", async (_req, res) => {
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
    logger.error(`Market data endpoint error: ${err.message}`);
    res.status(500).json({ error: "failed to fetch market data" });
  }
});

// GET /api/bot-logs
// Returns the contents of bot.log as a JSON array
app.get("/api/bot-logs", (_req, res) => {
  try {
    const logs = fs
      .readFileSync("bot.log", "utf-8")
      .split("\n")
      .filter(Boolean);
    res.json(logs);
  } catch (err) {
    logger.error(`Log read error: ${err.message}`);
    res.status(500).json({ error: "failed to read bot.log" });
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
app.post("/api/trigger-arbitrage", async (req, res) => {
  try {
    const useFlashbots =
      req.query.flashbots === "true" || botSettings.flashbotsDefault;
    logger.info(`Manual trigger (flashbots=${useFlashbots})`);

    const startTime = Date.now();
    arbAttempts.inc();

    const result = await simulateAndExecuteArb(useFlashbots);
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
  } catch (err) {
    arbFailure.labels("exception").inc();
    logger.error(`Trigger error: ${err.message}`);
    res.status(500).json({ error: "trigger failed" });
  }
});

// GET /api/settings
app.get("/api/settings", (_req, res) => {
  res.json(botSettings);
});

// POST /api/settings
// Allowed fields: flashbotsDefault, pollingInterval, gasPriceCeiling,
// slippageBips, minBorrowAmount, simulationInputAmount
app.post("/api/settings", (req, res) => {
  try {
    const allowed = [
      "flashbotsDefault",
      "pollingInterval",
      "gasPriceCeiling",
      "slippageBips",
      "minBorrowAmount",
      "simulationInputAmount",
    ];

    allowed.forEach((k) => {
      if (req.body[k] !== undefined) {
        botSettings[k] = req.body[k];
        if (k === "minBorrowAmount") updateMinBorrowAmount(req.body[k]);
        if (k === "simulationInputAmount")
          updateSimulationInputAmount(req.body[k]);
      }
    });

    logger.info(`Settings updated: ${JSON.stringify(botSettings)}`);
    res.json({ status: "ok", settings: botSettings });
  } catch (err) {
    logger.error(`Settings error: ${err.message}`);
    res.status(500).json({ error: "update failed" });
  }
});

// POST /api/start-bot
app.post("/api/start-bot", (_req, res) => {
  botSettings.botActive = true;
  logger.info("Bot started");
  res.json({ status: "ok", settings: botSettings });
});

// POST /api/stop-bot
app.post("/api/stop-bot", (_req, res) => {
  botSettings.botActive = false;
  logger.info("Bot stopped");
  res.json({ status: "ok", settings: botSettings });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cron: scheduled arbitrage checks (once per minute)
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule("* * * * *", async () => {
  if (!botSettings.botActive) return;
  try {
    const startTime = Date.now();
    arbAttempts.inc();

    const result = await simulateAndExecuteArb(botSettings.flashbotsDefault);
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
  } catch (err) {
    arbFailure.labels("exception").inc();
    logger.error(`Scheduler error: ${err.message}`);
    // If circuit breaker logic in botLogic paused the bot, send Slack alert
    if (err.message.includes("Circuit breaker")) {
      sendSlackAlert(err.message);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Serve React front-end build
// ─────────────────────────────────────────────────────────────────────────────
const buildPath = path.join(__dirname, "../../frontend/build");
app.use(express.static(buildPath));
app.get("*", (_req, res) => res.sendFile(path.join(buildPath, "index.html")));

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => logger.info(`🟢  API listening on :${PORT}`));
