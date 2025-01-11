// server.js

/**
 * server.js
 *
 * Sets up the Express server and defines API endpoints.
 */

require('dotenv').config(); // Load environment variables from .env

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit'); // To prevent abuse
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

// Create Express app
const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiter for settings updates
const settingsUpdateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per windowMs
  message: 'Too many settings update attempts from this IP. Try again after 15 minutes.',
});

/**
 * Initializes contracts *once* before all other server logic. 
 * This ensures provider/wallet are ready for use in other modules.
 */
(async () => {
  try {
    await initContracts(); // <---- CRITICAL: ensures getProvider() & getWallet() are valid afterward
    logMessage('Contracts initialized.', {}, 'info');

    // Check wallet balance at startup
    await checkWalletBalance();
  } catch (err) {
    logMessage(`Error initializing contracts in server.js: ${err.message}`, {}, 'error');
    process.exit(1); // Exit if we can’t init
  }
})();

/**
 * Function to check wallet balance using the newly initialized provider/wallet.
 */
async function checkWalletBalance() {
  try {
    const wallet = getWallet(); // Guaranteed by initContracts
    const balance = await wallet.getBalance();
    logMessage(`Wallet Balance: ${ethers.utils.formatEther(balance)} ETH`, {}, 'info');
  } catch (error) {
    logMessage(`Error checking wallet balance: ${error.message}`, {}, 'error');
  }
}

// ===== API Endpoints =====

/**
 * Bot Status
 */
app.get('/api/status', (req, res) => {
  res.json({ status: getStatus() });
});

/**
 * Detected Pairs
 */
app.get('/api/detected-pairs', (req, res) => {
  res.json(getDetectedPairs());
});

/**
 * Successful Trades
 */
app.get('/api/trades', async (req, res) => {
  try {
    const trades = await getSuccessfulTrades();
    res.json(trades);
  } catch (error) {
    logMessage(`Error fetching trades: ${error.message}`, {}, 'error');
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get Logs
 */
app.get('/api/logs', async (req, res) => {
  try {
    const logs = await getLogs(100); // last 100 logs
    res.json(logs);
  } catch (error) {
    logMessage(`Error fetching logs: ${error.message}`, {}, 'error');
    res.status(500).json({ error: error.message });
  }
});

/**
 * Current Settings
 */
app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

/**
 * Update Settings
 */
app.post('/api/settings', settingsUpdateLimiter, (req, res) => {
  try {
    const newSettings = req.body;

    if (typeof newSettings !== 'object' || Array.isArray(newSettings)) {
      return res.status(400).json({ error: 'Invalid settings format. Expected a JSON object.' });
    }

    // Update
    updateSettings(newSettings);
    logMessage('Settings updated successfully.', {}, 'info');

    res.json({ status: 'Settings updated successfully.', settings: getSettings() });
  } catch (error) {
    logMessage(`Error updating settings: ${error.message}`, {}, 'error');
    res.status(400).json({ error: error.message });
  }
});

/**
 * Start Bot
 */
app.post('/api/start', async (req, res) => {
  try {
    await startBot();
    res.json({ status: 'Bot started successfully.' });
  } catch (error) {
    logMessage(`Error starting bot: ${error.message}`, {}, 'error');
    res.status(500).json({ error: error.message });
  }
});

/**
 * Stop Bot
 */
app.post('/api/stop', (req, res) => {
  try {
    stopBot();
    res.json({ status: 'Bot stopped successfully.' });
  } catch (error) {
    logMessage(`Error stopping bot: ${error.message}`, {}, 'error');
    res.status(500).json({ error: error.message });
  }
});

// ===== Start Server =====
app.listen(PORT, () => logMessage(`Backend server is running on port ${PORT}`, {}, 'info'));

