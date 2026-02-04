/**
 * server/scripts/incrementalGraph.js
 *
 * Incremental graph updates for low-latency route discovery.
 * Instead of rebuilding the entire graph, this module updates only
 * the affected edges when pool states change.
 */

const { ethers, BigNumber } = require("ethers");
const winston = require("winston");

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [new winston.transports.Console()],
});

// ─────────────────────────────────────────────────────────────────────────────
// Graph Data Structure
// ─────────────────────────────────────────────────────────────────────────────

class IncrementalGraph {
  constructor() {
    // Adjacency list: token -> [{ toToken, poolAddress, dex, weight, reserves }]
    this.adjacencyList = new Map();

    // Pool index: poolAddress -> { token0, token1, dex, reserve0, reserve1, fee, lastUpdate }
    this.poolIndex = new Map();

    // Token index: tokenAddress -> { symbol, decimals, pools: Set<poolAddress> }
    this.tokenIndex = new Map();

    // Route cache: routeKey -> { route, cachedAt, invalidatedAt }
    this.routeCache = new Map();

    // Dirty pools needing route recalculation
    this.dirtyPools = new Set();

    // Stats
    this.stats = {
      totalPools: 0,
      totalTokens: 0,
      totalEdges: 0,
      updateCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
      lastFullRebuild: null,
      lastIncrementalUpdate: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pool Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Add or update a pool in the graph
   */
  addPool(poolData) {
    const {
      poolAddress,
      token0,
      token1,
      dex,
      reserve0,
      reserve1,
      fee = 30, // Default 0.3% fee in bps
      sqrtPriceX96, // For V3 pools
      liquidity, // For V3 pools
    } = poolData;

    const normalizedPool = poolAddress.toLowerCase();
    const normalizedToken0 = token0.toLowerCase();
    const normalizedToken1 = token1.toLowerCase();

    // Check if this is an update or new pool
    const existing = this.poolIndex.get(normalizedPool);
    const isUpdate = !!existing;

    // Update pool index
    this.poolIndex.set(normalizedPool, {
      token0: normalizedToken0,
      token1: normalizedToken1,
      dex,
      reserve0: reserve0?.toString() || "0",
      reserve1: reserve1?.toString() || "0",
      fee,
      sqrtPriceX96: sqrtPriceX96?.toString(),
      liquidity: liquidity?.toString(),
      lastUpdate: Date.now(),
    });

    // Update token index
    this._ensureToken(normalizedToken0);
    this._ensureToken(normalizedToken1);
    this.tokenIndex.get(normalizedToken0).pools.add(normalizedPool);
    this.tokenIndex.get(normalizedToken1).pools.add(normalizedPool);

    // Calculate edge weights and update adjacency list
    const weight01 = this._calculateWeight(reserve0, reserve1, fee, dex, false);
    const weight10 = this._calculateWeight(reserve1, reserve0, fee, dex, true);

    this._updateEdge(normalizedToken0, normalizedToken1, normalizedPool, dex, weight01, {
      reserve0,
      reserve1,
      fee,
    });
    this._updateEdge(normalizedToken1, normalizedToken0, normalizedPool, dex, weight10, {
      reserve0: reserve1,
      reserve1: reserve0,
      fee,
    });

    // Mark pool as dirty for route invalidation
    this.dirtyPools.add(normalizedPool);

    if (!isUpdate) {
      this.stats.totalPools++;
    }
    this.stats.updateCount++;
    this.stats.lastIncrementalUpdate = Date.now();

    return { isUpdate, pool: normalizedPool };
  }

  /**
   * Remove a pool from the graph
   */
  removePool(poolAddress) {
    const normalizedPool = poolAddress.toLowerCase();
    const pool = this.poolIndex.get(normalizedPool);

    if (!pool) return false;

    // Remove edges
    this._removeEdge(pool.token0, pool.token1, normalizedPool);
    this._removeEdge(pool.token1, pool.token0, normalizedPool);

    // Update token index
    this.tokenIndex.get(pool.token0)?.pools.delete(normalizedPool);
    this.tokenIndex.get(pool.token1)?.pools.delete(normalizedPool);

    // Remove from pool index
    this.poolIndex.delete(normalizedPool);

    // Mark as dirty
    this.dirtyPools.add(normalizedPool);

    this.stats.totalPools--;
    return true;
  }

  /**
   * Batch update multiple pools
   */
  batchUpdatePools(poolDataArray) {
    const results = [];
    for (const poolData of poolDataArray) {
      results.push(this.addPool(poolData));
    }
    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Edge Weight Calculation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Calculate edge weight for Bellman-Ford (negative log of exchange rate)
   */
  _calculateWeight(reserveIn, reserveOut, feeBps, dex, reversed) {
    try {
      const rIn = BigNumber.from(reserveIn || "0");
      const rOut = BigNumber.from(reserveOut || "0");

      if (rIn.isZero() || rOut.isZero()) {
        return Infinity; // Invalid pool
      }

      // Calculate effective exchange rate after fee
      const feeMultiplier = 10000 - feeBps;

      // For V2-style pools: amountOut = (amountIn * feeMultiplier * reserveOut) / (reserveIn * 10000 + amountIn * feeMultiplier)
      // Simplified rate: reserveOut / reserveIn * feeMultiplier / 10000
      const rateNumerator = rOut.mul(feeMultiplier);
      const rateDenominator = rIn.mul(10000);

      // Convert to float for log calculation
      const rate = parseFloat(rateNumerator.toString()) / parseFloat(rateDenominator.toString());

      if (rate <= 0 || !isFinite(rate)) {
        return Infinity;
      }

      // Negative log for Bellman-Ford (find negative cycles = arbitrage)
      return -Math.log(rate);
    } catch (error) {
      logger.warn(`Weight calculation error: ${error.message}`);
      return Infinity;
    }
  }

  /**
   * Recalculate weight for a specific pool
   */
  recalculatePoolWeight(poolAddress) {
    const normalizedPool = poolAddress.toLowerCase();
    const pool = this.poolIndex.get(normalizedPool);

    if (!pool) return false;

    const weight01 = this._calculateWeight(pool.reserve0, pool.reserve1, pool.fee, pool.dex, false);
    const weight10 = this._calculateWeight(pool.reserve1, pool.reserve0, pool.fee, pool.dex, true);

    this._updateEdge(pool.token0, pool.token1, normalizedPool, pool.dex, weight01, {
      reserve0: pool.reserve0,
      reserve1: pool.reserve1,
      fee: pool.fee,
    });
    this._updateEdge(pool.token1, pool.token0, normalizedPool, pool.dex, weight10, {
      reserve0: pool.reserve1,
      reserve1: pool.reserve0,
      fee: pool.fee,
    });

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Graph Operations
  // ─────────────────────────────────────────────────────────────────────────────

  _ensureToken(tokenAddress) {
    if (!this.tokenIndex.has(tokenAddress)) {
      this.tokenIndex.set(tokenAddress, {
        symbol: null,
        decimals: null,
        pools: new Set(),
      });
      this.stats.totalTokens++;
    }
  }

  _updateEdge(fromToken, toToken, poolAddress, dex, weight, metadata) {
    if (!this.adjacencyList.has(fromToken)) {
      this.adjacencyList.set(fromToken, []);
    }

    const edges = this.adjacencyList.get(fromToken);
    const existingIndex = edges.findIndex(
      (e) => e.poolAddress === poolAddress && e.toToken === toToken
    );

    const edgeData = {
      toToken,
      poolAddress,
      dex,
      weight,
      ...metadata,
      lastUpdate: Date.now(),
    };

    if (existingIndex >= 0) {
      edges[existingIndex] = edgeData;
    } else {
      edges.push(edgeData);
      this.stats.totalEdges++;
    }
  }

  _removeEdge(fromToken, toToken, poolAddress) {
    const edges = this.adjacencyList.get(fromToken);
    if (!edges) return;

    const index = edges.findIndex(
      (e) => e.poolAddress === poolAddress && e.toToken === toToken
    );

    if (index >= 0) {
      edges.splice(index, 1);
      this.stats.totalEdges--;
    }
  }

  /**
   * Get all edges from a token
   */
  getEdges(tokenAddress) {
    return this.adjacencyList.get(tokenAddress.toLowerCase()) || [];
  }

  /**
   * Get all tokens in the graph
   */
  getTokens() {
    return Array.from(this.tokenIndex.keys());
  }

  /**
   * Get pool data
   */
  getPool(poolAddress) {
    return this.poolIndex.get(poolAddress.toLowerCase());
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Route Cache Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Cache a computed route
   */
  cacheRoute(routeKey, route) {
    this.routeCache.set(routeKey, {
      route,
      cachedAt: Date.now(),
      invalidatedAt: null,
    });
  }

  /**
   * Get cached route if valid
   */
  getCachedRoute(routeKey, maxAge = 5000) {
    const cached = this.routeCache.get(routeKey);

    if (!cached) {
      this.stats.cacheMisses++;
      return null;
    }

    // Check if invalidated
    if (cached.invalidatedAt && cached.invalidatedAt > cached.cachedAt) {
      this.stats.cacheMisses++;
      return null;
    }

    // Check age
    if (Date.now() - cached.cachedAt > maxAge) {
      this.stats.cacheMisses++;
      return null;
    }

    this.stats.cacheHits++;
    return cached.route;
  }

  /**
   * Invalidate routes affected by a pool update
   */
  invalidateRoutesForPool(poolAddress) {
    const normalizedPool = poolAddress.toLowerCase();
    const now = Date.now();

    for (const [key, cached] of this.routeCache.entries()) {
      // Check if route contains this pool
      if (cached.route?.hops?.some((h) => h.poolAddress?.toLowerCase() === normalizedPool)) {
        cached.invalidatedAt = now;
      }
    }
  }

  /**
   * Clear all dirty pools and process invalidations
   */
  processDirtyPools() {
    for (const poolAddress of this.dirtyPools) {
      this.invalidateRoutesForPool(poolAddress);
    }
    const count = this.dirtyPools.size;
    this.dirtyPools.clear();
    return count;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Bellman-Ford for Arbitrage Detection
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Find negative cycles (arbitrage opportunities) starting from a token
   */
  findNegativeCycles(startToken, maxHops = 5) {
    const normalizedStart = startToken.toLowerCase();
    const tokens = this.getTokens();
    const n = tokens.length;

    if (n === 0) return [];

    // Initialize distances
    const dist = new Map();
    const parent = new Map();
    const parentEdge = new Map();

    tokens.forEach((t) => dist.set(t, Infinity));
    dist.set(normalizedStart, 0);

    // Relax edges (V-1) times
    for (let i = 0; i < Math.min(n - 1, maxHops); i++) {
      let updated = false;

      for (const [fromToken, edges] of this.adjacencyList.entries()) {
        const fromDist = dist.get(fromToken);
        if (fromDist === Infinity) continue;

        for (const edge of edges) {
          if (edge.weight === Infinity) continue;

          const newDist = fromDist + edge.weight;
          if (newDist < dist.get(edge.toToken)) {
            dist.set(edge.toToken, newDist);
            parent.set(edge.toToken, fromToken);
            parentEdge.set(edge.toToken, edge);
            updated = true;
          }
        }
      }

      if (!updated) break;
    }

    // Check for negative cycles
    const cycles = [];

    for (const [fromToken, edges] of this.adjacencyList.entries()) {
      const fromDist = dist.get(fromToken);
      if (fromDist === Infinity) continue;

      for (const edge of edges) {
        if (edge.weight === Infinity) continue;

        const newDist = fromDist + edge.weight;
        if (newDist < dist.get(edge.toToken)) {
          // Found negative cycle - reconstruct it
          const cycle = this._reconstructCycle(edge.toToken, parent, parentEdge, maxHops);
          if (cycle && cycle.length > 0) {
            cycles.push(cycle);
          }
        }
      }
    }

    return cycles;
  }

  _reconstructCycle(startNode, parent, parentEdge, maxHops) {
    const visited = new Set();
    const path = [];
    let current = startNode;

    while (current && !visited.has(current) && path.length < maxHops * 2) {
      visited.add(current);
      const edge = parentEdge.get(current);
      if (edge) {
        path.unshift({
          fromToken: parent.get(current),
          toToken: current,
          poolAddress: edge.poolAddress,
          dex: edge.dex,
          weight: edge.weight,
        });
      }
      current = parent.get(current);
    }

    // Verify it's a cycle
    if (path.length > 0 && path[0].fromToken === path[path.length - 1].toToken) {
      return path;
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stats and Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  getStats() {
    return {
      ...this.stats,
      dirtyPools: this.dirtyPools.size,
      cachedRoutes: this.routeCache.size,
      cacheHitRate: this.stats.cacheHits + this.stats.cacheMisses > 0
        ? ((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100).toFixed(2) + "%"
        : "N/A",
    };
  }

  /**
   * Export graph for debugging
   */
  exportGraph() {
    return {
      pools: Object.fromEntries(this.poolIndex),
      tokens: Object.fromEntries(
        Array.from(this.tokenIndex.entries()).map(([k, v]) => [
          k,
          { ...v, pools: Array.from(v.pools) },
        ])
      ),
      edges: Object.fromEntries(this.adjacencyList),
    };
  }

  /**
   * Clear the entire graph
   */
  clear() {
    this.adjacencyList.clear();
    this.poolIndex.clear();
    this.tokenIndex.clear();
    this.routeCache.clear();
    this.dirtyPools.clear();
    this.stats = {
      totalPools: 0,
      totalTokens: 0,
      totalEdges: 0,
      updateCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
      lastFullRebuild: Date.now(),
      lastIncrementalUpdate: null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ─────────────────────────────────────────────────────────────────────────────

const graphInstance = new IncrementalGraph();

// ─────────────────────────────────────────────────────────────────────────────
// Event Handlers for Real-time Updates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle V2 Sync event
 */
function handleSyncEvent(poolAddress, reserve0, reserve1, dex = "uniswap_v2") {
  const pool = graphInstance.getPool(poolAddress);
  if (pool) {
    graphInstance.addPool({
      poolAddress,
      token0: pool.token0,
      token1: pool.token1,
      dex,
      reserve0,
      reserve1,
      fee: pool.fee,
    });
    logger.debug(`[IncrementalGraph] Updated pool ${poolAddress.slice(0, 10)}... via Sync event`);
  }
}

/**
 * Handle V3 Swap event
 */
function handleV3SwapEvent(poolAddress, sqrtPriceX96, liquidity, dex = "uniswap_v3") {
  const pool = graphInstance.getPool(poolAddress);
  if (pool) {
    graphInstance.addPool({
      poolAddress,
      token0: pool.token0,
      token1: pool.token1,
      dex,
      sqrtPriceX96,
      liquidity,
      fee: pool.fee,
    });
    logger.debug(`[IncrementalGraph] Updated V3 pool ${poolAddress.slice(0, 10)}... via Swap event`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Graph instance
  graph: graphInstance,

  // Graph class for testing/multiple instances
  IncrementalGraph,

  // Event handlers
  handleSyncEvent,
  handleV3SwapEvent,

  // Convenience methods
  addPool: (data) => graphInstance.addPool(data),
  removePool: (addr) => graphInstance.removePool(addr),
  getPool: (addr) => graphInstance.getPool(addr),
  getEdges: (token) => graphInstance.getEdges(token),
  findNegativeCycles: (start, maxHops) => graphInstance.findNegativeCycles(start, maxHops),
  getStats: () => graphInstance.getStats(),
  processDirtyPools: () => graphInstance.processDirtyPools(),
  clear: () => graphInstance.clear(),
};
