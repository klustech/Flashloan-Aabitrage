// scripts/fetchPoolData.js
require("dotenv").config({ override: true });
const fs = require("fs");
const axios = require("axios");

const SUBGRAPH_URL =
  process.env.UNISWAP_V3_SUBGRAPH_URL ||
  "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3";

async function fetchPools(first = 100) {
  const query = `{
    pools(first: ${first}, orderBy: totalValueLockedUSD, orderDirection: desc) {
      id
      feeTier
      volumeUSD
      totalValueLockedUSD
      token0 { id }
      token1 { id }
    }
  }`;
  const { data } = await axios.post(
    SUBGRAPH_URL,
    { query },
    { headers: { "Content-Type": "application/json" }, timeout: 20000 }
  );
  if (data.errors) {
    throw new Error(JSON.stringify(data.errors));
  }
  return data.data.pools;
}

async function main() {
  try {
    const pools = await fetchPools(200);
    const outPath = "docs/latest_pools.json";
    fs.writeFileSync(outPath, JSON.stringify(pools, null, 2));
    console.log(`Saved ${pools.length} pools to ${outPath}`);
  } catch (err) {
    console.error("Failed to fetch pool data:", err.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = { fetchPools };
