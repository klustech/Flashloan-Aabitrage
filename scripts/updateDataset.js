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
    return `2,${liq},${z},${profit},${profitable}`;
  });
  const header =
    "route_length,liquidity_usd,z_score,profit_usd,is_profitable\n";
  fs.writeFileSync(outputFile, header + lines.join("\n"));
  console.log(`Dataset written to ${outputFile}`);
}

main();
