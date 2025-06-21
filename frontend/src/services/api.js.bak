// frontend/src/services/api.js

import axios from "axios";

const API = axios.create({
  baseURL: "http://localhost:3001",
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
