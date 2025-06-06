// server/scripts/liquidityScanner.js

/**
 * Query various DEX subgraphs (Uniswap V2, SushiSwap V2, Uniswap V3, Balancer V2, Curve V2)
 * to assemble a unified list of top‐N liquidity pools per chain.
 *
 * Supports:
 *  - Uniswap V2 & SushiSwap V2 (via The Graph Gateway; requires THEGRAPH_API_KEY)
 *  - Uniswap V3 (via Uniswap V3 subgraph)
 *  - Balancer V2 (via Balancer V2 subgraph)
 *  - Curve V2 (via Curve subgraph)
 *
 * Environment variables:
 *  - THEGRAPH_API_KEY           (for V2 gateway URLs)
 *  - DYNAMIC_ROUTE_TOPN         (default number of pools to fetch per DEX)
 *  - DYNAMIC_ROUTE_MIN_LIQUIDITY_USD (minimum reserveUSD filter for V2)
 *  - INCLUDE_V3=true/false
 *  - INCLUDE_BALANCER=true/false
 *  - INCLUDE_CURVE=true/false
 *
 * Chain‐specific subgraphs must be configured in `CHAIN_CONFIGS`.
 * The function `getTopLiquidityPairs(chain)` returns an array of pool objects:
 *   {
 *     pairAddress, token0, token1, reserve0, reserve1, reserveUSD, dex, [fee], [poolAddress], [tokens]
 *   }
 *
 * For V3 entries: { poolAddress, token0, token1, fee, liquidity, dex: "UniswapV3" }
 * For Balancer entries: { poolAddress, tokens: [...], dex: "BalancerV2", totalLiquidityUSD }
 * For Curve entries: { poolAddress, tokens: [...], dex: "CurveV2", totalLiquidityUSD }
 */

const axios = require("axios");
const redis = require("../utils/redisClient");
require("dotenv").config();

// ────────────────────────────────────────────────────────────────────────────────
// DEFAULTS (override via .env)
// ────────────────────────────────────────────────────────────────────────────────
const DEFAULT_TOP_N = parseInt(process.env.DYNAMIC_ROUTE_TOPN, 10) || 20;
const DEFAULT_MIN_LIQUIDITY_USD =
  parseInt(process.env.DYNAMIC_ROUTE_MIN_LIQUIDITY_USD, 10) || 100000;

// The Graph Gateway API key (for Uniswap V2 & SushiSwap V2)
const THEGRAPH_API_KEY = process.env.THEGRAPH_API_KEY;
if (!THEGRAPH_API_KEY) {
  console.error(
    "Error: THEGRAPH_API_KEY is not set. " +
      "Please add THEGRAPH_API_KEY=<your_key> to your .env."
  );
  // process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────────────
// CHAIN‐SPECIFIC SUBGRAPH URLS & CONFIGURATION
// ────────────────────────────────────────────────────────────────────────────────
const CHAIN_CONFIGS = {
  ethereum: {
    uniswapV2: {
      subgraphId: "EYCKATKGBKLWvSfwvBjzfCBmGwYNdVkduYXVivCsLRFu", // Uniswap V2 Mainnet
      gatewayUrl: `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/EYCKATKGBKLWvSfwvBjzfCBmGwYNdVkduYXVivCsLRFu`,
    },
    sushiV2: {
      subgraphId: "A4JrrMwrEXsYNAiYw7rWwbHhQZdj6YZg1uVy5wa6g821", // SushiSwap V2 Mainnet
      gatewayUrl: `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/A4JrrMwrEXsYNAiYw7rWwbHhQZdj6YZg1uVy5wa6g821`,
    },
    uniswapV3: {
      subgraphUrl: "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3",
    },
    balancerV2: {
      subgraphUrl:
        "https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-v2",
    },
    curveV2: {
      subgraphUrl: "https://api.thegraph.com/subgraphs/name/curvefi/curve",
    },
  },
  // Add other chains (arbitrum, optimism) here if needed:
  // arbitrum: { ... }, optimism: { ... }
};

// ────────────────────────────────────────────────────────────────────────────────
// HELPER: Build Gateway URL for a given subgraph ID (for V2 gateways).
// ────────────────────────────────────────────────────────────────────────────────
function gatewayUrlFor(subgraphId) {
  return `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${subgraphId}`;
}

// ────────────────────────────────────────────────────────────────────────────────
// UTILITY: Perform a GraphQL POST to the given URL with retries.
// ────────────────────────────────────────────────────────────────────────────────
async function graphqlRequest(url, query, variables = {}) {
  try {
    const resp = await axios.post(
      url,
      { query, variables },
      { headers: { "Content-Type": "application/json" }, timeout: 30000 }
    );
    return resp.data;
  } catch (err) {
    if (err.response && err.response.data) {
      console.error(
        `Graph error at ${url}:`,
        JSON.stringify(err.response.data, null, 2)
      );
    } else {
      console.error(`Error fetching from ${url}:`, err.message);
    }
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// 1) Uniswap V2: fetch top N pairs by reserveUSD
// ────────────────────────────────────────────────────────────────────────────────
async function fetchUniswapV2TopPairs(
  chainConfig,
  topN = DEFAULT_TOP_N,
  minLiquidityUSD = DEFAULT_MIN_LIQUIDITY_USD
) {
  const { gatewayUrl } = chainConfig.uniswapV2;
  const query = `
    {
      pairs(
        first: ${topN}
        orderBy: reserveUSD
        orderDirection: desc
        where: { reserveUSD_gt: ${minLiquidityUSD} }
      ) {
        id
        token0 { id symbol }
        token1 { id symbol }
        reserve0
        reserve1
        reserveUSD
      }
    }
  `;
  const data = await graphqlRequest(gatewayUrl, query);
  if (!data || !data.data || !Array.isArray(data.data.pairs)) {
    return [];
  }
  return data.data.pairs.map((p) => ({
    pairAddress: p.id,
    token0: p.token0.id,
    token1: p.token1.id,
    reserve0: p.reserve0, // string
    reserve1: p.reserve1, // string
    reserveUSD: parseFloat(p.reserveUSD), // Number
    dex: "UniswapV2",
  }));
}

// ────────────────────────────────────────────────────────────────────────────────
// 2) SushiSwap V2: fetch top N pairs by reserveUSD
// ────────────────────────────────────────────────────────────────────────────────
async function fetchSushiV2TopPairs(
  chainConfig,
  topN = DEFAULT_TOP_N,
  minLiquidityUSD = DEFAULT_MIN_LIQUIDITY_USD
) {
  const { gatewayUrl } = chainConfig.sushiV2;
  const query = `
    {
      pairs(
        first: ${topN}
        orderBy: reserveUSD
        orderDirection: desc
        where: { reserveUSD_gt: ${minLiquidityUSD} }
      ) {
        id
        token0 { id symbol }
        token1 { id symbol }
        reserve0
        reserve1
        reserveUSD
      }
    }
  `;
  const data = await graphqlRequest(gatewayUrl, query);
  if (!data || !data.data || !Array.isArray(data.data.pairs)) {
    return [];
  }
  return data.data.pairs.map((p) => ({
    pairAddress: p.id,
    token0: p.token0.id,
    token1: p.token1.id,
    reserve0: p.reserve0, // string
    reserve1: p.reserve1, // string
    reserveUSD: parseFloat(p.reserveUSD), // Number
    dex: "SushiSwapV2",
  }));
}

// ────────────────────────────────────────────────────────────────────────────────
// 3) Uniswap V3: fetch top N pools by liquidity
// ────────────────────────────────────────────────────────────────────────────────
async function fetchUniswapV3TopPools(chainConfig, topN = DEFAULT_TOP_N) {
  if (!chainConfig.uniswapV3 || !chainConfig.uniswapV3.subgraphUrl) return [];
  const url = chainConfig.uniswapV3.subgraphUrl;
  const query = `
    {
      pools(
        first: ${topN}
        orderBy: liquidity
        orderDirection: desc
      ) {
        id
        token0 { id symbol }
        token1 { id symbol }
        feeTier
        liquidity
      }
    }
  `;
  const data = await graphqlRequest(url, query);
  if (!data || !data.data || !Array.isArray(data.data.pools)) {
    return [];
  }
  return data.data.pools.map((p) => ({
    poolAddress: p.id,
    token0: p.token0.id,
    token1: p.token1.id,
    fee: parseInt(p.feeTier, 10), // e.g., 500, 3000, 10000
    liquidity: p.liquidity, // string (liquidity)
    dex: "UniswapV3",
  }));
}

// ────────────────────────────────────────────────────────────────────────────────
// 4) Balancer V2: fetch top N pools by totalLiquidity
// ────────────────────────────────────────────────────────────────────────────────
async function fetchBalancerV2TopPools(chainConfig, topN = DEFAULT_TOP_N) {
  if (!chainConfig.balancerV2 || !chainConfig.balancerV2.subgraphUrl) return [];
  const url = chainConfig.balancerV2.subgraphUrl;
  const query = `
    {
      pools(first: ${topN}, orderBy: totalLiquidity, orderDirection: desc) {
        id
        tokens { address }
        totalLiquidity
      }
    }
  `;
  const data = await graphqlRequest(url, query);
  if (!data || !data.data || !Array.isArray(data.data.pools)) {
    return [];
  }
  return data.data.pools.map((p) => ({
    poolAddress: p.id,
    tokens: p.tokens.map((t) => t.address),
    totalLiquidityUSD: parseFloat(p.totalLiquidity), // approximate USD value
    dex: "BalancerV2",
  }));
}

// ────────────────────────────────────────────────────────────────────────────────
// 5) Curve V2: fetch top N pools by totalLiquidityUSD
// ────────────────────────────────────────────────────────────────────────────────
async function fetchCurveV2TopPools(chainConfig, topN = DEFAULT_TOP_N) {
  if (!chainConfig.curveV2 || !chainConfig.curveV2.subgraphUrl) return [];
  const url = chainConfig.curveV2.subgraphUrl;
  const query = `
    {
      pools(first: ${topN}, orderBy: totalLiquidityUSD, orderDirection: desc) {
        id
        tokens { id }
        totalLiquidityUSD
      }
    }
  `;
  const data = await graphqlRequest(url, query);
  if (!data || !data.data || !Array.isArray(data.data.pools)) {
    return [];
  }
  return data.data.pools.map((p) => ({
    poolAddress: p.id,
    tokens: p.tokens.map((t) => t.id),
    totalLiquidityUSD: parseFloat(p.totalLiquidityUSD),
    dex: "CurveV2",
  }));
}

// ────────────────────────────────────────────────────────────────────────────────
// CACHE KEY for adjacency graph in Redis
// ────────────────────────────────────────────────────────────────────────────────
const CACHE_KEY = "adjacency_graph";

// ────────────────────────────────────────────────────────────────────────────────
// Build adjacency graph once per interval and cache in Redis for 300s
// ────────────────────────────────────────────────────────────────────────────────
async function buildAdjacencyGraph() {
  const cached = await redis.get(CACHE_KEY);
  if (cached) {
    return JSON.parse(cached);
  }

  const chainConfig = CHAIN_CONFIGS["ethereum"];
  // Fetch V2 pairs
  const [uniV2, sushiV2] = await Promise.all([
    fetchUniswapV2TopPairs(
      chainConfig,
      DEFAULT_TOP_N,
      DEFAULT_MIN_LIQUIDITY_USD
    ),
    fetchSushiV2TopPairs(chainConfig, DEFAULT_TOP_N, DEFAULT_MIN_LIQUIDITY_USD),
  ]);

  let merged = [...uniV2, ...sushiV2];

  // Include V3 pools if enabled
  if (process.env.INCLUDE_V3 === "true") {
    const v3Pools = await fetchUniswapV3TopPools(chainConfig, DEFAULT_TOP_N);
    merged = merged.concat(v3Pools);
  }

  // Include Balancer V2 if enabled
  if (process.env.INCLUDE_BALANCER === "true") {
    const balancerPools = await fetchBalancerV2TopPools(
      chainConfig,
      DEFAULT_TOP_N
    );
    merged = merged.concat(balancerPools);
  }

  // Include Curve V2 if enabled
  if (process.env.INCLUDE_CURVE === "true") {
    const curvePools = await fetchCurveV2TopPools(chainConfig, DEFAULT_TOP_N);
    merged = merged.concat(curvePools);
  }

  // Build adjacency map: tokenA -> [{ token, pool, dex, fee, reserveUSD }, ...]
  const adjacencyGraph = {};

  merged.forEach((p) => {
    if (p.token0 && p.token1) {
      // For Uniswap V2 / Sushi V2 / Uniswap V3 entries
      const reserveUSD =
        p.dex === "UniswapV2" || p.dex === "SushiSwapV2"
          ? p.reserveUSD
          : p.dex === "UniswapV3"
          ? parseFloat(p.liquidity)
          : 0;
      if (!adjacencyGraph[p.token0]) adjacencyGraph[p.token0] = [];
      if (!adjacencyGraph[p.token1]) adjacencyGraph[p.token1] = [];
      adjacencyGraph[p.token0].push({
        token: p.token1,
        pool: p.pairAddress || p.poolAddress,
        dex: p.dex,
        fee: p.fee || 0,
        reserveUSD,
      });
      adjacencyGraph[p.token1].push({
        token: p.token0,
        pool: p.pairAddress || p.poolAddress,
        dex: p.dex,
        fee: p.fee || 0,
        reserveUSD,
      });
    } else if (p.tokens && p.tokens.length >= 2) {
      // For BalancerV2 / CurveV2 entries
      const [t0, t1] = p.tokens;
      const totalLiquidityUSD = p.totalLiquidityUSD || 0;
      if (!adjacencyGraph[t0]) adjacencyGraph[t0] = [];
      if (!adjacencyGraph[t1]) adjacencyGraph[t1] = [];
      adjacencyGraph[t0].push({
        token: t1,
        pool: p.poolAddress,
        dex: p.dex,
        fee: 0,
        reserveUSD: totalLiquidityUSD,
      });
      adjacencyGraph[t1].push({
        token: t0,
        pool: p.poolAddress,
        dex: p.dex,
        fee: 0,
        reserveUSD: totalLiquidityUSD,
      });
    }
  });

  // Cache for 300 seconds
  await redis.set(CACHE_KEY, JSON.stringify(adjacencyGraph), "EX", 300);
  return adjacencyGraph;
}

// ────────────────────────────────────────────────────────────────────────────────
// MAIN: getTopLiquidityPairs(chain, options)
//   - chain: string key in CHAIN_CONFIGS (e.g., "ethereum")
//   - options: { topN, minLiquidityUSD }
// Returns a unified array of pool objects from enabled DEXs, sorted by liquidity USD.
// Each object: { pairAddress, token0, token1, reserveUSD, dex, fee }
// ────────────────────────────────────────────────────────────────────────────────
async function getTopLiquidityPairs(
  chain = "ethereum",
  { topN = DEFAULT_TOP_N, minLiquidityUSD = DEFAULT_MIN_LIQUIDITY_USD } = {}
) {
  const adjacencyGraph = await buildAdjacencyGraph();
  const entries = [];

  // Flatten adjacency entries into array of unique pools
  Object.keys(adjacencyGraph).forEach((tokenA) => {
    adjacencyGraph[tokenA].forEach((edge) => {
      entries.push({
        token0: tokenA,
        token1: edge.token,
        pairAddress: edge.pool,
        dex: edge.dex,
        fee: edge.fee,
        reserveUSD: edge.reserveUSD,
      });
    });
  });

  // Deduplicate by pool address
  const seen = new Set();
  const uniqueEntries = [];
  entries.forEach((e) => {
    if (!seen.has(e.pairAddress)) {
      seen.add(e.pairAddress);
      uniqueEntries.push(e);
    }
  });

  // Sort by reserveUSD (descending)
  uniqueEntries.sort((a, b) => b.reserveUSD - a.reserveUSD);

  // Return topN
  return uniqueEntries.slice(0, topN);
}

module.exports = { getTopLiquidityPairs };
