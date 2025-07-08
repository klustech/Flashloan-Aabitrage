const fs = require("fs");
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
  override: true,
});

const inputFile =
  process.env.OFFLINE_POOLS_FILE ||
  path.join("docs", "offline_pools_sample.json");
const outputFile = path.join(__dirname, "../ml/ml_training_data.csv");

// Basic token lists for feature engineering
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase();
const STABLES = [
  "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
  "0xA0b86991C6218b36c1d19D4a2e9Eb0cE3606EB48", // USDC
  "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
].map((a) => a.toLowerCase());

function computeStats(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
  const variance =
    arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (arr.length || 1);
  const stdev = Math.sqrt(variance) || 1;
  return { mean, stdev };
}

function main() {
  if (!fs.existsSync(inputFile)) {
    throw new Error(`Pools file not found: ${inputFile}`);
  }
  const data = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  const pools = data.ethereum || [];
  const liquidities = pools.map((p) => Number(p.reserveUSD || 0));
  const { mean, stdev } = computeStats(liquidities);
  const lines = pools.map((p) => {
    const liq = Number(p.reserveUSD || 0);
    const z = ((liq - mean) / stdev).toFixed(3);
    const profit = (liq * 0.001).toFixed(2);
    const profitable = Number(profit) > 0 ? 1 : 0;
    const fee = Number(p.fee || 0);
    const token0 = (p.token0 || "").toLowerCase();
    const token1 = (p.token1 || "").toLowerCase();
    const hasWeth = token0 === WETH || token1 === WETH ? 1 : 0;
    const hasStable =
      STABLES.includes(token0) || STABLES.includes(token1) ? 1 : 0;
    const dexFlag = p.dex && p.dex.toLowerCase().includes("uniswap") ? 1 : 0;
    return `2,${liq},${z},${profit},${profitable},${fee},${hasWeth},${hasStable},${dexFlag}`;
  });
  const header =
    "route_length,liquidity_usd,z_score,profit_usd,is_profitable,fee_bips,has_weth,has_stable,dex_uniswap\n";
  fs.writeFileSync(outputFile, header + lines.join("\n"));
  console.log(`Dataset written to ${outputFile}`);
}

main();
