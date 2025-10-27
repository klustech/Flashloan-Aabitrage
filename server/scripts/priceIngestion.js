/**
 * server/scripts/priceIngestion.js
 *
 * Provides utilities for keeping a cache of Uniswap/Sushiswap pool reserves.
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

const PAIR_ABI = [
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "function getReserves() view returns (uint112,uint112,uint32)",
];

const DEFAULT_MULTICALL_ADDRESS = "0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696"; // mainnet v2

const reserveCache = new Map();
const subscriptions = new Map();

let provider = null;
let multicall = null;
let providerPromise = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let currentUrls = { ws: null, http: null };

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

  providerPromise = (async () => {
    await new Promise((resolve) => {
      reconnectTimer = setTimeout(resolve, delay);
    });
    reconnectTimer = null;
    try {
      await setProvider(createWebSocketProvider(currentUrls.ws));
      reconnectAttempts = 0;
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
  for (const addr of pools) {
    if (!addr || !ethers.utils.isAddress(addr)) continue;
    if (subscriptions.has(addr)) continue;

    const handler = (r0, r1) => {
      reserveCache.set(addr, {
        reserve0: r0.toString(),
        reserve1: r1.toString(),
        timestamp: Date.now(),
      });
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

module.exports = {
  initSubscriptions,
  reserveCache,
  fetchMulticallReservesForRoute,
};
