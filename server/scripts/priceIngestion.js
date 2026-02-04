/**
 * server/scripts/priceIngestion.js
 *
 * Provides utilities for keeping a cache of DEX pool reserves and prices.
 * Supports Uniswap V2/V3, SushiSwap, Balancer, and Curve pools.
 * The module lazily initialises its provider so simply importing it will not
 * fail when optional environment variables are absent. A descriptive error is
 * thrown the first time a caller tries to use the feature without configuring
 * either MAINNET_WEBSOCKET or MAINNET_RPC_URL.
 */

const { ethers } = require("ethers");
const runtimeConfig = require("../utils/runtimeConfig");

const { optional } = runtimeConfig;

// Simple Multicall contract interface. We only need the aggregate function to
// batch fetch reserves for a list of pools.
const MULTICALL_ABI = [
  "function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)",
];

// Uniswap V2 / SushiSwap Pair ABI
const PAIR_ABI = [
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

// Uniswap V3 Pool ABI
const V3_POOL_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];

// Balancer Vault ABI for pool events
const BALANCER_VAULT_ABI = [
  "event Swap(bytes32 indexed poolId, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
  "event PoolBalanceChanged(bytes32 indexed poolId, address indexed liquidityProvider, address[] tokens, int256[] deltas, uint256[] protocolFeeAmounts)",
  "function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)",
];

// Curve Pool ABI for exchange events
const CURVE_POOL_ABI = [
  "event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)",
  "event TokenExchangeUnderlying(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)",
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function balances(int128 index) view returns (uint256)",
  "function coins(uint256 index) view returns (address)",
];

const DEFAULT_MULTICALL_ADDRESS = "0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696"; // mainnet v2
const BALANCER_VAULT_ADDRESS = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

// Caches for different pool types
const reserveCache = new Map();       // V2 reserves
const v3PriceCache = new Map();       // V3 prices
const balancerCache = new Map();      // Balancer pool balances
const curveCache = new Map();         // Curve pool balances

// Subscription tracking
const subscriptions = new Map();       // V2 subscriptions
const v3Subscriptions = new Map();     // V3 subscriptions
const balancerSubscriptions = new Set(); // Balancer pool IDs
const curveSubscriptions = new Map();  // Curve pool subscriptions

let provider = null;
let multicall = null;
let providerPromise = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let currentUrls = { ws: null, http: null };

// Connection health monitoring
const MAX_RECONNECT_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 15000; // 15 second polling interval when WS unavailable
const STALE_THRESHOLD_MS = 60000; // Data considered stale after 60 seconds
let pollIntervalId = null;
let connectionMode = "none"; // "websocket", "polling", "none"
let lastSuccessfulFetch = 0;
let healthCheckIntervalId = null;

const multicallAddress = optional("MULTICALL_ADDRESS").string(
  DEFAULT_MULTICALL_ADDRESS
);

function getConnectionUrls() {
  return {
    ws: optional("MAINNET_WEBSOCKET").string(),
    http: optional("MAINNET_RPC_URL").string(),
  };
}

function clearActiveContracts() {
  for (const entry of subscriptions.values()) {
    if (entry.contract) {
      entry.contract.removeAllListeners();
      entry.contract = null;
    }
  }
}

async function rebuildSubscriptions() {
  if (!provider) return;
  for (const [addr, entry] of subscriptions.entries()) {
    const contract = new ethers.Contract(addr, PAIR_ABI, provider);
    contract.on("Sync", entry.handler);
    entry.contract = contract;
    try {
      const [reserve0, reserve1] = await contract.getReserves();
      entry.handler(reserve0, reserve1);
    } catch (err) {
      console.warn(
        `[priceIngestion] Failed to fetch initial reserves for ${addr}: ${
          err?.message || err
        }`
      );
    }
  }
}

function createWebSocketProvider(url) {
  const wsProvider = new ethers.providers.WebSocketProvider(url);
  attachWebSocketHandlers(wsProvider);
  return wsProvider;
}

function attachWebSocketHandlers(wsProvider) {
  if (!wsProvider?._websocket) return;
  const ws = wsProvider._websocket;

  ws.on("open", () => {
    reconnectAttempts = 0;
  });

  ws.on("error", (err) => {
    console.warn(
      `[priceIngestion] WebSocket error: ${err?.message || err || "unknown"}`
    );
  });

  ws.on("close", (code) => {
    console.warn(
      `[priceIngestion] WebSocket closed (${code}). Scheduling reconnect.`,
    );
    provider = null;
    multicall = null;
    clearActiveContracts();
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (!currentUrls.ws) {
    // No WebSocket URL, fall back to polling immediately
    startPollingFallback();
    return null;
  }
  if (providerPromise) {
    return providerPromise;
  }

  reconnectAttempts += 1;
  const delay = Math.min(1000 * 2 ** (reconnectAttempts - 1), 30_000);
  console.warn(
    `[priceIngestion] Attempting WebSocket reconnect in ${delay}ms (attempt ${reconnectAttempts}).`
  );

  // If we've exceeded max reconnect attempts, fall back to polling
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.warn(
      `[priceIngestion] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded. Falling back to HTTP polling.`
    );
    startPollingFallback();
    reconnectAttempts = 0;
    return null;
  }

  providerPromise = (async () => {
    await new Promise((resolve) => {
      reconnectTimer = setTimeout(resolve, delay);
    });
    reconnectTimer = null;
    try {
      await setProvider(createWebSocketProvider(currentUrls.ws));
      reconnectAttempts = 0;
      connectionMode = "websocket";
      stopPollingFallback(); // Stop polling if it was running
      const activeProvider = provider;
      providerPromise = null;
      return activeProvider;
    } catch (err) {
      console.warn(
        `[priceIngestion] WebSocket reconnect failed: ${err?.message || err}`
      );
      providerPromise = null;
      return scheduleReconnect();
    }
  })();

  return providerPromise;
}

/**
 * Start HTTP polling fallback when WebSocket is unavailable
 */
function startPollingFallback() {
  if (pollIntervalId) return; // Already polling
  if (!currentUrls.http) {
    console.error("[priceIngestion] No HTTP RPC URL available for polling fallback");
    return;
  }

  connectionMode = "polling";
  console.info(`[priceIngestion] Starting HTTP polling fallback (interval: ${POLL_INTERVAL_MS}ms)`);

  // Create HTTP provider if needed
  if (!provider) {
    provider = new ethers.providers.JsonRpcProvider({
      url: currentUrls.http,
      timeout: 30_000,
    });
    multicall = new ethers.Contract(multicallAddress, MULTICALL_ABI, provider);
  }

  pollIntervalId = setInterval(async () => {
    try {
      await pollAllCaches();
      lastSuccessfulFetch = Date.now();
    } catch (err) {
      console.warn(`[priceIngestion] Polling error: ${err?.message || err}`);
    }
  }, POLL_INTERVAL_MS);

  // Do an immediate poll
  pollAllCaches().catch(console.warn);

  // Also try to reconnect WebSocket in the background
  if (currentUrls.ws && !providerPromise) {
    setTimeout(() => scheduleReconnect(), 60_000); // Try WS again after 1 minute
  }
}

/**
 * Stop HTTP polling fallback
 */
function stopPollingFallback() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
    console.info("[priceIngestion] Stopped HTTP polling fallback (WebSocket reconnected)");
  }
}

/**
 * Poll all cached pools via HTTP
 */
async function pollAllCaches() {
  const activeProvider = provider;
  if (!activeProvider) return;

  // Poll V2 reserves
  const v2Pools = Array.from(subscriptions.keys());
  if (v2Pools.length > 0) {
    await batchFetchV2Reserves(v2Pools);
  }

  // Poll V3 pools
  const v3Pools = Array.from(v3Subscriptions.keys());
  if (v3Pools.length > 0) {
    await fetchV3PoolStates(v3Pools);
  }

  // Poll Balancer pools
  const balancerPools = Array.from(balancerSubscriptions);
  if (balancerPools.length > 0) {
    await fetchBalancerPoolBalances(balancerPools);
  }
}

/**
 * Batch fetch V2 reserves via multicall
 */
async function batchFetchV2Reserves(pools) {
  if (!multicall || pools.length === 0) return;

  const pairInterface = new ethers.utils.Interface(PAIR_ABI);
  const calls = pools.map(addr => ({
    target: addr,
    callData: pairInterface.encodeFunctionData("getReserves"),
  }));

  try {
    const [, returnData] = await multicall.aggregate(calls);
    returnData.forEach((data, i) => {
      try {
        const [r0, r1] = pairInterface.decodeFunctionResult("getReserves", data);
        reserveCache.set(pools[i], {
          reserve0: r0.toString(),
          reserve1: r1.toString(),
          timestamp: Date.now(),
        });
      } catch {
        // Individual decode failure, skip
      }
    });
  } catch (err) {
    console.warn(`[priceIngestion] Batch V2 fetch failed: ${err?.message}`);
  }
}

/**
 * Start connection health monitoring
 */
function startHealthMonitoring() {
  if (healthCheckIntervalId) return;

  healthCheckIntervalId = setInterval(() => {
    const now = Date.now();
    const stats = getSubscriptionStats();
    const totalCached = stats.v2.cached + stats.v3.cached + stats.balancer.cached + stats.curve.cached;

    // Check if data is stale
    if (totalCached > 0 && lastSuccessfulFetch > 0) {
      const staleness = now - lastSuccessfulFetch;
      if (staleness > STALE_THRESHOLD_MS) {
        console.warn(
          `[priceIngestion] Data may be stale (${Math.round(staleness / 1000)}s since last update). Mode: ${connectionMode}`
        );

        // If in WebSocket mode but stale, try polling
        if (connectionMode === "websocket") {
          console.warn("[priceIngestion] Switching to polling due to stale data");
          startPollingFallback();
        }
      }
    }
  }, 30_000); // Check every 30 seconds
}

/**
 * Stop health monitoring
 */
function stopHealthMonitoring() {
  if (healthCheckIntervalId) {
    clearInterval(healthCheckIntervalId);
    healthCheckIntervalId = null;
  }
}

/**
 * Get current connection status
 */
function getConnectionStatus() {
  const now = Date.now();
  const staleness = lastSuccessfulFetch > 0 ? now - lastSuccessfulFetch : null;

  return {
    mode: connectionMode,
    isConnected: connectionMode !== "none",
    reconnectAttempts,
    lastSuccessfulFetch: lastSuccessfulFetch > 0 ? new Date(lastSuccessfulFetch).toISOString() : null,
    stalenessMs: staleness,
    isStale: staleness !== null && staleness > STALE_THRESHOLD_MS,
    urls: {
      wsConfigured: !!currentUrls.ws,
      httpConfigured: !!currentUrls.http,
    },
  };
}

async function setProvider(newProvider) {
  provider = newProvider;
  multicall = new ethers.Contract(multicallAddress, MULTICALL_ABI, provider);
  await rebuildSubscriptions();
  return provider;
}

async function ensureProvider() {
  if (provider) return provider;
  if (providerPromise) return providerPromise;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  currentUrls = getConnectionUrls();
  if (!currentUrls.ws && !currentUrls.http) {
    throw new Error(
      "Price ingestion requires MAINNET_WEBSOCKET or MAINNET_RPC_URL; set at least one before enabling pool monitoring."
    );
  }

  if (currentUrls.ws) {
    providerPromise = setProvider(createWebSocketProvider(currentUrls.ws));
  } else {
    providerPromise = setProvider(
      new ethers.providers.JsonRpcProvider({
        url: currentUrls.http,
        timeout: 120_000,
      })
    );
  }

  try {
    await providerPromise;
    return provider;
  } finally {
    providerPromise = null;
  }
}

async function ensureMulticall() {
  await ensureProvider();
  return multicall;
}

/**
 * initSubscriptions – subscribe to Sync events for a set of pools.
 *
 * @param {string[]} pools  – List of pool addresses to subscribe to.
 */
async function initSubscriptions(pools) {
  const activeProvider = await ensureProvider();
  connectionMode = currentUrls.ws ? "websocket" : "polling";
  startHealthMonitoring();

  for (const addr of pools) {
    if (!addr || !ethers.utils.isAddress(addr)) continue;
    if (subscriptions.has(addr)) continue;

    const handler = (r0, r1) => {
      reserveCache.set(addr, {
        reserve0: r0.toString(),
        reserve1: r1.toString(),
        timestamp: Date.now(),
      });
      lastSuccessfulFetch = Date.now();
    };

    const contract = new ethers.Contract(addr, PAIR_ABI, activeProvider);
    contract.on("Sync", handler);
    subscriptions.set(addr, { handler, contract });

    try {
      const [reserve0, reserve1] = await contract.getReserves();
      handler(reserve0, reserve1);
    } catch (err) {
      console.warn(
        `[priceIngestion] Failed to fetch initial reserves for ${addr}: ${
          err?.message || err
        }`
      );
    }
  }
}

/**
 * fetchMulticallReservesForRoute – fetch reserves for a pool or route.
 *
 * @param {Object|string|Array} routeOrPoolInfo – Route or pool details.
 */
async function fetchMulticallReservesForRoute(routeOrPoolInfo) {
  const activeMulticall = await ensureMulticall();

  if (Array.isArray(routeOrPoolInfo)) {
    for (const hop of routeOrPoolInfo) {
      await fetchMulticallReservesForRoute(hop);
    }
    return;
  }

  const poolAddress = routeOrPoolInfo.poolAddress || routeOrPoolInfo;
  if (!poolAddress || !ethers.utils.isAddress(poolAddress)) {
    console.warn(
      `Multicall skipped for invalid pool address: ${JSON.stringify(
        routeOrPoolInfo
      )}`
    );
    return;
  }

  const pairInterface = new ethers.utils.Interface(PAIR_ABI);
  const callData = pairInterface.encodeFunctionData("getReserves");
  try {
    const [, returnData] = await activeMulticall.aggregate([[
      poolAddress,
      callData,
    ]]);
    const [r0, r1] = pairInterface.decodeFunctionResult(
      "getReserves",
      returnData[0]
    );
    reserveCache.set(poolAddress, {
      reserve0: r0.toString(),
      reserve1: r1.toString(),
      timestamp: Date.now(),
    });
  } catch (err) {
    console.warn(`Multicall failed for ${poolAddress}: ${err?.message || err}`);
  }
}

/**
 * Subscribe to V3 pool Swap events
 * @param {string[]} pools - List of V3 pool addresses
 */
async function initV3Subscriptions(pools) {
  const activeProvider = await ensureProvider();

  for (const addr of pools) {
    if (!addr || !ethers.utils.isAddress(addr)) continue;
    if (v3Subscriptions.has(addr)) continue;

    const handler = (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick) => {
      v3PriceCache.set(addr, {
        sqrtPriceX96: sqrtPriceX96.toString(),
        liquidity: liquidity.toString(),
        tick,
        lastSwap: {
          amount0: amount0.toString(),
          amount1: amount1.toString(),
        },
        timestamp: Date.now(),
      });
      lastSuccessfulFetch = Date.now();
    };

    const contract = new ethers.Contract(addr, V3_POOL_ABI, activeProvider);
    contract.on("Swap", handler);
    v3Subscriptions.set(addr, { handler, contract });

    // Fetch initial state
    try {
      const [slot0, liquidity] = await Promise.all([
        contract.slot0(),
        contract.liquidity(),
      ]);
      v3PriceCache.set(addr, {
        sqrtPriceX96: slot0.sqrtPriceX96.toString(),
        liquidity: liquidity.toString(),
        tick: slot0.tick,
        lastSwap: null,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn(
        `[priceIngestion] Failed to fetch initial V3 state for ${addr}: ${
          err?.message || err
        }`
      );
    }
  }
}

/**
 * Subscribe to Balancer Vault Swap events for specific pool IDs
 * @param {string[]} poolIds - List of Balancer pool IDs (bytes32)
 */
async function initBalancerSubscriptions(poolIds) {
  const activeProvider = await ensureProvider();

  // Only set up vault listener once
  if (balancerSubscriptions.size === 0 && poolIds.length > 0) {
    const vault = new ethers.Contract(BALANCER_VAULT_ADDRESS, BALANCER_VAULT_ABI, activeProvider);

    vault.on("Swap", (poolId, tokenIn, tokenOut, amountIn, amountOut) => {
      if (balancerSubscriptions.has(poolId)) {
        const existing = balancerCache.get(poolId) || {};
        balancerCache.set(poolId, {
          ...existing,
          lastSwap: {
            tokenIn,
            tokenOut,
            amountIn: amountIn.toString(),
            amountOut: amountOut.toString(),
          },
          timestamp: Date.now(),
        });
      }
    });
  }

  // Register pool IDs for filtering
  for (const poolId of poolIds) {
    balancerSubscriptions.add(poolId);

    // Fetch initial balances
    if (!balancerCache.has(poolId)) {
      try {
        const vault = new ethers.Contract(BALANCER_VAULT_ADDRESS, BALANCER_VAULT_ABI, activeProvider);
        const { tokens, balances } = await vault.getPoolTokens(poolId);
        balancerCache.set(poolId, {
          tokens,
          balances: balances.map(b => b.toString()),
          lastSwap: null,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.warn(
          `[priceIngestion] Failed to fetch Balancer pool ${poolId}: ${err?.message || err}`
        );
      }
    }
  }
}

/**
 * Subscribe to Curve pool exchange events
 * @param {string[]} pools - List of Curve pool addresses
 */
async function initCurveSubscriptions(pools) {
  const activeProvider = await ensureProvider();

  for (const addr of pools) {
    if (!addr || !ethers.utils.isAddress(addr)) continue;
    if (curveSubscriptions.has(addr)) continue;

    const handler = (buyer, soldId, tokensSold, boughtId, tokensBought) => {
      const existing = curveCache.get(addr) || {};
      curveCache.set(addr, {
        ...existing,
        lastExchange: {
          soldId: soldId.toString(),
          tokensSold: tokensSold.toString(),
          boughtId: boughtId.toString(),
          tokensBought: tokensBought.toString(),
        },
        timestamp: Date.now(),
      });
    };

    const contract = new ethers.Contract(addr, CURVE_POOL_ABI, activeProvider);
    contract.on("TokenExchange", handler);
    contract.on("TokenExchangeUnderlying", handler);
    curveSubscriptions.set(addr, { handler, contract });

    // Fetch initial balances
    try {
      const balances = [];
      for (let i = 0; i < 8; i++) {
        try {
          const bal = await contract.balances(i);
          balances.push(bal.toString());
        } catch {
          break;
        }
      }
      curveCache.set(addr, {
        balances,
        lastExchange: null,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn(
        `[priceIngestion] Failed to fetch Curve balances for ${addr}: ${err?.message || err}`
      );
    }
  }
}

/**
 * Get cached V3 price data
 * @param {string} poolAddress - V3 pool address
 * @returns {Object|null} - Cached price data or null
 */
function getV3Price(poolAddress) {
  return v3PriceCache.get(poolAddress) || null;
}

/**
 * Get cached Balancer pool data
 * @param {string} poolId - Balancer pool ID
 * @returns {Object|null} - Cached pool data or null
 */
function getBalancerPoolData(poolId) {
  return balancerCache.get(poolId) || null;
}

/**
 * Get cached Curve pool data
 * @param {string} poolAddress - Curve pool address
 * @returns {Object|null} - Cached pool data or null
 */
function getCurvePoolData(poolAddress) {
  return curveCache.get(poolAddress) || null;
}

/**
 * Fetch V3 pool state via multicall
 * @param {string[]} pools - V3 pool addresses
 */
async function fetchV3PoolStates(pools) {
  const activeProvider = await ensureProvider();

  for (const addr of pools) {
    if (!addr || !ethers.utils.isAddress(addr)) continue;

    try {
      const contract = new ethers.Contract(addr, V3_POOL_ABI, activeProvider);
      const [slot0, liquidity] = await Promise.all([
        contract.slot0(),
        contract.liquidity(),
      ]);

      v3PriceCache.set(addr, {
        sqrtPriceX96: slot0.sqrtPriceX96.toString(),
        liquidity: liquidity.toString(),
        tick: slot0.tick,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn(`[priceIngestion] V3 state fetch failed for ${addr}: ${err?.message}`);
    }
  }
}

/**
 * Fetch Balancer pool balances
 * @param {string[]} poolIds - Balancer pool IDs
 */
async function fetchBalancerPoolBalances(poolIds) {
  const activeProvider = await ensureProvider();
  const vault = new ethers.Contract(BALANCER_VAULT_ADDRESS, BALANCER_VAULT_ABI, activeProvider);

  for (const poolId of poolIds) {
    try {
      const { tokens, balances } = await vault.getPoolTokens(poolId);
      balancerCache.set(poolId, {
        tokens,
        balances: balances.map(b => b.toString()),
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn(`[priceIngestion] Balancer fetch failed for ${poolId}: ${err?.message}`);
    }
  }
}

/**
 * Clear all subscriptions and caches (useful for testing/reset)
 */
function clearAllSubscriptions() {
  // Clear V2
  for (const entry of subscriptions.values()) {
    if (entry.contract) {
      entry.contract.removeAllListeners();
    }
  }
  subscriptions.clear();
  reserveCache.clear();

  // Clear V3
  for (const entry of v3Subscriptions.values()) {
    if (entry.contract) {
      entry.contract.removeAllListeners();
    }
  }
  v3Subscriptions.clear();
  v3PriceCache.clear();

  // Clear Balancer
  balancerSubscriptions.clear();
  balancerCache.clear();

  // Clear Curve
  for (const entry of curveSubscriptions.values()) {
    if (entry.contract) {
      entry.contract.removeAllListeners();
    }
  }
  curveSubscriptions.clear();
  curveCache.clear();
}

/**
 * Get statistics about active subscriptions
 * @returns {Object} - Subscription counts and cache sizes
 */
function getSubscriptionStats() {
  return {
    v2: {
      subscriptions: subscriptions.size,
      cached: reserveCache.size,
    },
    v3: {
      subscriptions: v3Subscriptions.size,
      cached: v3PriceCache.size,
    },
    balancer: {
      subscriptions: balancerSubscriptions.size,
      cached: balancerCache.size,
    },
    curve: {
      subscriptions: curveSubscriptions.size,
      cached: curveCache.size,
    },
  };
}

module.exports = {
  // V2 functions
  initSubscriptions,
  reserveCache,
  fetchMulticallReservesForRoute,

  // V3 functions
  initV3Subscriptions,
  v3PriceCache,
  getV3Price,
  fetchV3PoolStates,

  // Balancer functions
  initBalancerSubscriptions,
  balancerCache,
  getBalancerPoolData,
  fetchBalancerPoolBalances,

  // Curve functions
  initCurveSubscriptions,
  curveCache,
  getCurvePoolData,

  // Utility functions
  clearAllSubscriptions,
  getSubscriptionStats,

  // Connection health and fallback
  getConnectionStatus,
  startHealthMonitoring,
  stopHealthMonitoring,
  startPollingFallback,
  stopPollingFallback,

  // ABIs for external use
  PAIR_ABI,
  V3_POOL_ABI,
  BALANCER_VAULT_ABI,
  CURVE_POOL_ABI,
};
