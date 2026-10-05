// scripts/run-bot.js
/**
 * Simple runner for the arbitrage bot logic.
 * Imports the production block scheduler; finite cycle runs remain available for diagnostics.
 * Usage:
 *   node scripts/run-bot.js
 */

const runtimeConfig = require("../server/utils/runtimeConfig");
const { simulateAndExecuteArb } = require("../server/botLogic");

const { features, optional } = runtimeConfig;

function featureStatus(label, enabled) {
  return `${enabled ? "✅" : "⚠️"} ${label}${enabled ? "" : " (disabled)"}`;
}

function describePriceIngestion() {
  const wsUrl = optional("MAINNET_WEBSOCKET").string();
  const httpUrl = optional("MAINNET_RPC_URL").string();
  if (wsUrl || httpUrl) {
    return wsUrl
      ? "✅ Price ingestion subscriptions enabled"
      : "⚠️ Price ingestion running in HTTP polling mode";
  }
  return "⚠️ Price ingestion disabled (set MAINNET_WEBSOCKET or MAINNET_RPC_URL)";
}

async function delay(ms) {
  if (ms > 0) {
    await new Promise((res) => setTimeout(res, ms));
  }
}

async function runBot({
  maxCycles = Infinity,
  pollIntervalMs = 1000,
  useFlashbots = true,
} = {}) {
  console.log("🤖  Starting arbitrage bot...");
  console.log(
    featureStatus(
      "Reinforcement learning slippage",
      features.reinforcementLearning
    )
  );
  console.log(featureStatus("Balancer routing", features.balancer));
  console.log(featureStatus("Curve routing", features.curve));
  console.log(describePriceIngestion());
  require("../server/bot/stateMachine").tradingState.paper();
  if (!Number.isFinite(maxCycles)) {
    const { getCoordinator } = require("../server/bot/coordinator");
    const { BlockScheduler } = require("../server/bot/blockScheduler");
    const c = getCoordinator();
    await c.startBackrun();
    let lastResult = { executed: false };
    return new Promise(resolve => {
      const stop = () => {
        c.scheduler.stop();
        c.stopBackrun();
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        resolve(lastResult);
      };
      c.scheduler = new BlockScheduler({
        provider: c.provider, websocketUrl: process.env.MAINNET_WEBSOCKET,
        pollIntervalMs: c.profile.blockPollIntervalMs,
        cancellable: () => Boolean(c.marketCache.head),
        budgetMs: () => c.marketCache.head ? c.profile.scanBudgetMs : 60000,
        run: async options => { lastResult = await simulateAndExecuteArb(useFlashbots, options); },
        onError: err => console.error("Bot scan failed:", err.message),
      }).start();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  }
  let cycles = 0;
  let lastResult = { executed: false, estimatedProfitInDai: null };

  while (cycles < maxCycles) {
    try {
      lastResult = await simulateAndExecuteArb(useFlashbots);
      if (lastResult?.executed) {
        console.log(
          `✅ Executed with profit ${lastResult.realizedNetProfit?.toString() || lastResult.estimatedProfitInDai.toString()} token base units`
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
  runBot().then(() => process.exit(0)).catch((err) => {
    console.error("❌  Fatal error in bot runner:", err);
    process.exit(1);
  });
}

module.exports = { runBot };
