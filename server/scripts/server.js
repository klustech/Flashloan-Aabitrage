// server/scripts/server.js
//
// Express API for the arbitrage bot.
// ──────────────────────────────────────────────────────────────────
// ▸ Adds express-rate-limit (30 req / 5 min).
// ▸ Optional x-api-key header auth (set API_KEY in .env to enable).
// ▸ Original endpoints & logic preserved.

const express = require("express");
const path = require("path");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");
const fs = require("fs");
const winston = require("winston");
const { ethers } = require("ethers");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

/* ────────────────────────────────────────────────────────────────
   Bot logic & helpers
   ────────────────────────────────────────────────────────────────*/
const {
  simulateAndExecuteArb,
  getCurrentMarketData,
  backtestArbitrage,
  updateMinBorrowAmount,
  updateSimulationInputAmount,
} = require("./botLogic");
const { determineProfit } = require("../../utils/profitDetermination");

/* ────────────────────────────────────────────────────────────────
   Express init & middleware
   ────────────────────────────────────────────────────────────────*/
const app = express();
const PORT = process.env.PORT || 3001;

// rate-limit 30 requests / 5 minutes per IP
app.use(
  rateLimit({
    windowMs: 300_000, // 5 min
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests – slow down 🙏",
  })
);

// optional x-api-key auth
app.use((req, res, next) => {
  const { API_KEY } = process.env;
  if (!API_KEY) return next(); // auth disabled
  if (req.headers["x-api-key"] !== API_KEY) return res.sendStatus(401);
  next();
});

app.use(cors());
app.use(express.json());

/* ────────────────────────────────────────────────────────────────
   Winston logger
   ────────────────────────────────────────────────────────────────*/
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

// request log middleware
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

/* ────────────────────────────────────────────────────────────────
   In-memory bot settings (persist however you like)
   ────────────────────────────────────────────────────────────────*/
let botSettings = {
  botActive: true,
  flashbotsDefault: process.env.FLASHBOTS_DEFAULT === "true",
  pollingInterval: 60,
  gasPriceCeiling: parseInt(process.env.GAS_PRICE_CEILING) || 50,
  slippageBips: parseInt(process.env.SLIPPAGE_BIPS) || 50,
  minBorrowAmount: 100,
  simulationInputAmount: 1_000_000,
};

/* ────────────────────────────────────────────────────────────────
   REST endpoints
   ────────────────────────────────────────────────────────────────*/

// Live market data
app.get("/api/market-data", async (_req, res) => {
  try {
    const data = await getCurrentMarketData();
    const payload = {
      tokenIn: "DAI",
      tokenOut: "WETH",
      uniswapPrice: data?.dai?.usd?.toString() || "0",
      sushiPrice: data?.weth?.usd?.toString() || "0",
    };
    logger.info(`Market data: ${JSON.stringify(payload)}`);
    res.json(payload);
  } catch (err) {
    logger.error(`Market data error: ${err.message}`);
    res.status(500).json({ error: "failed to fetch market data" });
  }
});

// Bot logs
app.get("/api/bot-logs", (_req, res) => {
  try {
    const logs = fs
      .readFileSync("bot.log", "utf-8")
      .split("\n")
      .filter(Boolean);
    res.json(logs);
  } catch (err) {
    logger.error(`Log read error: ${err.message}`);
    res.status(500).json({ error: "failed to read logs" });
  }
});

// Profit simulation demo
app.get("/api/simulate-profit", async (_req, res) => {
  try {
    const provider = new ethers.providers.InfuraProvider(
      "mainnet",
      process.env.INFURA_API_KEY || "demo"
    );

    const route = {
      name: "DAI→WETH→DAI (Uni)",
      steps: [
        {
          description: "DAI→WETH",
          simulate: (amt) => (amt / 2000) * 0.995, // 0.5 % slippage
        },
        {
          description: "WETH→DAI",
          simulate: (amt) => amt * 2000 * 1.03 * 0.995, // 3 % favourable
        },
      ],
    };

    const gasUsed = ethers.BigNumber.from("200000");
    const input = 1_000_000;
    const simCfg = {
      ethToDaiRate: 2000,
      slippageTolerance: 0.005,
      gasPriceLimit: ethers.utils.parseUnits("50", "gwei"),
      tradeSize: input,
      flashloanPremiumBips: 9,
    };

    const result = await determineProfit(
      provider,
      route,
      input,
      gasUsed,
      simCfg.flashloanPremiumBips,
      simCfg
    );

    res.json(result);
  } catch (err) {
    logger.error(`simulate-profit error: ${err.message}`);
    res.status(500).json({ error: "simulation failed" });
  }
});

// Manual arb trigger
app.post("/api/trigger-arbitrage", async (req, res) => {
  try {
    const useFlashbots =
      req.query.flashbots === "true" || botSettings.flashbotsDefault;
    logger.info(`Manual trigger (flashbots=${useFlashbots})`);

    const ok = await simulateAndExecuteArb(useFlashbots);
    res.json(
      ok
        ? { status: "executed", message: "Arbitrage executed" }
        : { status: "noop", message: "No opportunity" }
    );
  } catch (err) {
    logger.error(`Trigger error: ${err.message}`);
    res.status(500).json({ error: "trigger failed" });
  }
});

// View / update settings
app.get("/api/settings", (_req, res) => res.json(botSettings));

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

// Start / stop bot
app.post("/api/start-bot", (_req, res) => {
  botSettings.botActive = true;
  logger.info("Bot started");
  res.json({ status: "ok", settings: botSettings });
});
app.post("/api/stop-bot", (_req, res) => {
  botSettings.botActive = false;
  logger.info("Bot stopped");
  res.json({ status: "ok", settings: botSettings });
});

/* ────────────────────────────────────────────────────────────────
   Cron: scheduled arbitrage checks
   ────────────────────────────────────────────────────────────────*/
cron.schedule("* * * * *", async () => {
  if (!botSettings.botActive) return;
  try {
    const ok = await simulateAndExecuteArb(botSettings.flashbotsDefault);
    logger.info(ok ? "Scheduler: executed arb" : "Scheduler: no opportunity");
  } catch (err) {
    logger.error(`Scheduler error: ${err.message}`);
  }
});

/* ────────────────────────────────────────────────────────────────
   Serve React front-end build (unchanged)
   ────────────────────────────────────────────────────────────────*/
const buildPath = path.join(__dirname, "../../frontend/build");
app.use(express.static(buildPath));
app.get("*", (_req, res) => res.sendFile(path.join(buildPath, "index.html")));

/* ────────────────────────────────────────────────────────────────
   Boot
   ────────────────────────────────────────────────────────────────*/
app.listen(PORT, () => logger.info(`🟢  API listening on :${PORT}`));
