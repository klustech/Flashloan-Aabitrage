// server/scripts/graphArb.js
const { Graph } = require("graphlib");
const stats = require("simple-statistics");
const { getAllPoolRates } = require("./liquidityScanner"); // fetch rates of all top pools

// Build a graph where nodes = token addresses, edges = -ln(rate after fees)
async function buildLogGraph(pools) {
  const g = new Graph({ directed: true });
  for (const pool of pools) {
    const rateAB = await getCurrentRate(pool, pool.tokenA, pool.tokenB);
    const rateBA = await getCurrentRate(pool, pool.tokenB, pool.tokenA);
    const weightAB = -Math.log(rateAB * (1 - pool.feeBps / 10000));
    const weightBA = -Math.log(rateBA * (1 - pool.feeBps / 10000));
    g.setEdge(pool.tokenA, pool.tokenB, weightAB);
    g.setEdge(pool.tokenB, pool.tokenA, weightBA);
  }
  return g;
}

// Run Bellman-Ford to find negative cycles
function findNegativeCycles(g) {
  const nodes = g.nodes();
  const distances = {};
  const predecessor = {};
  // Initialize
  nodes.forEach((n) => {
    distances[n] = Infinity;
    predecessor[n] = null;
  });
  distances[nodes[0]] = 0; // start from arbitrary node

  // Relax edges |V|-1 times
  for (let i = 0; i < nodes.length - 1; i++) {
    g.edges().forEach((e) => {
      const u = e.v,
        v = e.w;
      const w = g.edge(e);
      if (distances[u] + w < distances[v]) {
        distances[v] = distances[u] + w;
        predecessor[v] = u;
      }
    });
  }

  // Check for negative cycles
  const negativeCycles = [];
  g.edges().forEach((e) => {
    const u = e.v,
      v = e.w;
    const w = g.edge(e);
    if (distances[u] + w < distances[v]) {
      // Found negative cycle; backtrack
      let cycle = [v];
      let curr = u;
      while (curr && !cycle.includes(curr)) {
        cycle.push(curr);
        curr = predecessor[curr];
      }
      cycle.push(curr);
      negativeCycles.push(cycle.reverse());
    }
  });
  return negativeCycles;
}

module.exports = { buildLogGraph, findNegativeCycles };
