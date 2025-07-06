// scripts/run-bot.js
/**
 * Simple runner for the arbitrage bot logic.
 * Imports simulateAndExecuteArb from server logic and loops indefinitely.
 * Usage:
 *   node scripts/run-bot.js
 */

require("dotenv").config({ override: true });
const { simulateAndExecuteArb } = require("../server/botLogic");

async function runBot() {
  console.log("🤖  Starting arbitrage bot...");
  while (true) {
    try {
      const result = await simulateAndExecuteArb(true);
      console.log(
        `🔄  Cycle complete: ${result ? "Executed tx" : "No action"}`
      );
    } catch (err) {
      console.error("❌  Bot error:", err.message || err);
    }
    // Wait 10 seconds between cycles
    await new Promise((res) => setTimeout(res, 10000));
  }
}

runBot().catch((err) => {
  console.error("❌  Fatal error in bot runner:", err);
  process.exit(1);
});

// scripts/run-backtest.js
/**
 * Runner for backtesting historical arbitrage.
 * Usage:
 *   node scripts/run-backtest.js
 */

require("dotenv").config({ override: true });
const { backtestArbitrage } = require("../server/scripts/backtestArbitrage");
const { ROUTES } = require("../server/botLogic");
const { ethers } = require("ethers");

(async () => {
  // Configure your block range and options here
  const startBlock = 17000000;
  const endBlock = 17000100;
  const borrowAmount = ethers.utils.parseEther("100");
  const slippageBips = parseInt(process.env.SLIPPAGE_BIPS || "50");

  console.log(`📊  Running backtest from block ${startBlock} to ${endBlock}`);
  const { tradeCount, totalProfit } = await backtestArbitrage(
    startBlock,
    endBlock,
    ROUTES,
    { borrowAmount, slippageBips }
  );
  console.log(
    `✅  Backtest complete: Profitable trades = ${tradeCount}, Total profit = ${ethers.utils.formatEther(
      totalProfit
    )} DAI`
  );
})();
