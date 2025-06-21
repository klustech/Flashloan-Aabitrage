// server/scripts/v3LiquidityScanner.js
const { request, gql } = require("graphql-request");
const SUBGRAPH_URL =
  "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3";

async function getTopV3Pools(topN) {
  const query = gql`
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
  const data = await request(SUBGRAPH_URL, query);
  return data.pools.map((pool) => ({
    poolAddress: pool.id,
    token0: pool.token0.id,
    token1: pool.token1.id,
    fee: parseInt(pool.feeTier),
    liquidity: pool.liquidity,
  }));
}

module.exports = { getTopV3Pools };
