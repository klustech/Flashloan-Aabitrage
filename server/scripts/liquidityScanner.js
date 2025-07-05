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
  UNISWAP_V2_SUBGRAPH_ID,
  SUSHISWAP_V2_SUBGRAPH_ID,
  UNISWAP_V3_SUBGRAPH_ID,
  BALANCER_V2_SUBGRAPH_ID,
  CURVE_V2_SUBGRAPH_ID,
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
    uniswapV2: {
      subgraphUrl: UNISWAP_V2_SUBGRAPH_ID
        ? `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${UNISWAP_V2_SUBGRAPH_ID}`
        : THEGRAPH_API_KEY
        ? `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/name/uniswap/uniswap-v2`
        : "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2",
      fallbackUrl: "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2",
    },
    sushiswapV2: SUSHISWAP_V2_SUBGRAPH_ID
      ? {
          subgraphUrl: `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${SUSHISWAP_V2_SUBGRAPH_ID}`,
          fallbackUrl: null,
        }
      : {
          subgraphUrl: THEGRAPH_API_KEY
            ? `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/name/sushiswap/exchange`
            : "https://api.thegraph.com/subgraphs/name/sushiswap/exchange",
          fallbackUrl:
            "https://api.thegraph.com/subgraphs/name/sushiswap/exchange",
        },
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

// -----------------------------------------------------------------------------
// Introspection helper for specific type fields
// -----------------------------------------------------------------------------
const TYPE_FIELD_CACHE = {};

async function getTypeFields(url, typeName) {
  const key = `${url}:${typeName}`;
  if (TYPE_FIELD_CACHE[key]) return TYPE_FIELD_CACHE[key];
  const q = `{ __type(name:"${typeName}") { fields { name } } }`;
  const data = await graphqlRequest(url, q);
  const fields =
    data &&
    data.data &&
    data.data.__type &&
    Array.isArray(data.data.__type.fields)
      ? data.data.__type.fields.map((f) => f.name)
      : [];
  TYPE_FIELD_CACHE[key] = fields;
  return fields;
}

async function typeHasField(url, typeName, field) {
  const fields = await getTypeFields(url, typeName);
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
// 1) Uniswap V2 / SushiSwap V2: fetch top N pairs by reserveUSD
// ────────────────────────────────────────────────────────────────────────────────
async function fetchV2TopPairs(chainConfigDex, topN = DEFAULT_TOP_N, dexName) {
  if (!chainConfigDex || !chainConfigDex.subgraphUrl) return [];
  const url = chainConfigDex.subgraphUrl;
  const hasPairs = await hasField(url, "pairs");
  const hasLiquidityPools = await hasField(url, "liquidityPools");
  const rootField = hasPairs
    ? "pairs"
    : hasLiquidityPools
    ? "liquidityPools"
    : null;
  if (!rootField) return [];

  const typeName = rootField === "pairs" ? "Pair" : "LiquidityPool";
  const fields = await getTypeFields(url, typeName);

  let tokenSnippet = "";
  if (fields.includes("token0") && fields.includes("token1")) {
    tokenSnippet = "token0 { id symbol } token1 { id symbol }";
  } else if (fields.includes("inputTokens")) {
    tokenSnippet = "inputTokens { id symbol }";
  } else if (fields.includes("tokens")) {
    tokenSnippet = "tokens { id symbol }";
  } else {
    console.warn(`${dexName}: no token fields found in ${typeName}`);
    return [];
  }

  const liqField = (await typeHasField(url, typeName, "reserveUSD"))
    ? "reserveUSD"
    : null;

  const query = `
    {
      ${rootField}(first: ${topN}, orderBy: ${
    liqField || "id"
  }, orderDirection: desc) {
        id
        ${tokenSnippet}
        ${liqField || ""}
      }
    }
  `;
  const data = await graphqlRequest(url, query, {}, chainConfigDex.fallbackUrl);
  let pairs = data && data.data && data.data[rootField];
  if (!Array.isArray(pairs)) {
    console.warn(`${dexName} query returned no pairs for ${url}.`);
    return [];
  }

  return pairs.map((p) => {
    const tok0 =
      p.token0?.id ||
      p.inputTokens?.[0]?.id ||
      p.tokens?.[0]?.id ||
      p.tokens?.[0];
    const tok1 =
      p.token1?.id ||
      p.inputTokens?.[1]?.id ||
      p.tokens?.[1]?.id ||
      p.tokens?.[1];
    const liq = p.reserveUSD || 0;
    return {
      pairAddress: p.id,
      token0: tok0,
      token1: tok1,
      reserveUSD: parseFloat(liq),
      dex: dexName,
    };
  });
}

const fetchUniswapV2TopPools = (chainConfig, topN) =>
  fetchV2TopPairs(chainConfig.uniswapV2, topN, "uniswap_v2");
const fetchSushiV2TopPools = (chainConfig, topN) =>
  fetchV2TopPairs(chainConfig.sushiswapV2, topN, "sushiswap_v2");

// ────────────────────────────────────────────────────────────────────────────────
// 3) Uniswap V3: fetch top N pools by liquidity
// ────────────────────────────────────────────────────────────────────────────────
async function fetchUniswapV3TopPools(chainConfig, topN = DEFAULT_TOP_N) {
  if (!chainConfig.uniswapV3 || !chainConfig.uniswapV3.subgraphUrl) return [];
  const url = chainConfig.uniswapV3.subgraphUrl;
  const hasPools = await hasField(url, "pools");
  const hasLiquidityPools = await hasField(url, "liquidityPools");
  const rootField = hasPools
    ? "pools"
    : hasLiquidityPools
    ? "liquidityPools"
    : null;
  if (!rootField) return [];

  const typeName = rootField === "pools" ? "Pool" : "LiquidityPool";
  const poolFields = await getTypeFields(url, typeName);

  // determine token fields
  let tokenSnippet = "";
  if (poolFields.includes("token0") && poolFields.includes("token1")) {
    tokenSnippet = "token0 { id symbol } token1 { id symbol }";
  } else if (poolFields.includes("inputTokens")) {
    tokenSnippet = "inputTokens { id symbol }";
  } else if (poolFields.includes("tokens")) {
    tokenSnippet = "tokens { id symbol }";
  } else {
    console.warn(`UniswapV3: no token fields found in ${typeName}`);
    return [];
  }

  // determine fee field
  let feeSnippet = "";
  if (poolFields.includes("feeTier")) feeSnippet = "feeTier";
  else if (poolFields.includes("fees")) feeSnippet = "fees { feePercentage }";

  // determine liquidity field
  let liqField = null;
  if (poolFields.includes("totalValueLockedUSD"))
    liqField = "totalValueLockedUSD";
  else if (poolFields.includes("totalLiquidityUSD"))
    liqField = "totalLiquidityUSD";
  else if (poolFields.includes("totalLiquidity")) liqField = "totalLiquidity";
  else if (poolFields.includes("liquidity")) liqField = "liquidity";

  const query = `
    {
      ${rootField}(first: ${topN}, orderBy: ${
    liqField || "id"
  }, orderDirection: desc) {
        id
        ${tokenSnippet}
        ${feeSnippet}
        ${liqField || ""}
      }
    }
  `;
  const data = await graphqlRequest(url, query);
  let pools = data && data.data && data.data[rootField];
  if (!Array.isArray(pools)) {
    console.warn(
      `UniswapV3 query returned no pools for ${url}. Check the response.`
    );
    return [];
  }

  return pools.map((p) => {
    const tok0 =
      p.token0?.id ||
      p.inputTokens?.[0]?.id ||
      p.tokens?.[0]?.id ||
      p.tokens?.[0];
    const tok1 =
      p.token1?.id ||
      p.inputTokens?.[1]?.id ||
      p.tokens?.[1]?.id ||
      p.tokens?.[1];
    const feeTier =
      p.feeTier || (p.fees && p.fees[0] ? p.fees[0].feePercentage : "0");
    const liq =
      p.totalValueLockedUSD ||
      p.totalLiquidityUSD ||
      p.totalLiquidity ||
      p.liquidity ||
      "0";
    return {
      poolAddress: p.id,
      token0: tok0,
      token1: tok1,
      fee:
        parseFloat(feeTier) < 1
          ? Math.round(parseFloat(feeTier) * 10000)
          : Math.round(parseFloat(feeTier)),
      liquidity: liq,
      dex: "UniswapV3",
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────────
// 4) Balancer V2: fetch top N pools by totalLiquidity
// ────────────────────────────────────────────────────────────────────────────────
async function fetchBalancerV2TopPools(chainConfig, topN = DEFAULT_TOP_N) {
  if (!chainConfig.balancerV2 || !chainConfig.balancerV2.subgraphUrl) return [];
  const url = chainConfig.balancerV2.subgraphUrl;
  const hasPools = await hasField(url, "pools");
  const hasLiquidityPools = await hasField(url, "liquidityPools");
  const rootField = hasPools
    ? "pools"
    : hasLiquidityPools
    ? "liquidityPools"
    : null;
  if (!rootField) return [];

  const typeName = rootField === "pools" ? "Pool" : "LiquidityPool";
  const fields = await getTypeFields(url, typeName);

  let tokenSnippet = "";
  if (fields.includes("tokens")) {
    tokenSnippet = "tokens { address }";
  } else if (fields.includes("inputTokens")) {
    tokenSnippet = "inputTokens { id }";
  } else {
    console.warn(`BalancerV2: no token fields found in ${typeName}`);
    return [];
  }

  let liqField = null;
  if (fields.includes("totalLiquidityUSD")) liqField = "totalLiquidityUSD";
  else if (fields.includes("totalLiquidity")) liqField = "totalLiquidity";
  else if (fields.includes("totalValueLockedUSD"))
    liqField = "totalValueLockedUSD";

  const query = `
    {
      ${rootField}(first: ${topN}, orderBy: ${
    liqField || "id"
  }, orderDirection: desc) {
        id
        ${tokenSnippet}
        ${liqField || ""}
      }
    }
  `;
  const data = await graphqlRequest(url, query);
  let pools = data && data.data && data.data[rootField];
  if (!Array.isArray(pools)) {
    console.warn(
      `BalancerV2 query returned no pools for ${url}. Check the response.`
    );
    return [];
  }

  return pools.map((p) => {
    const toks = p.tokens || p.inputTokens || [];
    const outTokens = toks.map((t) => t.address || t.id || t);
    const liq =
      p.totalLiquidityUSD || p.totalLiquidity || p.totalValueLockedUSD || "0";
    return {
      poolAddress: p.id,
      tokens: outTokens,
      totalLiquidityUSD: parseFloat(liq),
      dex: "BalancerV2",
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────────
// 5) Curve V2: fetch top N pools by totalLiquidityUSD
// ────────────────────────────────────────────────────────────────────────────────
async function fetchCurveV2TopPools(chainConfig, topN = DEFAULT_TOP_N) {
  if (!chainConfig.curveV2 || !chainConfig.curveV2.subgraphUrl) return [];
  const url = chainConfig.curveV2.subgraphUrl;
  const hasPools = await hasField(url, "pools");
  const hasLiquidityPools = await hasField(url, "liquidityPools");
  const rootField = hasPools
    ? "pools"
    : hasLiquidityPools
    ? "liquidityPools"
    : null;
  if (!rootField) return [];

  const typeName = rootField === "pools" ? "Pool" : "LiquidityPool";
  const fields = await getTypeFields(url, typeName);

  let tokenSnippet = "";
  if (fields.includes("coins")) tokenSnippet = "coins { id symbol }";
  else if (fields.includes("tokens")) tokenSnippet = "tokens { id }";
  else if (fields.includes("inputTokens")) tokenSnippet = "inputTokens { id }";
  else {
    console.warn(`CurveV2: no token fields found in ${typeName}`);
    return [];
  }

  let liqField = null;
  if (fields.includes("totalLiquidityUSD")) liqField = "totalLiquidityUSD";
  else if (fields.includes("totalValueLockedUSD"))
    liqField = "totalValueLockedUSD";

  const query = `
    {
      ${rootField}(first: ${topN}, orderBy: ${
    liqField || "id"
  }, orderDirection: desc) {
        id
        ${tokenSnippet}
        ${liqField || ""}
      }
    }
  `;
  const data = await graphqlRequest(url, query);
  let pools = data && data.data && data.data[rootField];
  if (!Array.isArray(pools)) {
    console.warn(
      `CurveV2 query returned no pools for ${url}. Check the response.`
    );
    return [];
  }

  return pools.map((p) => {
    const toks = p.coins || p.tokens || p.inputTokens || [];
    const outTokens = toks.map((t) => t.id || t);
    const liq = p.totalLiquidityUSD || p.totalValueLockedUSD || "0";
    return {
      poolAddress: p.id,
      tokens: outTokens,
      totalLiquidityUSD: parseFloat(liq),
      dex: "CurveV2",
    };
  });
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

  // Include Uniswap V2 pools if enabled (default true)
  if (process.env.INCLUDE_UNISWAP_V2 !== "false") {
    const uniV2Pools = await fetchUniswapV2TopPools(chainConfig, topN);
    merged = merged.concat(uniV2Pools);
  }

  // Include SushiSwap V2 pools if enabled (default true)
  if (process.env.INCLUDE_SUSHISWAP_V2 !== "false") {
    const sushiPools = await fetchSushiV2TopPools(chainConfig, topN);
    merged = merged.concat(sushiPools);
  }

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

  // --- normalise to lower-case so look-ups are case-insensitive ------------
  const lc = (addr) => (addr ? addr.toLowerCase() : addr);

  merged.forEach((p) => {
    if (p.token0 && p.token1) {
      const reserveUSD =
        p.reserveUSD !== undefined
          ? parseFloat(p.reserveUSD)
          : p.liquidity !== undefined
          ? parseFloat(p.liquidity)
          : 0;
      if (!adjacencyGraph[lc(p.token0)]) adjacencyGraph[lc(p.token0)] = [];
      if (!adjacencyGraph[lc(p.token1)]) adjacencyGraph[lc(p.token1)] = [];
      adjacencyGraph[lc(p.token0)].push({
        token: lc(p.token1),
        pool: p.pairAddress || p.poolAddress,
        dex: p.dex,
        fee: p.fee || 0,
        reserveUSD,
      });
      adjacencyGraph[lc(p.token1)].push({
        token: lc(p.token0),
        pool: p.pairAddress || p.poolAddress,
        dex: p.dex,
        fee: p.fee || 0,
        reserveUSD,
      });
    } else if (p.tokens && p.tokens.length >= 2) {
      // For BalancerV2 / CurveV2 entries
      const tokens = p.tokens;
      const totalLiquidityUSD = p.totalLiquidityUSD || 0;
      for (let i = 0; i < tokens.length; i++) {
        for (let j = i + 1; j < tokens.length; j++) {
          const t0 = lc(tokens[i]);
          const t1 = lc(tokens[j]);
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
      }
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
