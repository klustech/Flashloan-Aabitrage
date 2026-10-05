require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
  override: false, // injected environment takes precedence over .env
});
const redis = require("../utils/redisClient");
const { getTopLiquidityPairs } = require("./liquidityScanner");
const { ethers } = require("ethers");
const { Graph } = require("graphlib");
const stats = require("simple-statistics");

// Import metrics for cycle detection tracking
const {
  cycleDetectionMode,
  negativeCyclesFound,
  cycleDetectionDuration,
  poolsAnalyzed,
  graphEdges,
  routesDiscovered,
} = require("../metricsRegistry");

// Logger for route discovery
const logger = {
  info: (msg) => console.log(`[routeFinder] ${msg}`),
  warn: (msg) => console.warn(`[routeFinder] ${msg}`),
  debug: (msg) =>
    process.env.DEBUG_ROUTES === "true" &&
    console.log(`[routeFinder:debug] ${msg}`),
};

// ------------------------------------------------------------------------------------
// Helper: turn a flat list of pools into an adjacency graph:
//   {
//     [tokenAddress]: [
//       { token: otherTokenAddress, poolAddress: poolAddress, dex, fee, reserveUSD },
//       …
//     ],
//     …
//   }
// ------------------------------------------------------------------------------------
function makeAdjacencyGraphFromPools(pools) {
  const adjacency = {};

  for (const p of pools) {
    const {
      token0,
      token1,
      pairAddress: poolAddress,
      dex,
      fee,
      reserveUSD,
    } = p;

    if (!token0 || !token1) continue;

    if (!adjacency[token0]) adjacency[token0] = [];
    if (!adjacency[token1]) adjacency[token1] = [];

    adjacency[token0].push({
      token: token1,
      poolAddress: poolAddress,
      dex,
      fee,
      reserveUSD,
    });
    adjacency[token1].push({
      token: token0,
      poolAddress: poolAddress,
      dex,
      fee,
      reserveUSD,
    });
  }

  return adjacency;
}

// ------------------------------------------------------------------------------------
// Helper: Convert a “token-cycle” array into a routeDef object by looking up matching
// pool information from the set of available pools. Each routeDef.hops entry: {
//    tokenA, tokenB, dex, poolAddress, fee (if V3), curveIndices (if Curve), liquidity, feeBps
// }
// ------------------------------------------------------------------------------------
function convertCycleToRouteDef(cycleTokens, allPools) {
  // cycleTokens: [token0, token1, token2, …, token0]
  // allPools: array of pool entries { token0, token1, pairAddress, dex, fee, tokens?, liquidity?, feeBps? }

  const hops = [];
  for (let i = 0; i < cycleTokens.length - 1; i++) {
    const tA = cycleTokens[i];
    const tB = cycleTokens[i + 1];

    const matching = allPools.find((pool) => {
      const isMultiToken =
        pool.dex === "balancer_v2" || pool.dex === "curve_v2";
      if (isMultiToken) {
        if (!Array.isArray(pool.tokens)) return false;
      } else if (!pool.token0 || !pool.token1) {
        return false; // skip malformed pools without crashing
      }
      if (pool.dex === "uniswap_v2" || pool.dex === "sushiswap_v2") {
        return (
          (pool.token0.toLowerCase() === tA.toLowerCase() &&
            pool.token1.toLowerCase() === tB.toLowerCase()) ||
          (pool.token0.toLowerCase() === tB.toLowerCase() &&
            pool.token1.toLowerCase() === tA.toLowerCase())
        );
      } else if (pool.dex === "uniswap_v3") {
        return (
          (pool.token0.toLowerCase() === tA.toLowerCase() &&
            pool.token1.toLowerCase() === tB.toLowerCase()) ||
          (pool.token0.toLowerCase() === tB.toLowerCase() &&
            pool.token1.toLowerCase() === tA.toLowerCase())
        );
      } else if (pool.dex === "balancer_v2" || pool.dex === "curve_v2") {
        return (
          pool.tokens.map((x) => x.toLowerCase()).includes(tA.toLowerCase()) &&
          pool.tokens.map((x) => x.toLowerCase()).includes(tB.toLowerCase())
        );
      }
      return false;
    });

    if (!matching) {
      return null;
    }

    let feeBps = 30;
    if (matching.dex === "uniswap_v3") {
      feeBps = matching.fee / 100;
    } else if (matching.dex === "balancer_v2") {
      feeBps = matching.feeBps || 20;
    } else if (matching.dex === "curve_v2") {
      feeBps = matching.feeBps || 4;
    }

    let curveIndices = null;
    if (matching.dex === "curve_v2") {
      const lowerTokens = matching.tokens.map((x) => x.toLowerCase());
      const i = lowerTokens.indexOf(tA.toLowerCase());
      const j = lowerTokens.indexOf(tB.toLowerCase());
      curveIndices = { i, j };
    }

    hops.push({
      tokenA: tA,
      tokenB: tB,
      dex: matching.dex,
      poolAddress: matching.poolAddress || matching.pairAddress,
      fee: matching.fee || null,
      curveIndices,
      liquidity: matching.liquidity || 0,
      feeBps,
    });
  }

  return {
    id: Math.random().toString(36).substring(2, 9),
    hops,
    liquidity: hops.reduce((acc, h) => acc + (h.liquidity || 0), 0),
    historicalSuccessCount: 0,
    volatility: 0,
  };
}

// ------------------------------------------------------------------------------------
// Step 1: Fetch top-N pools via getTopLiquidityPairs(), build adjacency graph
// ------------------------------------------------------------------------------------
async function getAllPools({ topN, minLiquidityUSD, chain }) {
  // getTopLiquidityPairs returns an array of pool objects:
  //   { token0, token1, pairAddress, dex, fee, tokens?, reserveUSD, feeBps? }
  const flatPools = await getTopLiquidityPairs(chain, {
    topN,
    minLiquidityUSD,
  });
  if (!flatPools.length) {
    console.warn(`No pools returned for ${chain} with topN=${topN}`);
  }
  const adjacencyGraph = makeAdjacencyGraphFromPools(flatPools);
  return { adjacencyGraph, flatPools };
}

// ------------------------------------------------------------------------------------
// Step 2a: Negative cycle detection via Bellman-Ford (if ALLOW_LNG_CYCLES=true)
// ------------------------------------------------------------------------------------
async function findNegativeCycles(adjacencyGraph, allPools) {
  const g = new Graph({ directed: true });
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.MAINNET_RPC_URL
  );

  async function getCurrentRate(pool, tA, tB) {
    if (pool.dex === "uniswap_v2" || pool.dex === "sushiswap_v2") {
      const routerAddress =
        pool.dex === "uniswap_v2"
          ? process.env.UNISWAP_ROUTER_ADDRESS
          : process.env.SUSHISWAP_ROUTER_ADDRESS;
      const router = new ethers.Contract(
        routerAddress,
        [
          "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)",
        ],
        provider
      );
      const amounts = await router.getAmountsOut(
        ethers.utils.parseUnits("1", 18),
        [tA, tB]
      );
      return parseFloat(ethers.utils.formatUnits(amounts[1], 18));
    } else if (pool.dex === "uniswap_v3") {
      const quote = await require("./v3Utils").getV3Quote(
        provider,
        tA,
        tB,
        pool.fee,
        ethers.utils.parseUnits("1", 18)
      );
      return parseFloat(ethers.utils.formatUnits(quote, 18));
    } else if (pool.dex === "balancer_v2") {
      const { sor } = await require("./balancerUtils").initBalancer(provider);
      const swapInfo = await sor.getSwaps(
        tA,
        tB,
        "SwapExactIn",
        ethers.utils.parseUnits("1", 18).toString()
      );
      return parseFloat(ethers.utils.formatUnits(swapInfo.returnAmount, 18));
    } else if (pool.dex === "curve_v2") {
      const idxA = pool.tokens
        .map((x) => x.toLowerCase())
        .indexOf(tA.toLowerCase());
      const idxB = pool.tokens
        .map((x) => x.toLowerCase())
        .indexOf(tB.toLowerCase());
      const quote = await require("./curveUtils").getCurveQuote(
        provider,
        pool.poolAddress,
        idxA,
        idxB,
        ethers.utils.parseUnits("1", 18)
      );
      return parseFloat(ethers.utils.formatUnits(quote, 18));
    }
    return 1.0;
  }

  // Build Graph edges with weights = –log(rate * (1 – feeFraction))
  for (const tokenA of Object.keys(adjacencyGraph)) {
    for (const edge of adjacencyGraph[tokenA]) {
      const poolInfo =
        allPools.find((p) => p.pairAddress === edge.poolAddress) || {};
      const tA = tokenA;
      const tB = edge.token;
      let rate01 = 1.0;
      let rate10 = 1.0;
      try {
        rate01 = await getCurrentRate(
          { ...poolInfo, poolAddress: edge.poolAddress },
          tA,
          tB
        );
        rate10 = await getCurrentRate(
          { ...poolInfo, poolAddress: edge.poolAddress },
          tB,
          tA
        );
      } catch {
        continue;
      }

      const feeFraction = (edge.feeBps || edge.fee || 30) / 10000;
      const w01 = -Math.log(rate01 * (1 - feeFraction));
      const w10 = -Math.log(rate10 * (1 - feeFraction));

      g.setNode(tA);
      g.setNode(tB);
      g.setEdge(tA, tB, w01);
      g.setEdge(tB, tA, w10);
    }
  }

  const nodes = g.nodes();
  if (nodes.length === 0) return [];

  const dist = {};
  const pred = {};
  for (const n of nodes) {
    dist[n] = Infinity;
    pred[n] = null;
  }
  dist[nodes[0]] = 0;

  for (let i = 0; i < nodes.length - 1; i++) {
    for (const e of g.edges()) {
      const u = e.v;
      const v = e.w;
      const w = g.edge(u, v);
      if (dist[u] + w < dist[v]) {
        dist[v] = dist[u] + w;
        pred[v] = u;
      }
    }
  }

  const cycles = [];
  for (const e of g.edges()) {
    const u = e.v;
    const v = e.w;
    const w = g.edge(u, v);
    if (dist[u] + w < dist[v]) {
      let cycle = [v];
      let curr = u;
      while (curr && !cycle.includes(curr)) {
        cycle.push(curr);
        curr = pred[curr];
      }
      cycle.push(curr);
      cycles.push(cycle.reverse());
    }
  }

  return cycles;
}

// ------------------------------------------------------------------------------------
// Step 2b: Brute-Force DFS for ≤3-Hop “triangular” routes (if ALLOW_LNG_CYCLES=false)
// ------------------------------------------------------------------------------------
function enumerate3HopRoutes(allPools) {
  // Build simple adjacency list for DFS
  const adj = {};
  for (const pool of allPools) {
    if (!pool.token0 || !pool.token1) continue; // skip malformed pools
    const t0 = pool.token0.toLowerCase();
    const t1 = pool.token1.toLowerCase();
    if (!adj[t0]) adj[t0] = [];
    if (!adj[t1]) adj[t1] = [];
    adj[t0].push(pool);
    adj[t1].push(pool);
  }

  const routeDefs = [];
  let nextId = 1;

  for (const startToken of Object.keys(adj)) {
    const stack = [
      {
        pathTokens: [startToken],
        visitedPools: new Set(),
      },
    ];

    while (stack.length > 0) {
      const { pathTokens, visitedPools } = stack.pop();
      const lastToken = pathTokens[pathTokens.length - 1];

      if (
        pathTokens.length > 1 &&
        lastToken === startToken &&
        pathTokens.length <= 4
      ) {
        if (pathTokens.length >= 3 && pathTokens.length <= 4) {
          const route = convertCycleToRouteDef([...pathTokens], allPools);
          if (route) {
            route.id = `3hop_${nextId++}`;
            route.routeTokens = [...pathTokens]; // track for readability
            routeDefs.push(route);
          }
        }
        continue;
      }
      if (pathTokens.length === 4) continue;

      for (const pool of adj[lastToken]) {
        if (visitedPools.has(pool.pairAddress)) continue;
        const otherToken =
          pool.token0.toLowerCase() === lastToken
            ? pool.token1.toLowerCase()
            : pool.token0.toLowerCase();
        if (
          pathTokens.length >= 2 &&
          otherToken === pathTokens[pathTokens.length - 2]
        ) {
          continue;
        }
        const newVisited = new Set(visitedPools);
        newVisited.add(pool.pairAddress);
        const newPath = [...pathTokens, otherToken];
        stack.push({ pathTokens: newPath, visitedPools: newVisited });
      }
    }
  }

  return routeDefs;
}

// ------------------------------------------------------------------------------------
// Main Exported Function: getAllRoutes(topN)
// ------------------------------------------------------------------------------------
async function getAllRoutes({
  startToken,
  topN,
  minLiquidityUSD,
  maxHops,
  allowLongCycles,
  chain,
}) {
  const minLiq =
    minLiquidityUSD ||
    process.env.DYNAMIC_ROUTE_MIN_LIQUIDITY_USD ||
    process.env.MIN_LIQUIDITY ||
    "100000";

  // 1. Fetch pools & adjacency map
  const startTime = Date.now();
  const { adjacencyGraph, flatPools } = await getAllPools({
    topN,
    minLiquidityUSD: minLiq,
    chain,
  });

  // Track pools analyzed
  poolsAnalyzed.set(flatPools.length);
  logger.info(
    `Fetched ${flatPools.length} pools for ${chain} (topN=${topN}, minLiq=$${minLiq})`
  );

  // Count graph edges
  let edgeCount = 0;
  for (const token of Object.keys(adjacencyGraph)) {
    edgeCount += adjacencyGraph[token].length;
  }
  graphEdges.set(edgeCount);
  logger.debug(
    `Built adjacency graph with ${
      Object.keys(adjacencyGraph).length
    } tokens, ${edgeCount} edges`
  );

  let routeDefs = [];

  const allowCycles =
    typeof allowLongCycles === "boolean"
      ? allowLongCycles
      : process.env.ALLOW_LNG_CYCLES === "true";

  // Track detection mode in metrics
  cycleDetectionMode.set(allowCycles ? 1 : 0);

  if (allowCycles) {
    // 2a. Negative‐cycle detection via Bellman-Ford
    logger.info(
      `Using Bellman-Ford negative cycle detection (ALLOW_LNG_CYCLES=true)`
    );
    const bfStartTime = Date.now();

    const cycles = await findNegativeCycles(adjacencyGraph, flatPools);

    const bfDuration = Date.now() - bfStartTime;
    cycleDetectionDuration.labels("bellman_ford").observe(bfDuration);
    negativeCyclesFound.set(cycles.length);

    logger.info(
      `Bellman-Ford found ${cycles.length} negative cycles in ${bfDuration}ms`
    );

    let idx = 1;
    for (const cycleTokens of cycles) {
      const rd = convertCycleToRouteDef(cycleTokens, flatPools);
      if (rd) {
        rd.id = `bf_${idx++}`;
        rd.routeTokens = [...cycleTokens];
        routeDefs.push(rd);
        logger.debug(
          `Cycle ${rd.id}: ${cycleTokens.length} tokens, ${rd.hops.length} hops`
        );
      }
    }
  } else {
    // 2b. ≤3-Hop enumeration via DFS
    logger.info(
      `Using DFS triangular route enumeration (ALLOW_LNG_CYCLES=false)`
    );
    const dfsStartTime = Date.now();

    const routes = enumerate3HopRoutes(flatPools);
    routeDefs = routes;

    const dfsDuration = Date.now() - dfsStartTime;
    cycleDetectionDuration.labels("dfs_triangular").observe(dfsDuration);
    negativeCyclesFound.set(0); // Not applicable for DFS mode

    logger.info(
      `DFS enumeration found ${routes.length} routes in ${dfsDuration}ms`
    );
  }

  /**
   * Final sanity pass – ensure every route has a non-empty hops array
   * so the worker never receives malformed data.
   */
  const beforeFilter = routeDefs.length;
  routeDefs = routeDefs.filter(
    (r) => Array.isArray(r.hops) && r.hops.length > 0
  );

  if (beforeFilter !== routeDefs.length) {
    logger.warn(
      `Filtered out ${beforeFilter - routeDefs.length} malformed routes`
    );
  }

  // Enforce the maxHops contract. DFS caps at 3 hops, but Bellman-Ford cycles can
  // be longer; this guarantees callers never receive a route exceeding maxHops.
  const hopLimit = Number.isInteger(maxHops) && maxHops > 0 ? maxHops : 3;
  const beforeHopFilter = routeDefs.length;
  routeDefs = routeDefs.filter((r) => r.hops.length <= hopLimit);
  if (beforeHopFilter !== routeDefs.length) {
    logger.debug(
      `Filtered out ${
        beforeHopFilter - routeDefs.length
      } routes exceeding maxHops=${hopLimit}`
    );
  }

  // Track total routes discovered
  routesDiscovered.set(routeDefs.length);

  const totalDuration = Date.now() - startTime;
  logger.info(
    `Route discovery complete: ${routeDefs.length} valid routes in ${totalDuration}ms`
  );

  return routeDefs;
}

module.exports = {
  getAllRoutes: getAllRoutes,
};
