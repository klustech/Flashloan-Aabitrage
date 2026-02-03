// frontend/src/services/api.js

import axios from "axios";
import {
  settingsResponseSchema,
  settingsUpdateSchema,
} from "../validation/settingsSchema";

const API_BASE_URL =
  process.env.REACT_APP_API_BASE_URL || "http://localhost:3001";
const STATIC_API_KEY = process.env.REACT_APP_API_KEY;
const STATIC_BEARER_TOKEN = process.env.REACT_APP_API_BEARER_TOKEN;

export const API = axios.create({
  baseURL: API_BASE_URL,
});

const API_KEY = process.env.REACT_APP_API_KEY;

if (API_KEY) {
  API.interceptors.request.use((config) => {
    const nextConfig = { ...config };
    nextConfig.headers = nextConfig.headers ?? {};
    if (!nextConfig.headers["x-api-key"]) {
      nextConfig.headers["x-api-key"] = API_KEY;
    }
    return nextConfig;
  });
}
let authTokenProvider = null;
let unauthorizedHandler = null;

const getHeader = (headers, key) => {
  if (!headers) return undefined;
  if (typeof headers.get === "function") {
    return headers.get(key);
  }
  const headerKey = Object.keys(headers).find(
    (headerName) => headerName.toLowerCase() === key.toLowerCase()
  );
  return headerKey ? headers[headerKey] : undefined;
};

const setHeader = (config, key, value) => {
  if (!value) return;
  if (!config.headers) {
    config.headers = {};
  }

  if (typeof config.headers.set === "function") {
    if (!config.headers.get || !config.headers.get(key)) {
      config.headers.set(key, value);
    }
  } else {
    const existing = getHeader(config.headers, key);
    if (!existing) {
      config.headers = { ...config.headers, [key]: value };
    }
  }
};

API.interceptors.request.use(async (config) => {
  if (STATIC_API_KEY) {
    setHeader(config, "x-api-key", STATIC_API_KEY);
  }

  if (authTokenProvider) {
    try {
      const token = await authTokenProvider();
      if (token) {
        setHeader(config, "Authorization", `Bearer ${token}`);
      }
    } catch (error) {
      console.warn("Failed to acquire auth token", error);
    }
  } else if (STATIC_BEARER_TOKEN) {
    setHeader(config, "Authorization", `Bearer ${STATIC_BEARER_TOKEN}`);
  }

  return config;
});

API.interceptors.response.use(
  (response) => response,
  (error) => {
    if (
      error?.response?.status === 401 &&
      typeof unauthorizedHandler === "function"
    ) {
      unauthorizedHandler(error);
    }
    return Promise.reject(error);
  }
);

export const setAuthTokenProvider = (provider) => {
  authTokenProvider = typeof provider === "function" ? provider : null;
};

export const setUnauthorizedHandler = (handler) => {
  unauthorizedHandler = typeof handler === "function" ? handler : null;
};

// Market Data
export const getCurrentPrices = async () => {
  const response = await API.get("/api/market-data");
  return response.data;
};

// Trigger arbitrage route
export const triggerArbitrage = async () => {
  const response = await API.post("/api/trigger-arbitrage");
  return response.data;
};

// Fetch bot logs
/**
 * Fetch a paginated slice of bot logs.
 *
 * @param {Object} options
 * @param {number} [options.offset=0] - Line offset (0-indexed) to start reading from.
 * @param {number} [options.limit=100] - Maximum number of log lines to return (capped server-side).
 * @param {string} [options.file="bot.log"] - Optional log filename relative to the project root.
 * @returns {Promise<{logs: string[], offset: number, limit: number, nextOffset: number|null, hasMore: boolean, file: string}>}
 */
export const getBotLogs = async ({ offset = 0, limit = 100, file = "bot.log" } = {}) => {
  const response = await API.get("/api/bot-logs", {
    params: {
      offset,
      limit,
      file,
    },
  });
  return response.data;
};

// Get current settings
export const getSettings = async () => {
  const response = await API.get("/api/settings");
  return settingsResponseSchema.parse(response.data);
};

// Update settings (including minBorrowAmount and simulationInputAmount)
export const updateSettings = async (settings) => {
  const payload = settingsUpdateSchema.parse(settings);

  const response = await API.post("/api/settings", payload);
  const parsedSettings = settingsResponseSchema.parse(response.data.settings);

  return { ...response.data, settings: parsedSettings };
};

// Start the bot
export const startBot = async () => {
  const response = await API.post("/api/start-bot");
  return response.data;
};

// Stop the bot
export const stopBot = async () => {
  const response = await API.post("/api/stop-bot");
  return response.data;
};

// Fetch metrics for dashboard
export const getMetrics = async () => {
  const response = await API.get("/api/metrics-json");
  return response.data;
};

// Fetch recent trades
export const getTradeHistory = async (limit) => {
  const params = {};
  if (Number.isFinite(limit)) {
    params.limit = limit;
  }
  const response = await API.get("/api/trades", Object.keys(params).length ? { params } : undefined);
  return response.data;
};

// Fetch live arbitrage opportunities
export const getOpportunities = async () => {
  const response = await API.get("/api/opportunities");
  return response.data;
};

// Run profit simulation
export const simulateProfit = async (params) => {
  const response = await API.post("/api/simulate-profit", params);
  return response.data;
};

// Get bot health status
export const getHealth = async () => {
  const response = await API.get("/api/health");
  return response.data;
};

// Get current market data with specific token pair
export const getMarketData = async (tokenA, tokenB) => {
  const params = {};
  if (tokenA) params.tokenA = tokenA;
  if (tokenB) params.tokenB = tokenB;
  const response = await API.get("/api/market-data", { params });
  return response.data;
};

// Get daily statistics
export const getDailyStats = async () => {
  const response = await API.get("/api/daily-stats");
  return response.data;
};
