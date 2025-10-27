/**
 * server/scripts/priceIngestion.js
 *
 * Provides utilities for keeping a cache of Uniswap/Sushiswap pool reserves.
 *
 * The module exports a factory so callers can customise provider behaviour, but also
 * exposes a default singleton that is configured via environment variables.  The
 * factory builds providers with retry/backoff semantics, emits reconnect events, and
 * keeps an in-memory connection state for monitoring.
 */

const { ethers } = require("ethers");
const { EventEmitter } = require("events");
const { getEnv } = require("../../utils/config");
const {
  reserveIngestionFailures,
  reserveIngestionReconnects,
  reserveIngestionConnectionState,
  reserveIngestionEnabled,
} = require("../metricsRegistry");

const MULTICALL_ABI = [
  "function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)",
];

const PAIR_ABI = [
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "function getReserves() view returns (uint112,uint112,uint32)",
];

const DEFAULT_MULTICALL_ADDRESS = "0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696";

const parseBoolean = (value, defaultValue) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return defaultValue;
};

function createPriceIngestion(options = {}) {
  const events = new EventEmitter();
  const reserveCache = new Map();
  const subscriptions = new Map();
  const trackedPools = new Set();

  const settings = {
    wsUrl: options.wsUrl ?? getEnv("MAINNET_WEBSOCKET"),
    rpcUrl: options.rpcUrl ?? getEnv("MAINNET_RPC_URL"),
    multicallAddress:
      options.multicallAddress ??
      getEnv("MULTICALL_ADDRESS", DEFAULT_MULTICALL_ADDRESS),
    enableLiveReserves:
      typeof options.enableLiveReserves === "boolean"
        ? options.enableLiveReserves
        : parseBoolean(getEnv("ENABLE_LIVE_RESERVE_INGESTION", "true"), true),
    reconnect: {
      initialDelayMs:
        options.reconnect?.initialDelayMs ??
        Number(getEnv("RESERVE_INGESTION_BACKOFF_INITIAL_MS", "1000")),
      maxDelayMs:
        options.reconnect?.maxDelayMs ??
        Number(getEnv("RESERVE_INGESTION_BACKOFF_MAX_MS", "30000")),
      multiplier:
        options.reconnect?.multiplier ??
        Number(getEnv("RESERVE_INGESTION_BACKOFF_MULTIPLIER", "2")),
    },
  };

  settings.reconnect.initialDelayMs = Number.isFinite(settings.reconnect.initialDelayMs)
    ? Math.max(100, settings.reconnect.initialDelayMs)
    : 1000;
  settings.reconnect.maxDelayMs = Number.isFinite(settings.reconnect.maxDelayMs)
    ? Math.max(settings.reconnect.initialDelayMs, settings.reconnect.maxDelayMs)
    : 30000;
  settings.reconnect.multiplier = Number.isFinite(settings.reconnect.multiplier)
    ? Math.max(1.1, settings.reconnect.multiplier)
    : 2;

  const connectionState = {
    status: settings.enableLiveReserves ? "disconnected" : "disabled",
    providerType: settings.enableLiveReserves
      ? settings.wsUrl
        ? "websocket"
        : settings.rpcUrl
        ? "jsonrpc"
        : "none"
      : "disabled",
    attempts: 0,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastError: null,
  };

  reserveIngestionEnabled.set(settings.enableLiveReserves ? 1 : 0);
  let lastGaugeLabel = connectionState.providerType || "none";
  reserveIngestionConnectionState.labels(lastGaugeLabel).set(0);

  let provider = null;
  let multicall = null;
  let reconnectTimer = null;
  let cleanupProviderListeners = () => {};

  const normalizeAddress = (addr) => {
    if (!addr) return null;
    try {
      return ethers.utils.getAddress(addr);
    } catch (err) {
      return null;
    }
  };

  const updateConnectionState = (partial) => {
    Object.assign(connectionState, partial);
  };

  const updateConnectionGauge = (connected) => {
    const label = connectionState.providerType || "none";
    if (lastGaugeLabel !== label) {
      reserveIngestionConnectionState.labels(lastGaugeLabel).set(0);
      lastGaugeLabel = label;
    }
    reserveIngestionConnectionState.labels(label).set(connected ? 1 : 0);
  };

  const cleanupSubscriptions = () => {
    for (const { contract, handler } of subscriptions.values()) {
      try {
        contract.off("Sync", handler);
      } catch (err) {
        // best-effort cleanup
      }
    }
    subscriptions.clear();
  };

  const createSyncHandler = (poolAddress) => (reserve0, reserve1) => {
    reserveCache.set(poolAddress, {
      reserve0: reserve0.toString(),
      reserve1: reserve1.toString(),
      timestamp: Date.now(),
    });
  };

  const subscribeToTrackedPools = async (poolsToEnsure = Array.from(trackedPools)) => {
    if (!settings.enableLiveReserves || !provider) {
      return;
    }

    for (const pool of poolsToEnsure) {
      const normalized = normalizeAddress(pool);
      if (!normalized) {
        reserveIngestionFailures.labels("invalid_pool").inc();
        continue;
      }
      if (subscriptions.has(normalized)) continue;

      const handler = createSyncHandler(normalized);
      try {
        const contract = new ethers.Contract(normalized, PAIR_ABI, provider);
        contract.on("Sync", handler);
        subscriptions.set(normalized, { contract, handler });
        try {
          const [reserve0, reserve1] = await contract.getReserves();
          handler(reserve0, reserve1);
        } catch (err) {
          reserveIngestionFailures.labels("initial_reserve_fetch").inc();
          events.emit("initial_reserve_fetch_failed", {
            pool: normalized,
            error: err,
          });
        }
      } catch (err) {
        reserveIngestionFailures.labels("subscription_error").inc();
        events.emit("subscription_error", { pool: normalized, error: err });
      }
    }
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (error, attempt = connectionState.attempts || 0) => {
    if (!settings.enableLiveReserves) return;

    clearReconnectTimer();
    cleanupProviderListeners();
    cleanupProviderListeners = () => {};
    cleanupSubscriptions();
    provider = null;
    multicall = null;

    const nextAttempt = attempt + 1;
    const delay = Math.min(
      settings.reconnect.initialDelayMs * settings.reconnect.multiplier ** attempt,
      settings.reconnect.maxDelayMs
    );

    updateConnectionState({
      status: "reconnecting",
      attempts: nextAttempt,
      lastError: error ? error.message || String(error) : null,
      lastDisconnectedAt: Date.now(),
    });
    updateConnectionGauge(false);
    events.emit("reconnecting", {
      providerType: connectionState.providerType,
      attempt: nextAttempt,
      delay,
      error,
    });

    reconnectTimer = setTimeout(() => {
      buildProvider(nextAttempt).catch((err) => {
        reserveIngestionFailures.labels("provider_init").inc();
        scheduleReconnect(err, nextAttempt);
      });
    }, delay);
  };

  const buildJsonProvider = (isFallback = false) => {
    if (!settings.rpcUrl) {
      return null;
    }

    cleanupProviderListeners();
    cleanupProviderListeners = () => {};
    provider = new ethers.providers.JsonRpcProvider(settings.rpcUrl);
    multicall = new ethers.Contract(
      settings.multicallAddress,
      MULTICALL_ABI,
      provider
    );

    const firstConnection = connectionState.lastConnectedAt === null;
    updateConnectionState({
      status: "connected",
      providerType: "jsonrpc",
      attempts: 0,
      lastConnectedAt: Date.now(),
      lastError: null,
    });
    updateConnectionGauge(true);
    subscribeToTrackedPools();
    events.emit(firstConnection ? "connected" : "reconnected", {
      providerType: "jsonrpc",
      fallback: isFallback,
    });
    if (!firstConnection) {
      reserveIngestionReconnects.labels("jsonrpc").inc();
    }
    return provider;
  };

  const buildProvider = async (attempt = 0) => {
    if (!settings.enableLiveReserves) {
      updateConnectionState({ status: "disabled", providerType: "disabled" });
      updateConnectionGauge(false);
      return null;
    }

    clearReconnectTimer();

    if (settings.wsUrl) {
      try {
        cleanupProviderListeners();
        const wsProvider = new ethers.providers.WebSocketProvider(settings.wsUrl);
        provider = wsProvider;
        multicall = new ethers.Contract(
          settings.multicallAddress,
          MULTICALL_ABI,
          provider
        );

        updateConnectionState({
          status: "connecting",
          providerType: "websocket",
          attempts: attempt,
        });
        updateConnectionGauge(false);

        const ws = wsProvider._websocket;
        if (ws && typeof ws.on === "function") {
          const handleOpen = () => {
            const firstConnection = connectionState.lastConnectedAt === null;
            updateConnectionState({
              status: "connected",
              attempts: 0,
              lastConnectedAt: Date.now(),
              lastError: null,
            });
            updateConnectionGauge(true);
            subscribeToTrackedPools();
            events.emit(firstConnection ? "connected" : "reconnected", {
              providerType: "websocket",
            });
            if (!firstConnection) {
              reserveIngestionReconnects.labels("websocket").inc();
            }
          };

          const handleClose = (code) => {
            reserveIngestionFailures.labels("provider_close").inc();
            updateConnectionState({
              status: "disconnected",
              lastDisconnectedAt: Date.now(),
              lastError: `close ${code}`,
            });
            updateConnectionGauge(false);
            events.emit("disconnected", { providerType: "websocket", code });
            scheduleReconnect(new Error(`WebSocket closed with code ${code}`), attempt);
          };

          const handleError = (err) => {
            reserveIngestionFailures.labels("provider_error").inc();
            updateConnectionState({
              status: "error",
              lastError: err ? err.message || String(err) : "unknown",
            });
            updateConnectionGauge(false);
            events.emit("error", { providerType: "websocket", error: err });
            scheduleReconnect(err, attempt);
          };

          ws.on("open", handleOpen);
          ws.on("close", handleClose);
          ws.on("error", handleError);

          cleanupProviderListeners = () => {
            if (typeof ws.removeListener === "function") {
              ws.removeListener("open", handleOpen);
              ws.removeListener("close", handleClose);
              ws.removeListener("error", handleError);
            } else if (typeof ws.off === "function") {
              ws.off("open", handleOpen);
              ws.off("close", handleClose);
              ws.off("error", handleError);
            }
          };
        } else {
          const firstConnection = connectionState.lastConnectedAt === null;
          updateConnectionState({
            status: "connected",
            attempts: 0,
            lastConnectedAt: Date.now(),
            lastError: null,
          });
          updateConnectionGauge(true);
          subscribeToTrackedPools();
          events.emit(firstConnection ? "connected" : "reconnected", {
            providerType: "websocket",
          });
          if (!firstConnection) {
            reserveIngestionReconnects.labels("websocket").inc();
          }
        }
        return provider;
      } catch (err) {
        reserveIngestionFailures.labels("provider_init").inc();
        events.emit("error", { providerType: "websocket", error: err });
        if (settings.rpcUrl) {
          return buildJsonProvider(true);
        }
        scheduleReconnect(err, attempt);
        return null;
      }
    }

    if (settings.rpcUrl) {
      return buildJsonProvider(false);
    }

    reserveIngestionFailures.labels("provider_unavailable").inc();
    updateConnectionState({
      status: "unavailable",
      providerType: "none",
      lastError: "no provider configured",
    });
    updateConnectionGauge(false);
    events.emit("provider_unavailable", { reason: "no provider configured" });
    return null;
  };

  const initSubscriptions = async (pools = []) => {
    const validPools = [];
    for (const pool of pools) {
      const normalized = normalizeAddress(pool);
      if (!normalized) {
        reserveIngestionFailures.labels("invalid_pool").inc();
        events.emit("invalid_pool", { pool });
        continue;
      }
      trackedPools.add(normalized);
      validPools.push(normalized);
    }

    if (!settings.enableLiveReserves) {
      return false;
    }

    if (!provider) {
      reserveIngestionFailures.labels("provider_unavailable").inc();
      events.emit("provider_unavailable", {
        reason: "provider unavailable",
        pools: validPools,
      });
      return false;
    }

    await subscribeToTrackedPools(validPools);
    return validPools.length > 0;
  };

  const fetchMulticallReservesForRoute = async (routeOrPoolInfo) => {
    if (Array.isArray(routeOrPoolInfo)) {
      const results = [];
      for (const hop of routeOrPoolInfo) {
        const hopResult = await fetchMulticallReservesForRoute(hop);
        if (hopResult) {
          results.push(hopResult);
        }
      }
      return results;
    }

    const poolAddress =
      (routeOrPoolInfo && routeOrPoolInfo.poolAddress) || routeOrPoolInfo;
    const normalized = normalizeAddress(poolAddress);
    if (!normalized) {
      reserveIngestionFailures.labels("invalid_pool").inc();
      events.emit("invalid_pool", { pool: poolAddress });
      return null;
    }

    if (!settings.enableLiveReserves) {
      return reserveCache.get(normalized) || null;
    }

    if (!multicall) {
      reserveIngestionFailures.labels("provider_unavailable").inc();
      events.emit("provider_unavailable", {
        reason: "multicall unavailable",
        pool: normalized,
      });
      return reserveCache.get(normalized) || null;
    }

    const pairInterface = new ethers.utils.Interface(PAIR_ABI);
    const callData = pairInterface.encodeFunctionData("getReserves");
    try {
      const [, returnData] = await multicall.aggregate([[normalized, callData]]);
      const [r0, r1] = pairInterface.decodeFunctionResult(
        "getReserves",
        returnData[0]
      );
      const entry = {
        reserve0: r0.toString(),
        reserve1: r1.toString(),
        timestamp: Date.now(),
      };
      reserveCache.set(normalized, entry);
      return entry;
    } catch (err) {
      reserveIngestionFailures.labels("multicall_error").inc();
      events.emit("multicall_error", { pool: normalized, error: err });
      return reserveCache.get(normalized) || null;
    }
  };

  const getProvider = () => provider;
  const getConnectionState = () => ({ ...connectionState });
  const isLiveEnabled = () => settings.enableLiveReserves;

  if (settings.enableLiveReserves) {
    buildProvider().catch((err) => {
      reserveIngestionFailures.labels("provider_init").inc();
      events.emit("error", { providerType: connectionState.providerType, error: err });
      scheduleReconnect(err, 0);
    });
  } else {
    updateConnectionState({ status: "disabled", providerType: "disabled" });
    updateConnectionGauge(false);
  }

  return {
    initSubscriptions,
    reserveCache,
    fetchMulticallReservesForRoute,
    events,
    getProvider,
    getConnectionState,
    isLiveEnabled,
  };
}

const defaultInstance = createPriceIngestion();

module.exports = {
  ...defaultInstance,
  createPriceIngestion,
};
