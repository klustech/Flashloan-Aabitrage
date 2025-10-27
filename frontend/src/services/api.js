// frontend/src/services/api.js

import axios from "axios";
import {
  settingsResponseSchema,
  settingsUpdateSchema,
} from "../validation/settingsSchema";

const API_BASE_URL =
  process.env.REACT_APP_API_BASE_URL || "http://localhost:3001";

const API = axios.create({
  baseURL: API_BASE_URL,
});

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
