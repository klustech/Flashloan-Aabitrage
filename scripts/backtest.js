/**
 * scripts/backtest.js
 *
 * Backtest the arbitrage logic over a range of blocks by forking Hardhat repeatedly.
 * Added a small delay after each hardhat_reset call to avoid Infura rate limits.
 * Wrapped contract deployment and gas estimation in try/catch to avoid “baseFee” errors.
 */

require("dotenv").config({ override: true });
const fs = require("fs-extra");
const { createObjectCsvWriter } = require("csv-writer");
const hre = require("hardhat");
const { ethers } = hre;

// Sleep helper to throttle RPC calls
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const startBlock = parseInt(process.argv[2], 10);
  const endBlock = parseInt(process.argv[3], 10);
  const borrowAmt = ethers.utils.parseUnits(
    process.env.SIMULATION_INPUT_AMOUNT,
    18
  );

  if (isNaN(startBlock) || isNaN(endBlock)) {
    console.error("Usage: node scripts/backtest.js <startBlock> <endBlock>");
    process.exit(1);
  }

  const csvWriter = createObjectCsvWriter({
    path: "backtest_results.csv",
    header: [
      { id: "block", title: "Block" },
      { id: "stage", title: "Stage" }, // "DeployError", "NoRoutes", "MLFiltered", "NoProfitableRoute", or "Success"
      { id: "route", title: "Route" },
      { id: "profit", title: "Profit" },
      { id: "gasUsed", title: "GasUsed" },
      { id: "success", title: "Success" },
    ],
    append: false,
  });

  await fs.remove("backtest_results.csv");
  console.log(`Backtesting from block ${startBlock} to ${endBlock}…`);

  for (let b = startBlock; b <= endBlock; b++) {
    // 1) Reset Hardhat fork to block b
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.MAINNET_RPC_URL,
            blockNumber: b,
          },
        },
      ],
    });

    // 2) Throttle briefly to avoid “429 Too Many Requests” from Infura
    await sleep(300);

    // 3) Attempt to deploy ArbitrageFlashloan with gas overrides
    let arbitrage;
    try {
      const ArbFactory = await ethers.getContractFactory("ArbitrageFlashloan");
      arbitrage = await ArbFactory.deploy(
        process.env.AAVE_LENDING_POOL_ADDRESS_PROVIDER,
        parseInt(process.env.MAX_LOSS_BPS, 10),
        parseInt(process.env.FLASHLOAN_PREMIUM_BIPS, 10),
        {
          maxFeePerGas: ethers.utils.parseUnits("1000", "gwei"),
          maxPriorityFeePerGas: ethers.utils.parseUnits("2", "gwei"),
        }
      );
      await arbitrage.deployed();
    } catch {
      // If deployment fails due to baseFee issues, skip this block
      await csvWriter.writeRecords([
        {
          block: b,
          stage: "DeployError",
          route: "",
          profit: "0",
          gasUsed: "0",
          success: "false",
        },
      ]);
      console.log(`Block ${b}: DeployError`);
      continue;
    }

    // 4) Generate candidate routes
    const { routeFinder } = require("../utils/routeFinder");
    let routes;
    try {
      routes = await routeFinder(borrowAmt);
    } catch {
      routes = [];
    }
    if (!routes || routes.length === 0) {
      await csvWriter.writeRecords([
        {
          block: b,
          stage: "NoRoutes",
          route: "",
          profit: "0",
          gasUsed: "0",
          success: "false",
        },
      ]);
      console.log(`Block ${b}: NoRoutes`);
      continue;
    }

    // 5) Score & prune with ML
    const scores = await Promise.all(
      routes.map((r) => {
        const feats = [
          r.hops.length,
          r.liquidity || 0,
          r.fee || 3000,
          r.volatility || 0,
          r.estimatedGasCost || 0,
          r.historicalSuccessCount || 0,
        ];
        return fetch(process.env.ML_MODEL_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ features: [feats] }),
        })
          .then((res) => res.json())
          .catch(() => ({ probabilities: [0] }));
      })
    );
    const topRoutes = routes
      .map((r, idx) => ({ route: r, score: scores[idx].probabilities[0] }))
      .filter((x) => x.score > parseFloat(process.env.ML_THRESHOLD))
      .sort((a, b) => b.score - a.score)
      .slice(0, parseInt(process.env.ML_TOPK, 10))
      .map((x) => x.route);
    if (topRoutes.length === 0) {
      await csvWriter.writeRecords([
        {
          block: b,
          stage: "MLFiltered",
          route: "",
          profit: "0",
          gasUsed: "0",
          success: "false",
        },
      ]);
      console.log(`Block ${b}: MLFiltered`);
      continue;
    }

    // 6) Simulate each top route and track best profit
    let bestProfit = ethers.constants.MinInt256;
    let bestGas = ethers.BigNumber.from(0);
    let bestRoute = null;

    for (const sd of topRoutes) {
      const params = ethers.utils.defaultAbiCoder.encode(["SwapData"], [sd]);
      try {
        const premium = borrowAmt
          .mul(parseInt(process.env.FLASHLOAN_PREMIUM_BIPS, 10))
          .div(10000);

        // Attempt to estimate gas; if baseFee is too high, catch and leave gasEst = 0
        let gasEst = ethers.BigNumber.from(0);
        try {
          gasEst = await arbitrage.estimateGas.executeOperation(
            [sd.token],
            [borrowAmt],
            [premium],
            arbitrage.address,
            params,
            {
              maxFeePerGas: ethers.utils.parseUnits("1000", "gwei"),
              maxPriorityFeePerGas: ethers.utils.parseUnits("2", "gwei"),
            }
          );
        } catch {
          gasEst = ethers.BigNumber.from(0);
        }

        // Call static for PnL
        const pnl = await arbitrage.callStatic.executeOperation(
          [sd.token],
          [borrowAmt],
          [premium],
          arbitrage.address,
          params
        );

        if (pnl.gt(bestProfit)) {
          bestProfit = pnl;
          bestGas = gasEst;
          bestRoute = sd.route;
        }
      } catch {
        // If callStatic or anything else fails, skip this route
        continue;
      }
    }

    if (!bestRoute) {
      await csvWriter.writeRecords([
        {
          block: b,
          stage: "NoProfitableRoute",
          route: "",
          profit: "0",
          gasUsed: "0",
          success: "false",
        },
      ]);
      console.log(`Block ${b}: NoProfitableRoute`);
      continue;
    }

    // 7) Write out success result
    await csvWriter.writeRecords([
      {
        block: b,
        stage: "Success",
        route: bestRoute,
        profit: bestProfit.toString(),
        gasUsed: bestGas.toString(),
        success: "true",
      },
    ]);
    console.log(`Block ${b}: Profit=${bestProfit.toString()}`);
  }

  console.log("Backtesting complete. See backtest_results.csv");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
