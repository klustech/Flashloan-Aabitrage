// frontend/src/services/api.js

import axios from "axios";

const API_BASE_URL =
  process.env.REACT_APP_API_BASE_URL || "http://localhost:3001";
const STATIC_API_KEY = process.env.REACT_APP_API_KEY;
const STATIC_BEARER_TOKEN = process.env.REACT_APP_API_BEARER_TOKEN;

export const API = axios.create({
  baseURL: API_BASE_URL,
});

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
export const getBotLogs = async () => {
  const response = await API.get("/api/bot-logs");
  return response.data;
};

// Get current settings
export const getSettings = async () => {
  const response = await API.get("/api/settings");
  return response.data;
};

// Update settings (including minBorrowAmount and simulationInputAmount)
export const updateSettings = async (settings) => {
  const response = await API.post("/api/settings", settings);
  return response.data;
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
