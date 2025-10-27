// frontend/src/services/api.js

import axios from "axios";

const API_BASE_URL =
  process.env.REACT_APP_API_BASE_URL || "http://localhost:3001";

const API = axios.create({
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
