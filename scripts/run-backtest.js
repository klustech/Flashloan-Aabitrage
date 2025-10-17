// scripts/run-backtest.js
/**
 * Runner for backtesting historical arbitrage.
 * Usage:
 *   node scripts/run-backtest.js
 */

require("dotenv").config({ override: true });
const { ethers } = require("ethers");
const { backtestArbitrage } = require("../server/scripts/backtestArbitrage");
const { getAllRoutes, DEFAULT_CHAIN } = require("../server/botLogic");

async function runBacktest({
  startBlock = 17_000_000,
  endBlock = 17_000_100,
  borrowAmount,
  slippageBips = parseInt(process.env.SLIPPAGE_BIPS || "50", 10),
  chain = DEFAULT_CHAIN,
  routes,
} = {}) {
  const resolvedBorrowAmount = borrowAmount
    ? borrowAmount
    : ethers.utils.parseEther(process.env.BACKTEST_BORROW_DAI || "100");

  const resolvedRoutes = routes || (await getAllRoutes(chain));
  if (!resolvedRoutes || resolvedRoutes.length === 0) {
    console.warn(`⚠️  No routes available for chain ${chain}; results may be empty.`);
  }

  console.log(`📊  Running backtest from block ${startBlock} to ${endBlock}`);

  const summary = await backtestArbitrage(startBlock, endBlock, resolvedRoutes, {
    borrowAmount: resolvedBorrowAmount,
    slippageBips,
  });

  const formattedProfit = ethers.BigNumber.isBigNumber(summary.totalProfit)
    ? ethers.utils.formatEther(summary.totalProfit)
    : summary.totalProfit;

  console.log(
    `✅  Backtest complete: Profitable trades = ${summary.tradeCount}, Total profit = ${formattedProfit} DAI`
  );

  return summary;
}

if (require.main === module) {
  runBacktest().catch((err) => {
    console.error("❌  Fatal error in backtest runner:", err);
    process.exit(1);
  });
}

module.exports = { runBacktest };
