// scripts/logSubgraphFields.js

require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
});
const axios = require("axios");

// Fallback hosted‐service URLs for known bad IDs
const HOSTED_SUBGRAPHS = {
  "ethereum:curveV2": {
    subgraphUrl: "https://api.thegraph.com/subgraphs/name/curvefi/curve-v2",
    fallbackUrl: "https://api.thegraph.com/subgraphs/name/curvefi/curve-v2",
  },
  "optimism:sushiV2": {
    subgraphUrl:
      "https://api.thegraph.com/subgraphs/name/sushiswap/exchange-optimism",
    fallbackUrl:
      "https://api.thegraph.com/subgraphs/name/sushiswap/exchange-optimism",
  },
};

// Pull your IDs from .env
const {
  THEGRAPH_API_KEY,
  UNISWAP_V3_SUBGRAPH_ID,
  BALANCER_V2_SUBGRAPH_ID,
  CURVE_V2_SUBGRAPH_ID,
  UNISWAP_V3_ARBITRUM_SUBGRAPH_ID,
  BALANCER_ARBITRUM_SUBGRAPH_ID,
  CURVE_ARBITRUM_SUBGRAPH_ID,
  UNISWAP_V3_OPTIMISM_SUBGRAPH_ID,
  BALANCER_OPTIMISM_SUBGRAPH_ID,
  SUSHISWAP_OPTIMISM_SUBGRAPH_ID,
  CURVE_OPTIMISM_SUBGRAPH_ID,
} = process.env;

// Build CHAIN_CONFIGS just like your liquidityScanner
const CHAIN_CONFIGS = {
  ethereum: {
    uniswapV2: {
      subgraphUrl: THEGRAPH_API_KEY
        ? `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/name/uniswap/uniswap-v2`
        : "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2",
      fallbackUrl: "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2",
    },
    sushiV2: {
      subgraphUrl: THEGRAPH_API_KEY
        ? `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/name/sushiswap/exchange`
        : "https://api.thegraph.com/subgraphs/name/sushiswap/exchange",
      fallbackUrl: "https://api.thegraph.com/subgraphs/name/sushiswap/exchange",
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
    curveV2: CURVE_ARBITRUM_SUBGRAPH_ID
      ? {
          subgraphUrl: `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${CURVE_ARBITRUM_SUBGRAPH_ID}`,
          fallbackUrl: null,
        }
      : undefined,
  },
  optimism: {
    sushiV2: SUSHISWAP_OPTIMISM_SUBGRAPH_ID
      ? {
          subgraphUrl: `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/${SUSHISWAP_OPTIMISM_SUBGRAPH_ID}`,
          fallbackUrl: null,
        }
      : undefined,
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

// Simple GraphQL POST with optional fallback retry
async function graphqlRequest(url, query, fallbackUrl) {
  try {
    const resp = await axios.post(
      url,
      { query },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
      }
    );
    if (resp.data.errors)
      throw new Error(resp.data.errors.map((e) => e.message).join("; "));
    return resp.data;
  } catch (err) {
    if (fallbackUrl && fallbackUrl !== url) {
      return graphqlRequest(fallbackUrl, query, null);
    }
    throw err;
  }
}

// Introspect root Query fields
async function getQueryFields(url, fallbackUrl = null) {
  const introspection = `
    {
      __type(name: "Query") { fields { name } }
    }
  `;
  const data = await graphqlRequest(url, introspection, fallbackUrl);
  return data.data.__type?.fields?.map((f) => f.name) || [];
}

async function main() {
  for (const [chain, dexes] of Object.entries(CHAIN_CONFIGS)) {
    for (const [dex, cfg] of Object.entries(dexes)) {
      if (!cfg || !cfg.subgraphUrl) continue;
      const key = `${chain}:${dex}`;
      const { subgraphUrl, fallbackUrl } = cfg;

      try {
        const fields = await getQueryFields(subgraphUrl, fallbackUrl);
        console.log(`[FIELDS] ${key} — ${fields.length} fields`);
        console.log("  ", fields.join(", "));
      } catch (err) {
        if (HOSTED_SUBGRAPHS[key]) {
          console.warn(`[WARN] ${key} failed, trying hosted fallback…`);
          try {
            const hosted = HOSTED_SUBGRAPHS[key];
            const fields = await getQueryFields(
              hosted.subgraphUrl,
              hosted.fallbackUrl
            );
            console.log(`[FIELDS] ${key} (hosted) — ${fields.length} fields`);
            console.log("  ", fields.join(", "));
          } catch (err2) {
            console.error(`[ERROR] ${key} hosted also failed: ${err2.message}`);
          }
        } else {
          console.error(`[ERROR] ${key} — ${err.message}`);
        }
      }
    }
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
