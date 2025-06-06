// scripts/testGraphScan.js

const { getTopLiquidityPairs } = require("../server/scripts/liquidityScanner");

(async () => {
  console.log(
    "Fetching top " +
      process.env.DYNAMIC_ROUTE_TOPN +
      " pools (≥ $" +
      process.env.DYNAMIC_ROUTE_MIN_LIQUIDITY_USD +
      " liquidity) from Uniswap V2 & SushiSwap V2..."
  );
  try {
    // No overrides here—this will use DYNAMIC_ROUTE_TOPN=100 and DYNAMIC_ROUTE_MIN_LIQUIDITY_USD=0 from .env
    const pairs = await getTopLiquidityPairs();
    console.log("Received " + pairs.length + " pools:");
    console.table(
      pairs.map((p) => ({
        dex: p.dex,
        pairAddress: p.pairAddress,
        token0: p.token0,
        token1: p.token1,
        reserveUSD: p.reserveUSD.toFixed(2),
      }))
    );
  } catch (err) {
    console.error("Test encountered an error:", err);
  }
})();
