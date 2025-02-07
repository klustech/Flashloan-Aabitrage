// server.js

/**
 * server.js
 *
 * Sets up the Express server and defines API endpoints.
 */

require('dotenv').config(); // Load environment variables from .env

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { ethers } = require('ethers');

const {
  startBot,
  stopBot,
  getStatus,
  getDetectedPairs,
  getSuccessfulTrades,
  getInitializationLogs,
  getGeneralLogs,
} = require('./scripts/eventListener');

const { logMessage, getLogs } = require('./scripts/logging');
const { initContracts, getProvider, getWallet } = require('./scripts/contracts');
const { getSettings, updateSettings } = require('./scripts/settings');
const { executeSell } = require('./scripts/tradingOperations');
const { initDatabase, getAllTrades, updateTrade } = require('./scripts/database');

// Initialize the database early
initDatabase();

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

const settingsUpdateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many settings update attempts from this IP. Try again after 15 minutes.',
});

(async () => {
  try {
    await initContracts();
    logMessage('Contracts initialized.', {}, 'info');
    await checkWalletBalance();
  } catch (err) {
    logMessage(`Error initializing contracts in server.js: ${err.message}`, {}, 'error');
    process.exit(1);
  }
})();

async function checkWalletBalance() {
  try {
    const wallet = getWallet();
    const balance = await wallet.getBalance();
    logMessage(`Wallet Balance: ${ethers.utils.formatEther(balance)} ETH`, {}, 'info');
  } catch (error) {
    logMessage(`Error checking wallet balance: ${error.message}`, {}, 'error');
  }
}

// API Endpoints

app.get('/api/status', (req, res) => {
  res.json({ status: getStatus() });
});

app.get('/api/detected-pairs', (req, res) => {
  res.json(getDetectedPairs());
});

// This endpoint returns successful sell trades
app.get('/api/trades', async (req, res) => {
  try {
    const trades = await getSuccessfulTrades();
    res.json(trades);
  } catch (error) {
    logMessage(`Error fetching trades: ${error.message}`, {}, 'error');
    res.status(500).json({ error: error.message });
  }
});

// This endpoint returns all trades (both buy and sell)
app.get('/api/all-trades', async (req, res) => {
  try {
    const trades = await getAllTrades();
    res.json(trades);
  } catch (error) {
    logMessage(`Error fetching all trades: ${error.message}`, {}, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    const logs = await getLogs(100);
    res.json(logs);
  } catch (error) {
    logMessage(`Error fetching logs: ${error.message}`, {}, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

app.post('/api/settings', settingsUpdateLimiter, (req, res) => {
  try {
    const newSettings = req.body;
    if (typeof newSettings !== 'object' || Array.isArray(newSettings)) {
      return res.status(400).json({ error: 'Invalid settings format. Expected a JSON object.' });
    }
    updateSettings(newSettings);
    logMessage('Settings updated successfully.', {}, 'info');
    res.json({ status: 'Settings updated successfully.', settings: getSettings() });
  } catch (error) {
    logMessage(`Error updating settings: ${error.message}`, {}, 'error');
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/start', async (req, res) => {
  try {
    await startBot();
    res.json({ status: 'Bot started successfully.' });
  } catch (error) {
    logMessage(`Error starting bot: ${error.message}`, {}, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stop', (req, res) => {
  try {
    stopBot();
    res.json({ status: 'Bot stopped successfully.' });
  } catch (error) {
    logMessage(`Error stopping bot: ${error.message}`, {}, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/update-trade', async (req, res) => {
  try {
    const { tradeId, profitThreshold, stopLossThreshold } = req.body;
    if (!tradeId || profitThreshold === undefined || stopLossThreshold === undefined) {
      return res.status(400).json({ error: 'Missing required fields: tradeId, profitThreshold, stopLossThreshold.' });
    }
    await updateTrade(tradeId, { profitThreshold, stopLossThreshold });
    logMessage(`Trade ${tradeId} updated successfully.`, {}, 'info');
    res.json({ status: 'Trade updated successfully.' });
  } catch (error) {
    logMessage(`Error updating trade: ${error.message}`, {}, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/manual-sell', async (req, res) => {
  try {
    const { tokenAddress } = req.body;
    if (!tokenAddress) {
      return res.status(400).json({ error: 'Missing tokenAddress.' });
    }
    await executeSell(tokenAddress);
    logMessage(`Manual sell triggered for token ${tokenAddress}.`, {}, 'info');
    res.json({ status: 'Sell order placed successfully.' });
  } catch (error) {
    logMessage(`Error executing manual sell: ${error.message}`, {}, 'error');
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => logMessage(`Backend server is running on port ${PORT}`, {}, 'info'));
