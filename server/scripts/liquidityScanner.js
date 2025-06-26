/* eslint-disable no-console */
require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
});
const axios = require("axios");

const DEFAULT_TOP_N = parseInt(process.env.DYNAMIC_ROUTE_TOPN || "20", 10);
const DEFAULT_MIN_LIQUIDITY_USD = parseFloat(
  process.env.DYNAMIC_ROUTE_MIN_LIQUIDITY_USD || "100000"
);

const SUBGRAPHS = {
  UniswapV2: "EYCKATKGBKLWvSfwvBjzfCBmGwYNdVkduYXVivCsLRFu",
  SushiSwapV2: "A4JrrMwrEXsYNAiYw7rWwbHhQZdj6YZg1uVy5wa6g821",
  UniswapV3: process.env.UNISWAP_V3_SUBGRAPH_ID || "QmUniswapV3",
  SushiSwapV3: process.env.SUSHISWAP_V3_SUBGRAPH_ID || "QmSushiV3",
  BalancerV2:
    process.env.BALANCER_V2_SUBGRAPH_ID || "balancer-labs/balancer-v2",
  CurveV2: process.env.CURVE_V2_SUBGRAPH_ID || "curvefi/curve",
};

async function fetchPools(subgraphId, dexName, feeBips, topN, minLiquidityUSD) {
  const key = process.env.THEGRAPH_API_KEY;
  const url = key
    ? `https://gateway.thegraph.com/api/${key}/subgraphs/id/${subgraphId}`
    : `https://api.thegraph.com/subgraphs/name/${subgraphId}`;
  const query = `
    {
      pools(
        first: ${topN}
        orderBy: reserveUSD
        orderDirection: desc
        where: { reserveUSD_gt: ${minLiquidityUSD} }
      ) {
        id
        token0 { id symbol decimals }
        token1 { id symbol decimals }
        reserve0
        reserve1
        reserveUSD
      }
    }`;
  try {
    const { data } = await axios.post(
      url,
      { query },
      { headers: { "Content-Type": "application/json" } }
    );
    const list = data?.data?.pools;
    if (!Array.isArray(list)) return [];
    return list.map((p) => ({
      dex: dexName,
      pairAddress: p.id,
      token0: p.token0.id,
      token1: p.token1.id,
      feeBips,
      reserve0: p.reserve0,
      reserve1: p.reserve1,
      reserveUSD: parseFloat(p.reserveUSD),
      decimals0: parseInt(p.token0.decimals, 10),
      decimals1: parseInt(p.token1.decimals, 10),
    }));
  } catch (err) {
    console.error(`GraphQL error for ${dexName}:`, err.message);
    return [];
  }
}

async function getTopLiquidityPools({
  topN = DEFAULT_TOP_N,
  minLiquidityUSD = DEFAULT_MIN_LIQUIDITY_USD,
} = {}) {
  const [uniV2, sushiV2, uniV3, sushiV3, balancerV2, curveV2] =
    await Promise.all([
      fetchPools(SUBGRAPHS.UniswapV2, "UniswapV2", 30, topN, minLiquidityUSD),
      fetchPools(
        SUBGRAPHS.SushiSwapV2,
        "SushiSwapV2",
        30,
        topN,
        minLiquidityUSD
      ),
      fetchPools(SUBGRAPHS.UniswapV3, "UniswapV3", 5, topN, minLiquidityUSD),
      fetchPools(
        SUBGRAPHS.SushiSwapV3,
        "SushiSwapV3",
        30,
        topN,
        minLiquidityUSD
      ),
      fetchPools(SUBGRAPHS.BalancerV2, "BalancerV2", 10, topN, minLiquidityUSD),
      fetchPools(SUBGRAPHS.CurveV2, "CurveV2", 4, topN, minLiquidityUSD),
    ]);

  const all = [
    ...uniV2,
    ...sushiV2,
    ...uniV3,
    ...sushiV3,
    ...balancerV2,
    ...curveV2,
  ];

  all.sort((a, b) => b.reserveUSD - a.reserveUSD);
  return all.slice(0, topN);
}

module.exports = { getTopLiquidityPools };
