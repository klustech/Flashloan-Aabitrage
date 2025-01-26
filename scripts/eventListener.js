// scripts/eventListener.js

const {
    initContracts,
    getFactoryContract,
    eventEmitter,
} = require('./contracts');
const { logMessage } = require('./logging');
const { executePurchase } = require('./tradingOperations');
const { initDatabase, getAllTrades, closeDatabase } = require('./database');
const { getSettings } = require('./settings');

// Import evaluatePair from evaluation.js
const { evaluatePair } = require('./evaluation');

let botRunning = false;

/**
 * Initializes the SQLite database.
 */
function initializeDatabase() {
    try {
        initDatabase();
        logMessage('Database initialized.', {}, 'info');
    } catch (error) {
        logMessage(`Error initializing database: ${error.message}`, {}, 'error');
        throw new Error('Failed to initialize database.');
    }
}

/**
 * Sets up the PairCreated event listener.
 */
function setupPairCreatedListener() {
    try {
        const factoryContract = getFactoryContract();

        // Remove existing listeners to prevent duplicates
        factoryContract.removeAllListeners('PairCreated');

        // Subscribe to PairCreated events
        factoryContract.on('PairCreated', async (token0, token1, pairAddress) => {
            logMessage('Detected PairCreated Event:', { token0, token1, pairAddress }, 'info');
            await handlePairCreated(token0, token1, pairAddress);
        });

        logMessage('Listener for PairCreated events has been set up successfully.', {}, 'info');
    } catch (error) {
        logMessage(`Failed to set up PairCreated listener: ${error.message}`, {}, 'error');
    }
}

/**
 * Start the bot: Initialize contracts, database, and set up event listeners.
 */
async function startBot() {
    if (botRunning) {
        logMessage('Bot is already running.', {}, 'info');
        return;
    }

    try {
        await initContracts();
        initializeDatabase();
        botRunning = true;
        logMessage('Bot started.', {}, 'info');

        setupPairCreatedListener();

        // Listen for 'connected' events to re-setup PairCreated listener upon reconnection
        eventEmitter.on('connected', () => {
            logMessage('Reconnected to provider. Re-setting up PairCreated listener.', {}, 'info');
            setupPairCreatedListener();
        });
    } catch (error) {
        logMessage(`Failed to start bot: ${error.message}`, {}, 'error');
        botRunning = false;
    }
}

/**
 * Stops the bot by removing event listeners and closing the database connection.
 */
function stopBot() {
    if (!botRunning) {
        logMessage('Bot is not running.', {}, 'info');
        return;
    }

    try {
        const factoryContract = getFactoryContract();
        factoryContract.removeAllListeners('PairCreated');
        closeDatabase();
        botRunning = false;
        logMessage('Bot stopped.', {}, 'info');
    } catch (error) {
        logMessage(`Failed to stop bot: ${error.message}`, {}, 'error');
    }
}

/**
 * Returns the current status of the bot.
 * @returns {string} 'Running' or 'Stopped'
 */
function getStatus() {
    return botRunning ? 'Running' : 'Stopped';
}

/**
 * Retrieves detected pairs.
 * @returns {Array} Array of detected pairs
 */
function getDetectedPairs() {
    // Placeholder implementation
    return [];
}

/**
 * Retrieves successful trades from the database.
 * @returns {Promise<Array>} Array of trade records
 */
async function getSuccessfulTrades() {
    try {
        const trades = await getAllTrades(100);
        return trades.filter(trade => trade.type === 'sell');
    } catch (error) {
        logMessage(`Error fetching trades: ${error.message}`, {}, 'error');
        return [];
    }
}

/**
 * Retrieves general logs.
 * @returns {Promise<Array>} Array of log entries
 */
async function getGeneralLogs() {
    // Placeholder implementation
    return [];
}

/**
 * Handles the PairCreated event by evaluating the pair and executing a purchase if viable.
 * @param {string} token0 - Address of token0
 * @param {string} token1 - Address of token1
 * @param {string} pairAddress - Address of the pair
 */
async function handlePairCreated(token0, token1, pairAddress) {
    try {
        const baseTokenAddress = getSettings().BASE_TOKEN_ADDRESS.toLowerCase();
        const newTokenAddress = token0.toLowerCase() === baseTokenAddress ? token1 : token0;

        logMessage(`New Token Address: ${newTokenAddress}`, {}, 'info');

        // Wait for a short duration to allow liquidity to be added
        const WAIT_TIME_MS = 5000; // 5 seconds
        logMessage(`Waiting for ${WAIT_TIME_MS / 1000} seconds to allow liquidity addition...`, {}, 'info');
        await delay(WAIT_TIME_MS);

        // Evaluate and possibly purchase
        const isViable = await evaluatePair(pairAddress, token0, token1);
        if (isViable) {
            logMessage(`Pair ${pairAddress} is viable. Proceeding to execute purchase.`, {}, 'info');
            await executePurchase(pairAddress, token0, token1);
        } else {
            logMessage(`Pair ${pairAddress} is not viable for purchase.`, {}, 'info');
        }
    } catch (error) {
        logMessage(`Error handling PairCreated event for ${pairAddress}: ${error.message}`, {}, 'error');
    }
}

/**
 * Delays execution for a specified duration.
 * @param {number} ms - Milliseconds to delay.
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    startBot,
    stopBot,
    getStatus,
    getDetectedPairs,
    getSuccessfulTrades,
    getGeneralLogs,
};
