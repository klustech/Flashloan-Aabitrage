// scripts/checkSchema.cjs
const path = require("path");
const axios = require("axios");
const chalk = require("chalk");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const API_KEY = process.env.THEGRAPH_API_KEY;
if (!API_KEY) {
  console.error(chalk.red("❌  THEGRAPH_API_KEY is missing in .env"));
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Map label → env-var that holds the subgraph ID (null = hard-coded) */
/* ------------------------------------------------------------------ */
const MAP = {
  "eth:uniswapV3": "UNISWAP_V3_SUBGRAPH_ID",
  "eth:balancerV2": "BALANCER_V2_SUBGRAPH_ID",
  "eth:curveV2": "CURVE_V2_SUBGRAPH_ID",

  "arb:sushiV2": "SUSHISWAP_ARBITRUM_SUBGRAPH_ID",
  "arb:uniswapV3": "UNISWAP_V3_ARBITRUM_SUBGRAPH_ID",
  "arb:balancerV2": "BALANCER_ARBITRUM_SUBGRAPH_ID",
  "arb:curveV2": "CURVE_ARBITRUM_SUBGRAPH_ID",

  "op:sushiV2": "SUSHISWAP_OPTIMISM_SUBGRAPH_ID", // hosted name → expect 404
  "op:uniswapV3": "UNISWAP_V3_OPTIMISM_SUBGRAPH_ID",
  "op:balancerV2": "BALANCER_OPTIMISM_SUBGRAPH_ID",
  "op:curveV2": "CURVE_OPTIMISM_SUBGRAPH_ID",
};

/* legacy Uniswap/Sushi main-net v2 hashes (still work) */
const LEGACY = {};

const Q_ROOT = '{ __type(name:"Query"){ fields{name} } }';
const Q_TYPE = (t) => `{ __type(name:"${t}"){ fields{name} } }`;
// Different subgraph schemas expose pool fields under various names. Map the
// expected root query field to the list of required pool fields for that schema
// so we validate against whatever the subgraph actually uses.
const NEEDS_BY_ROOT = {
  pools: ["token0", "token1", "reserveUSD", "feeTier", "liquidity"],
  liquidityPools: ["inputTokens", "totalValueLockedUSD"],
  pairs: ["token0", "token1", "reserveUSD"],
};

async function fetch(url, query) {
  const { data } = await axios.post(url, { query }, { timeout: 15000 });
  return data;
}

(async () => {
  for (const [label, envVar] of Object.entries(MAP)) {
    let id = envVar ? process.env[envVar] : null;
    if (!id && LEGACY[label]) id = LEGACY[label];
    const url = id
      ? `https://gateway.thegraph.com/api/${API_KEY}/subgraphs/id/${id}`
      : null;

    if (!url) {
      console.log(chalk.yellow(`[SKIP] ${label} — no ID configured`));
      continue;
    }

    process.stdout.write(`${label.padEnd(20)} `);

    try {
      /* ---- step 1: root introspection ---- */
      const rootFields =
        (await fetch(url, Q_ROOT))?.data?.__type?.fields.map((f) => f.name) ??
        [];

      const entry = rootFields.includes("pools")
        ? { field: "pools", type: "Pool" }
        : rootFields.includes("liquidityPools")
        ? { field: "liquidityPools", type: "LiquidityPool" }
        : rootFields.includes("pairs")
        ? { field: "pairs", type: "Pair" }
        : null;

      if (!entry) {
        console.log(chalk.red("FAIL  — Query root has no pools/pairs field"));
        continue;
      }

      /* ---- step 2: pool-type introspection ---- */
      const poolFields =
        (await fetch(url, Q_TYPE(entry.type)))?.data?.__type?.fields.map(
          (f) => f.name
        ) ?? [];

      const needs = NEEDS_BY_ROOT[entry.field] || NEEDS_BY_ROOT.pools;
      const missing = needs.filter((x) => !poolFields.includes(x));
      const status = missing.length ? chalk.yellow("WARN") : chalk.green("OK");

      console.log(
        `${status} — root: ${entry.field.padEnd(16)} | ` +
          `fields: ${poolFields.length.toString().padStart(2)} | ` +
          (missing.length ? `missing: ${missing.join(", ")}` : "schema good")
      );
    } catch (e) {
      const msg = e.response?.data?.errors
        ? JSON.stringify(e.response.data.errors)
        : e.message;
      console.log(chalk.red(`FAIL  — ${msg}`));
    }
  }
})();
