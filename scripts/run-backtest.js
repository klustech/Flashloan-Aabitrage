// scripts/run-backtest.js
/**
 * Runner for backtesting arbitrage routes against historical data.
 *
 * Usage:
 *   node scripts/run-backtest.js
 */

require("dotenv").config({ override: true });
const { backtestArbitrage } = require("../server/scripts/backtestArbitrage");
const { ROUTES } = require("../server/scripts/botLogic");
const { ethers } = require("ethers");

(async () => {
  const startBlock = 17000000;
  const endBlock = 17000100;
  const borrowAmount = ethers.utils.parseEther("100");
  const slippageBips = parseInt(process.env.SLIPPAGE_BIPS || "50", 10);

  console.log(`📊  Running backtest from block ${startBlock} to ${endBlock}`);
  const { tradeCount, totalProfit } = await backtestArbitrage(
    startBlock,
    endBlock,
    ROUTES,
    { borrowAmount, slippageBips }
  );
  console.log(
    `✅  Backtest complete: Profitable trades = ${tradeCount}, ` +
      `Total profit = ${ethers.utils.formatEther(totalProfit)} DAI`
  );
})();
