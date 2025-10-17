// scripts/run-bot.js
/**
 * Simple runner for the arbitrage bot logic.
 * Imports simulateAndExecuteArb from server logic and loops indefinitely.
 * Usage:
 *   node scripts/run-bot.js
 */

require("dotenv").config({ override: true });
const { simulateAndExecuteArb } = require("../server/botLogic");

async function delay(ms) {
  if (ms > 0) {
    await new Promise((res) => setTimeout(res, ms));
  }
}

async function runBot({
  maxCycles = Infinity,
  pollIntervalMs = 10_000,
  useFlashbots = true,
} = {}) {
  console.log("🤖  Starting arbitrage bot...");
  let cycles = 0;
  let lastResult = { executed: false, estimatedProfitInDai: null };

  while (cycles < maxCycles) {
    try {
      lastResult = await simulateAndExecuteArb(useFlashbots);
      if (lastResult?.executed) {
        console.log(
          `✅ Executed with profit ${lastResult.estimatedProfitInDai.toString()} wei`
        );
      } else {
        console.log("🔄  Cycle complete: No action");
      }
    } catch (err) {
      console.error("❌  Bot error:", err?.message || err);
    }

    cycles += 1;
    if (cycles < maxCycles) {
      await delay(pollIntervalMs);
    }
  }

  return lastResult;
}

if (require.main === module) {
  runBot().catch((err) => {
    console.error("❌  Fatal error in bot runner:", err);
    process.exit(1);
  });
}

module.exports = { runBot };
