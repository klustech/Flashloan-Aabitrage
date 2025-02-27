// server/scripts/server.js

const express = require("express");
const path = require("path");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");
const fs = require("fs");
const winston = require("winston");
const { ethers } = require("ethers"); // Added to support our profit module
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

// Import your existing bot logic
const {
  simulateAndExecuteArb,
  getCurrentMarketData,
  backtestArbitrage,
  updateMinBorrowAmount,
  updateSimulationInputAmount,
} = require("./botLogic");

// Import our new profit determination module
const { determineProfit } = require("../../utils/profitDetermination");

const app = express();
const PORT = process.env.PORT || 3001;

let botSettings = {
  botActive: true,
  flashbotsDefault: process.env.FLASHBOTS_DEFAULT === "true",
  pollingInterval: 60,
  gasPriceCeiling: parseInt(process.env.GAS_PRICE_CEILING) || 50,
  slippageBips: parseInt(process.env.SLIPPAGE_BIPS) || 50,
  minBorrowAmount: 100,
  simulationInputAmount: 1000000,
};

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: "Too many requests, please try again later.",
});
app.use(apiLimiter);
app.use(cors());
app.use(express.json());

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "server.log" }),
  ],
});

app.use((req, res, next) => {
  logger.info(`${req.method} request to ${req.path}`);
  next();
});

// API Endpoints

app.get("/api/market-data", async (req, res) => {
  try {
    const data = await getCurrentMarketData();
    const formattedData = {
      tokenIn: "DAI",
      tokenOut: "WETH",
      uniswapPrice: data?.dai?.usd?.toString() || "0",
      sushiPrice: data?.weth?.usd?.toString() || "0",
    };
    logger.info(`Market Data Retrieved: ${JSON.stringify(formattedData)}`);
    res.json(formattedData);
  } catch (error) {
    logger.error(`Error fetching market data: ${error.message}`);
    res.status(500).json({ error: "Failed to fetch market data" });
  }
});

app.get("/api/bot-logs", async (req, res) => {
  try {
    const logs = fs
      .readFileSync("bot.log", "utf-8")
      .split("\n")
      .filter(Boolean);
    res.json(logs);
  } catch (error) {
    logger.error(`Error fetching bot logs: ${error.message}`);
    res.status(500).json({ error: "Failed to fetch bot logs" });
  }
});

// New Endpoint: Simulate Profit Determination
app.get("/api/simulate-profit", async (req, res) => {
  try {
    // Set up an ethers provider (using Infura)
    const provider = new ethers.providers.InfuraProvider(
      "mainnet",
      process.env.INFURA_API_KEY || "your_infura_key_here"
    );

    // Define a simulated route for DAI -> WETH -> DAI using hardcoded conversion rates and slippage.
    // (These values mirror those in our profitDetermination module.)
    const route = {
      name: "DAI → WETH → DAI (Uniswap)",
      steps: [
        {
          description: "DAI to WETH",
          simulate: (amount) => {
            // Assume 1 ETH = 2000 DAI and apply a 0.5% slippage.
            let wethAmount = amount / 2000;
            return wethAmount * (1 - 0.005);
          },
        },
        {
          description: "WETH to DAI",
          simulate: (amount) => {
            let daiAmount = amount * 2000;
            return daiAmount * (1 - 0.005);
          },
        },
      ],
    };

    // For simulation, assume a gas usage value (in wei units as BigNumber)
    const gasUsed = ethers.BigNumber.from("200000");

    // Input trade size (in DAI) is taken from our simulationInputAmount
    const inputAmount = 1000000;

    // Create a configuration object (matching those used in profitDetermination.js)
    const simConfig = {
      ethToDaiRate: 2000,
      slippageTolerance: 0.005,
      gasPriceLimit: ethers.utils.parseUnits("50", "gwei"),
      tradeSize: 1000000,
      flashloanPremiumBips: 9,
    };

    const result = await determineProfit(
      provider,
      route,
      inputAmount,
      gasUsed,
      simConfig.flashloanPremiumBips,
      simConfig
    );

    res.json(result);
  } catch (error) {
    logger.error(`Error in simulate-profit endpoint: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/trigger-arbitrage", async (req, res) => {
  try {
    const useFlashbots =
      req.query.flashbots === "true" || botSettings.flashbotsDefault;
    logger.info(
      `Manual arbitrage trigger requested. useFlashbots=${useFlashbots}`
    );
    const success = await simulateAndExecuteArb(useFlashbots);
    if (success) {
      logger.info("Arbitrage executed successfully after manual trigger.");
      res.json({
        status: "ok",
        message: "Arbitrage executed successfully",
      });
    } else {
      logger.info("No arbitrage opportunity found after manual trigger.");
      res.json({
        status: "no-opportunity",
        message: "No arbitrage opportunity found",
      });
    }
  } catch (error) {
    logger.error(`Error triggering arbitrage: ${error.message}`);
    res.status(500).json({ error: "Failed to trigger arbitrage" });
  }
});

app.get("/api/settings", (req, res) => {
  res.json(botSettings);
});

app.post("/api/settings", (req, res) => {
  try {
    const allowedSettings = [
      "flashbotsDefault",
      "pollingInterval",
      "gasPriceCeiling",
      "slippageBips",
      "minBorrowAmount",
      "simulationInputAmount",
    ];
    allowedSettings.forEach((key) => {
      if (req.body[key] !== undefined) {
        botSettings[key] = req.body[key];
        if (key === "minBorrowAmount") {
          updateMinBorrowAmount(req.body[key]);
        }
        if (key === "simulationInputAmount") {
          updateSimulationInputAmount(req.body[key]);
        }
      }
    });
    logger.info(`Bot settings updated: ${JSON.stringify(botSettings)}`);
    res.json({ status: "ok", settings: botSettings });
  } catch (error) {
    logger.error(`Error updating settings: ${error.message}`);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

app.post("/api/start-bot", (req, res) => {
  botSettings.botActive = true;
  logger.info("Bot started (active).");
  res.json({ status: "ok", message: "Bot started", settings: botSettings });
});

app.post("/api/stop-bot", (req, res) => {
  botSettings.botActive = false;
  logger.info("Bot stopped (inactive).");
  res.json({ status: "ok", message: "Bot stopped", settings: botSettings });
});

// Cron Job for Scheduled Arbitrage Checks
cron.schedule("* * * * *", async () => {
  const currentTime = new Date().toISOString();
  logger.info(`${currentTime} - Scheduled arbitrage check running...`);
  if (!botSettings.botActive) {
    logger.info("Bot is stopped; skipping scheduled arbitrage check.");
    return;
  }
  try {
    const useFlashbots = botSettings.flashbotsDefault;
    const success = await simulateAndExecuteArb(useFlashbots);
    if (success) {
      logger.info("Arbitrage executed successfully via scheduler.");
    } else {
      logger.info("No arbitrage opportunity found via scheduler.");
    }
  } catch (error) {
    logger.error(`Error during scheduled arbitrage check: ${error.message}`);
  }
});

// Serve Frontend Static Files
const frontendBuildPath = path.join(__dirname, "../../frontend/build");
app.use(express.static(frontendBuildPath));
app.get("*", (req, res) => {
  res.sendFile(path.join(frontendBuildPath, "index.html"));
});

app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
});
