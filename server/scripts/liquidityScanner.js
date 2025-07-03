require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
});
const redis = require("../utils/redisClient");
const axios = require("axios");
const fs = require("fs");

// ────────────────────────────────────────────────────────────────────────────────
// DEFAULTS (override via .env)
// ────────────────────────────────────────────────────────────────────────────────
const envTopN = process.env.DYNAMIC_ROUTE_TOPN;
const DEFAULT_TOP_N = envTopN !== undefined ? parseInt(envTopN, 10) : 20;

const envMinLiq = process.env.DYNAMIC_ROUTE_MIN_LIQUIDITY_USD;
const DEFAULT_MIN_LIQUIDITY_USD =
  envMinLiq !== undefined ? parseInt(envMinLiq, 10) : 100000;

// The Graph Gateway API key (for Uniswap V2 & SushiSwap V2)
const THEGRAPH_API_KEY = process.env.THEGRAPH_API_KEY;
const {
  UNISWAP_ARBITRUM_SUBGRAPH_ID,
  SUSHISWAP_ARBITRUM_SUBGRAPH_ID,
  UNISWAP_OPTIMISM_SUBGRAPH_ID,
  SUSHISWAP_OPTIMISM_SUBGRAPH_ID,
  UNISWAP_V3_SUBGRAPH_ID,
  BALANCER_V2_SUBGRAPH_ID,
  CURVE_V2_SUBGRAPH_ID,
  UNISWAP_V3_ARBITRUM_SUBGRAPH_ID,
  BALANCER_ARBITRUM_SUBGRAPH_ID,
  UNISWAP_V3_OPTIMISM_SUBGRAPH_ID,
  BALANCER_OPTIMISM_SUBGRAPH_ID,
  CURVE_OPTIMISM_SUBGRAPH_ID,
} = process.env;
if (!THEGRAPH_API_KEY) {
  console.warn(
    "Warning: THEGRAPH_API_KEY is not set. Using public subgraph URLs."
  );
}

// Optional offline mode for restricted environments
const OFFLINE_POOLS_FILE = process.env.OFFLINE_POOLS_FILE;
let OFFLINE_POOLS = null;
if (OFFLINE_POOLS_FILE && fs.existsSync(OFFLINE_POOLS_FILE)) {
  try {
    OFFLINE_POOLS = JSON.parse(fs.readFileSync(OFFLINE_POOLS_FILE, "utf8"));
    console.warn(`Using offline pools from ${OFFLINE_POOLS_FILE}`);
  } catch (err) {
    console.error(`Failed to load offline pools: ${err.message}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// CHAIN‐SPECIFIC SUBGRAPH URLS & CONFIGURATION
// ────────────────────────────────────────────────────────────────────────────────
const CHAIN_CONFIGS = {
  ethereum: {
    uniswapV3: {
      subgraphUrl: UNISWAP_V3_SUBGRAPH_ID
        ? `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${UNISWAP_V3_SUBGRAPH_ID}`
        : THEGRAPH_API_KEY
        ? `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/name/uniswap/uniswap-v3`
        : "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3",
      fallbackUrl: "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3",
    },
    balancerV2: {
      subgraphUrl: BALANCER_V2_SUBGRAPH_ID
        ? `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${BALANCER_V2_SUBGRAPH_ID}`
        : THEGRAPH_API_KEY
        ? `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/name/balancer-labs/balancer-v2`
        : "https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-v2",
      fallbackUrl:
        "https://api.thegraph.com/subgraphs/name/balancer-labs/balancer-v2",
    },
    curveV2: CURVE_V2_SUBGRAPH_ID
      ? {
          subgraphUrl: `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${CURVE_V2_SUBGRAPH_ID}`,
          fallbackUrl: null,
        }
      : undefined,
  },
  arbitrum: {
    uniswapV3: {
      subgraphUrl: UNISWAP_V3_ARBITRUM_SUBGRAPH_ID
        ? `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${UNISWAP_V3_ARBITRUM_SUBGRAPH_ID}`
        : THEGRAPH_API_KEY
        ? `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/name/uniswap/uniswap-v3-arbitrum`
        : "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3-arbitrum",
      fallbackUrl:
        "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3-arbitrum",
    },
    balancerV2: BALANCER_ARBITRUM_SUBGRAPH_ID
      ? {
          subgraphUrl: `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${BALANCER_ARBITRUM_SUBGRAPH_ID}`,
          fallbackUrl: null,
        }
      : undefined,
  },
  optimism: {
    uniswapV3: {
      subgraphUrl: UNISWAP_V3_OPTIMISM_SUBGRAPH_ID
        ? `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${UNISWAP_V3_OPTIMISM_SUBGRAPH_ID}`
        : THEGRAPH_API_KEY
        ? `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/name/uniswap/uniswap-v3-optimism`
        : "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3-optimism",
      fallbackUrl:
        "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3-optimism",
    },
    balancerV2: BALANCER_OPTIMISM_SUBGRAPH_ID
      ? {
          subgraphUrl: `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${BALANCER_OPTIMISM_SUBGRAPH_ID}`,
          fallbackUrl: null,
        }
      : undefined,
    curveV2: CURVE_OPTIMISM_SUBGRAPH_ID
      ? {
          subgraphUrl: `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${CURVE_OPTIMISM_SUBGRAPH_ID}`,
          fallbackUrl: null,
        }
      : undefined,
  },
};
// ────────────────────────────────────────────────────────────────────────────────
// Introspection helpers to adapt to varying subgraph schemas
// ────────────────────────────────────────────────────────────────────────────────
const SCHEMA_FIELD_CACHE = {};

async function getQueryFields(url) {
  if (SCHEMA_FIELD_CACHE[url]) return SCHEMA_FIELD_CACHE[url];
  const introspectionQuery = `{\n    __type(name: "Query") { fields { name } }\n  }`;
  const data = await graphqlRequest(url, introspectionQuery);
  const fields =
    data &&
    data.data &&
    data.data.__type &&
    Array.isArray(data.data.__type.fields)
      ? data.data.__type.fields.map((f) => f.name)
      : [];
  SCHEMA_FIELD_CACHE[url] = fields;
  return fields;
}

async function hasField(url, field) {
  const fields = await getQueryFields(url);
  return fields.includes(field);
}

// ────────────────────────────────────────────────────────────────────────────────
// UTILITY: Perform a GraphQL POST to the given URL with retries.
// ────────────────────────────────────────────────────────────────────────────────
async function graphqlRequest(url, query, variables = {}, fallbackUrl) {
  try {
    const resp = await axios.post(
      url,
      { query, variables },
      { headers: { "Content-Type": "application/json" }, timeout: 30000 }
    );
    if (resp.data && resp.data.errors) {
      console.error(
        `Graph error at ${url}:`,
        JSON.stringify(resp.data.errors, null, 2)
      );
      if (fallbackUrl && fallbackUrl !== url) {
        console.warn(`Retrying GraphQL request using fallback ${fallbackUrl}`);
        const fallback = await axios.post(
          fallbackUrl,
          { query, variables },
          { headers: { "Content-Type": "application/json" }, timeout: 30000 }
        );
        return fallback.data;
      }
    }
    return resp.data;
  } catch (err) {
    if (err.response && err.response.data) {
      console.error(
        `Error fetching from ${url}:`,
        JSON.stringify(err.response.data, null, 2)
      );
    } else {
      console.error(`Error fetching from ${url}:`, err.message);
    }
    if (fallbackUrl && fallbackUrl !== url) {
      console.warn(`Retrying GraphQL request using fallback ${fallbackUrl}`);
      try {
        const resp = await axios.post(
          fallbackUrl,
          { query, variables },
          { headers: { "Content-Type": "application/json" }, timeout: 30000 }
        );
        return resp.data;
      } catch (err2) {
        if (err2.response && err2.response.data) {
          console.error(
            `Error fetching from ${fallbackUrl}:`,
            JSON.stringify(err2.response.data, null, 2)
          );
        } else {
          console.error(`Error fetching from ${fallbackUrl}:`, err2.message);
        }
      }
    }
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// 3) Uniswap V3: fetch top N pools by liquidity
// ────────────────────────────────────────────────────────────────────────────────
async function fetchUniswapV3TopPools(chainConfig, topN = DEFAULT_TOP_N) {
  if (!chainConfig.uniswapV3 || !chainConfig.uniswapV3.subgraphUrl) return [];
  const url = chainConfig.uniswapV3.subgraphUrl;
  const hasPools = await hasField(url, "pools");
  const hasLiquidityPools = await hasField(url, "liquidityPools");
  let data;
  let pools;

  if (hasPools) {
    const query = `
      {
        pools(first: ${topN}, orderBy: totalValueLockedUSD, orderDirection: desc) {
          id
          token0 { id symbol }
          token1 { id symbol }
          feeTier
          totalValueLockedUSD
        }
      }
    `;
    data = await graphqlRequest(url, query);
    pools = data && data.data && data.data.pools;
  }

  if (!Array.isArray(pools) && hasLiquidityPools) {
    const query = `
      {
        liquidityPools(first: ${topN}, orderBy: totalValueLockedUSD, orderDirection: desc) {
          id
          inputTokens { id symbol }
          fees { feePercentage }
          totalValueLockedUSD
        }
      }
    `;
    data = await graphqlRequest(url, query);
    pools = data && data.data && data.data.liquidityPools;
    if (Array.isArray(pools)) {
      pools = pools.map((p) => ({
        id: p.id,
        token0: { id: p.inputTokens[0].id, symbol: p.inputTokens[0].symbol },
        token1: { id: p.inputTokens[1].id, symbol: p.inputTokens[1].symbol },
        feeTier: p.fees && p.fees[0] ? p.fees[0].feePercentage : "0",
        liquidity: p.totalValueLockedUSD,
      }));
    }
  }

  if (!Array.isArray(pools)) {
    const legacyQuery = `
      {
        pools(first: ${topN}, orderBy: liquidity, orderDirection: desc) {
          id
          token0 { id symbol }
          token1 { id symbol }
          feeTier
          liquidity
        }
      }
    `;
    data = await graphqlRequest(url, legacyQuery);
    pools = data && data.data && data.data.pools;
  }

  if (!Array.isArray(pools)) {
    console.warn(
      `UniswapV3 query returned no pools for ${url}. Check the response.`
    );
    return [];
  }

  return pools.map((p) => ({
    poolAddress: p.id,
    token0: p.token0.id,
    token1: p.token1.id,
    fee:
      parseFloat(p.feeTier) < 1
        ? Math.round(parseFloat(p.feeTier) * 10000)
        : Math.round(parseFloat(p.feeTier)),
    liquidity: p.totalValueLockedUSD || p.liquidity || "0",
    dex: "UniswapV3",
  }));
}

// ────────────────────────────────────────────────────────────────────────────────
// 4) Balancer V2: fetch top N pools by totalLiquidity
// ────────────────────────────────────────────────────────────────────────────────
async function fetchBalancerV2TopPools(chainConfig, topN = DEFAULT_TOP_N) {
  if (!chainConfig.balancerV2 || !chainConfig.balancerV2.subgraphUrl) return [];
  const url = chainConfig.balancerV2.subgraphUrl;
  const hasPools = await hasField(url, "pools");
  const hasLiquidityPools = await hasField(url, "liquidityPools");
  let data;
  let pools;

  if (hasPools) {
    const query = `
      {
        pools(first: ${topN}, orderBy: totalLiquidity, orderDirection: desc) {
          id
          tokens { address }
          totalLiquidity
        }
      }
    `;
    data = await graphqlRequest(url, query);
    pools = data && data.data && data.data.pools;
  }

  if (!Array.isArray(pools) && hasLiquidityPools) {
    const query = `
      {
        liquidityPools(first: ${topN}, orderBy: totalLiquidityUSD, orderDirection: desc) {
          id
          inputTokens { id }
          totalLiquidityUSD
        }
      }
    `;
    data = await graphqlRequest(url, query);
    pools = data && data.data && data.data.liquidityPools;
    if (Array.isArray(pools)) {
      pools = pools.map((p) => ({
        id: p.id,
        tokens: p.inputTokens.map((t) => ({ address: t.id })),
        totalLiquidity: p.totalLiquidityUSD,
      }));
    }
  }

  if (!Array.isArray(pools)) {
    console.warn(
      `BalancerV2 query returned no pools for ${url}. Check the response.`
    );
    return [];
  }

  return pools.map((p) => ({
    poolAddress: p.id,
    tokens: p.tokens.map((t) => t.address),
    totalLiquidityUSD: parseFloat(p.totalLiquidity),
    dex: "BalancerV2",
  }));
}

// ────────────────────────────────────────────────────────────────────────────────
// 5) Curve V2: fetch top N pools by totalLiquidityUSD
// ────────────────────────────────────────────────────────────────────────────────
async function fetchCurveV2TopPools(chainConfig, topN = DEFAULT_TOP_N) {
  if (!chainConfig.curveV2 || !chainConfig.curveV2.subgraphUrl) return [];
  const url = chainConfig.curveV2.subgraphUrl;
  const hasPools = await hasField(url, "pools");
  const hasLiquidityPools = await hasField(url, "liquidityPools");
  let data;
  let pools;

  if (hasPools) {
    const query = `
      {
        pools(first: ${topN}, orderBy: totalLiquidityUSD, orderDirection: desc) {
          id
          coins { id symbol }
          totalLiquidityUSD
        }
      }
    `;
    data = await graphqlRequest(url, query);
    pools = data && data.data && data.data.pools;
  }

  if (!Array.isArray(pools) && hasLiquidityPools) {
    const query = `
      {
        liquidityPools(first: ${topN}, orderBy: totalValueLockedUSD, orderDirection: desc) {
          id
          inputTokens { id }
          totalValueLockedUSD
        }
      }
    `;
    data = await graphqlRequest(url, query);
    pools = data && data.data && data.data.liquidityPools;
    if (Array.isArray(pools)) {
      pools = pools.map((p) => ({
        id: p.id,
        tokens: p.inputTokens.map((t) => ({ id: t.id })),
        totalLiquidityUSD: p.totalValueLockedUSD,
      }));
    }
  }

  if (!Array.isArray(pools)) {
    console.warn(
      `CurveV2 query returned no pools for ${url}. Check the response.`
    );
    return [];
  }

  return pools.map((p) => ({
    poolAddress: p.id,
    tokens: (p.tokens || p.coins || []).map((t) => t.id || t),
    totalLiquidityUSD: parseFloat(p.totalLiquidityUSD),
    dex: "CurveV2",
  }));
}

// ────────────────────────────────────────────────────────────────────────────────
// CACHE KEY for adjacency graph in Redis
// ────────────────────────────────────────────────────────────────────────────────
const CACHE_KEY_PREFIX = "adjacency_graph";

// ────────────────────────────────────────────────────────────────────────────────
// Build adjacency graph once per interval and cache in Redis for 300s
// ────────────────────────────────────────────────────────────────────────────────
async function buildAdjacencyGraph(
  chain = "ethereum",
  topN = DEFAULT_TOP_N,
  minLiquidityUSD = DEFAULT_MIN_LIQUIDITY_USD
) {
  if (OFFLINE_POOLS && OFFLINE_POOLS[chain]) {
    // Build adjacency directly from offline data, skipping network calls
    const offlineData = OFFLINE_POOLS[chain];
    const adj = {};
    offlineData.forEach((p) => {
      if (!adj[p.token0]) adj[p.token0] = [];
      if (!adj[p.token1]) adj[p.token1] = [];
      adj[p.token0].push({
        token: p.token1,
        pool: p.pairAddress,
        dex: p.dex,
        fee: p.fee,
        reserveUSD: p.reserveUSD,
      });
      adj[p.token1].push({
        token: p.token0,
        pool: p.pairAddress,
        dex: p.dex,
        fee: p.fee,
        reserveUSD: p.reserveUSD,
      });
    });
    return adj;
  }

  const cacheKey = `${CACHE_KEY_PREFIX}_${chain}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }
  const chainConfig = CHAIN_CONFIGS[chain];
  if (!chainConfig) {
    throw new Error(`Unsupported chain: ${chain}`);
  }
  let merged = [];

  // Include V3 pools if enabled
  if (process.env.INCLUDE_V3 === "true") {
    const v3Pools = await fetchUniswapV3TopPools(chainConfig, topN);
    merged = merged.concat(v3Pools);
  }

  // Include Balancer V2 if enabled
  if (process.env.INCLUDE_BALANCER === "true") {
    const balancerPools = await fetchBalancerV2TopPools(chainConfig, topN);
    merged = merged.concat(balancerPools);
  }

  // Include Curve V2 if enabled
  if (process.env.INCLUDE_CURVE === "true") {
    const curvePools = await fetchCurveV2TopPools(chainConfig, topN);
    merged = merged.concat(curvePools);
  }

  // Build adjacency map: tokenA -> [{ token, pool, dex, fee, reserveUSD }, ...]
  const adjacencyGraph = {};

  merged.forEach((p) => {
    if (p.token0 && p.token1) {
      // For Uniswap V3 entries
      const reserveUSD = p.dex === "UniswapV3" ? parseFloat(p.liquidity) : 0;
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
  await redis.set(cacheKey, JSON.stringify(adjacencyGraph), "EX", 300);
  if (Object.keys(adjacencyGraph).length === 0) {
    console.warn(
      `No pools fetched for ${chain}. Check subgraph IDs and THEGRAPH_API_KEY.`
    );
  }
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
  if (OFFLINE_POOLS && OFFLINE_POOLS[chain]) {
    // Simply return the offline pool data trimmed to topN
    const pools = OFFLINE_POOLS[chain]
      .filter((p) => p.reserveUSD >= minLiquidityUSD)
      .sort((a, b) => b.reserveUSD - a.reserveUSD);
    return pools.slice(0, topN);
  }
  const adjacencyGraph = await buildAdjacencyGraph(
    chain,
    topN,
    minLiquidityUSD
  );
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

module.exports = { getTopLiquidityPairs, CHAIN_CONFIGS };
