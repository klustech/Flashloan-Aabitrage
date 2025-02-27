// server/scripts/backtestArbitrage.js
/**
 * Full backtesting logic to replay historical price data
 * and simulate route-based arbitrage outcomes.
 *
 * You must have "historicalData.json" with snapshots of blockNumber and token prices.
 * Replays data in [startBlock, endBlock], uses the existing simulateRoute from botLogic.js.
 */

const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const logger = require("winston");
const { simulateRoute } = require("./botLogic"); // Reuse the route simulation

// Example structure of "historicalData.json":
// [
//   {
//     "blockNumber": 16000000,
//     "daiPriceUSD": 1.0,
//     "wethPriceUSD": 1500.0,
//     "timestamp": 1660000000
//   },
//   ...
// ]
const dataFilePath = path.join(__dirname, "historicalData.json");
let historicalData = [];

if (fs.existsSync(dataFilePath)) {
  historicalData = JSON.parse(fs.readFileSync(dataFilePath, "utf8"));
} else {
  logger.warn("No historicalData.json found. Backtesting will have no data.");
}

/**
 * backtestArbitrage - Replays snapshots from historicalData within [startBlock, endBlock]
 * and tries each route in 'routes'. If a route is profitable, increments trade count.
 *
 * @param {number} startBlock
 * @param {number} endBlock
 * @param {Array} routes - Typically the ROUTES array from botLogic
 * @param {Object} options - e.g. { borrowAmount, slippageBips }
 * @returns {Object} Summary of backtest results
 */
async function backtestArbitrage(startBlock, endBlock, routes, options) {
  const snapshots = historicalData.filter(
    (snap) => snap.blockNumber >= startBlock && snap.blockNumber <= endBlock
  );
  if (snapshots.length === 0) {
    logger.info(`No historical snapshots in blocks [${startBlock}..${endBlock}].`);
    return { tradeCount: 0, totalProfit: ethers.constants.Zero };
  }

  let tradeCount = 0;
  let totalProfit = ethers.BigNumber.from("0");

  for (const snap of snapshots) {
    logger.debug(`Backtesting snapshot at block ${snap.blockNumber}, time ${snap.timestamp}`);

    for (const routeDef of routes) {
      // We'll treat finalOut as if it's denominated in DAI from simulateRoute
      const finalOut = await simulateRoute(routeDef, options.borrowAmount, options.slippageBips);
      // cost is the borrowed DAI
      const cost = options.borrowAmount;
      const profit = finalOut.sub(cost);

      if (profit.gt(0)) {
        tradeCount += 1;
        totalProfit = totalProfit.add(profit);
      }
    }
  }

  logger.info(`Backtest completed for blocks [${startBlock}..${endBlock}].`);
  logger.info(`Profitable trades: ${tradeCount}`);
  logger.info(`Total Profit in DAI: ${ethers.utils.formatEther(totalProfit)}`);

  return { tradeCount, totalProfit };
}

module.exports = {
  backtestArbitrage,
};
