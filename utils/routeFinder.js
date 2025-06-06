const ethers = require("ethers");
const fetch = require("node-fetch");

class Graph {
  constructor() {
    this.nodes = new Set();
    this.edges = []; // { from, to, weight, data }
    this.adjList = {};
  }
  addEdge(from, to, weight, data) {
    this.nodes.add(from);
    this.nodes.add(to);
    this.edges.push({ from, to, weight, data });
    if (!this.adjList[from]) this.adjList[from] = [];
    this.adjList[from].push({ to, weight, data });
  }
  getEdge(from, to) {
    const e = this.edges.find((edge) => edge.from === from && edge.to === to);
    return e ? e.data : null;
  }
}

async function getTopV2Pools(topN, subgraphUrl) {
  const query = `
    {
      pairs(first: ${topN}, orderBy: reserveUSD, orderDirection: desc) {
        id
        token0 { id, symbol, decimals }
        token1 { id, symbol, decimals }
      }
    }
  `;
  const res = await fetch(subgraphUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const { data } = await res.json();
  return data.pairs.map((p) => ({
    address: p.id,
    token0: p.token0,
    token1: p.token1,
  }));
}

async function getReserves(pairAddress, provider) {
  const pairAbi = [
    "function getReserves() view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)",
  ];
  const pair = new ethers.Contract(pairAddress, pairAbi, provider);
  return pair.getReserves();
}

async function createGraphFromPools() {
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.MAINNET_RPC_URL
  );
  const graph = new Graph();
  const uniswapPools = await getTopV2Pools(
    100,
    "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2"
  );
  const sushiPools = await getTopV2Pools(
    100,
    "https://api.thegraph.com/subgraphs/name/sushiswap/exchange"
  );
  for (const pool of uniswapPools) {
    await addV2Edges(graph, pool, process.env.UNISWAP_ROUTER_ADDRESS, provider);
  }
  for (const pool of sushiPools) {
    await addV2Edges(
      graph,
      pool,
      process.env.SUSHISWAP_ROUTER_ADDRESS,
      provider
    );
  }
  return graph;
}

async function addV2Edges(graph, pool, routerAddress, provider) {
  const reserves = await getReserves(pool.address, provider);
  const reserve0 = reserves._reserve0;
  const reserve1 = reserves._reserve1;
  const price0to1 = reserve1
    .mul(ethers.utils.parseUnits("1", 18))
    .div(reserve0);
  const price1to0 = reserve0
    .mul(ethers.utils.parseUnits("1", 18))
    .div(reserve1);
  const w0to1 = -Math.log(parseFloat(ethers.utils.formatUnits(price0to1, 18)));
  const w1to0 = -Math.log(parseFloat(ethers.utils.formatUnits(price1to0, 18)));
  graph.addEdge(pool.token0.id, pool.token1.id, w0to1, {
    router: routerAddress,
  });
  graph.addEdge(pool.token1.id, pool.token0.id, w1to0, {
    router: routerAddress,
  });
}

function bellmanFord(graph, startToken) {
  const tokens = Array.from(graph.nodes);
  const dist = {};
  const predecessor = {};
  tokens.forEach((t) => {
    dist[t] = Infinity;
    predecessor[t] = null;
  });
  dist[startToken] = 0;

  for (let i = 0; i < tokens.length - 1; i++) {
    let updated = false;
    for (const edge of graph.edges) {
      const { from, to, weight } = edge;
      if (dist[from] + weight < dist[to]) {
        dist[to] = dist[from] + weight;
        predecessor[to] = { token: from, edge };
        updated = true;
      }
    }
    if (!updated) break;
  }

  for (const edge of graph.edges) {
    const { from, to, weight } = edge;
    if (dist[from] + weight < dist[to]) {
      let cycle = [];
      let curr = from;
      const visited = new Set();
      while (!visited.has(curr)) {
        visited.add(curr);
        const pred = predecessor[curr];
        curr = pred.token;
      }
      const cycleStart = curr;
      cycle.push(cycleStart);
      curr = predecessor[cycleStart].token;
      while (curr !== cycleStart) {
        cycle.push(curr);
        curr = predecessor[curr].token;
      }
      cycle.push(cycleStart);
      return cycle;
    }
  }
  return null;
}

async function buildSwapData(cycle, borrowAmt) {
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.MAINNET_RPC_URL
  );
  const paths = [];
  const minOuts = [];
  for (let i = 0; i < cycle.length - 1; i++) {
    const tokenIn = cycle[i];
    const tokenOut = cycle[i + 1];
    const router = graph.getEdge(tokenIn, tokenOut).router;
    const path = [tokenIn, tokenOut];
    const amountsOut = await new ethers.Contract(
      router,
      ["function getAmountsOut(uint256, address[]) view returns (uint256[])"],
      provider
    ).getAmountsOut(borrowAmt, path);
    const minOut = amountsOut[amountsOut.length - 1]
      .mul(10000 - parseInt(process.env.SLIPPAGE_BIPS, 10))
      .div(10000);
    paths.push([router, ...path]);
    minOuts.push(minOut);
  }
  return {
    token: cycle[0],
    paths,
    minOuts,
    minProfit: ethers.BigNumber.from(process.env.MIN_PROFIT),
    route: cycle.join("→"),
  };
}

async function routeFinder(borrowAmt) {
  const graph = await createGraphFromPools();
  const swapDatas = [];
  const tokensToMonitor = process.env.TOKENS_TO_MONITOR.split(",");
  for (const token of tokensToMonitor) {
    const cycle = bellmanFord(graph, token);
    if (cycle) {
      const sd = await buildSwapData(cycle, borrowAmt);
      swapDatas.push(sd);
    }
  }
  return swapDatas;
}

module.exports = { routeFinder };
