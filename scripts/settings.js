// scripts/settings.js

const fs = require('fs');
const path = require('path');
require('dotenv').config(); // Load environment variables from .env file

const SETTINGS_FILE = path.resolve(__dirname, '../settings.json');

let settings = {
    // Ethereum Addresses
    BASE_TOKEN_ADDRESS: process.env.BASE_TOKEN_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    FACTORY_ADDRESS: process.env.FACTORY_ADDRESS,
    ROUTER_ADDRESS: process.env.ROUTER_ADDRESS,

    // Private Key
    PRIVATE_KEY: process.env.PRIVATE_KEY,

    // RPC URLs
    RPC_URL_MAINNET: process.env.RPC_URL_MAINNET,
    RPC_URL_WSS: process.env.RPC_URL_WSS,
    RPC_URL_LOCAL: process.env.RPC_URL_LOCAL,

    // Trading Settings
    ETH_AMOUNT_TO_SWAP: parseFloat(process.env.ETH_AMOUNT_TO_SWAP) || 0.1,
    SLIPPAGE_TOLERANCE: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 5,
    GAS_PRICE_MULTIPLIER: parseFloat(process.env.GAS_PRICE_MULTIPLIER) || 2, // Updated from 1.2 to 2
    PROFIT_THRESHOLD: parseFloat(process.env.PROFIT_THRESHOLD) || 5, // % profit
    STOP_LOSS_THRESHOLD: parseFloat(process.env.STOP_LOSS_THRESHOLD) || 20, // % drop
    DEADLINE_BUFFER: parseInt(process.env.DEADLINE_BUFFER, 10) || 60,
    MINIMUM_LOCKED_ETH: parseFloat(process.env.MINIMUM_LOCKED_ETH) || 1000,
    MAX_GAS_PRICE: parseInt(process.env.MAX_GAS_PRICE, 10) || 200,

    // Rate Limiting Settings
    BOTTLE_LIMIT_MIN_TIME: parseInt(process.env.BOTTLE_LIMIT_MIN_TIME, 10) || 200, // Minimum time between requests in ms
    BOTTLE_LIMIT_MAX_CONCURRENT: parseInt(process.env.BOTTLE_LIMIT_MAX_CONCURRENT, 10) || 5, // Maximum number of concurrent requests

    // Retry Settings
    MAX_RETRY_ATTEMPTS: parseInt(process.env.MAX_RETRY_ATTEMPTS, 10) || 5, // Increased from 3 to 5 for better resilience
    INITIAL_RETRY_DELAY: parseInt(process.env.INITIAL_RETRY_DELAY, 10) || 1000, // Initial delay in ms for retries

    // Flashbots Settings
    FLASHBOTS_ENABLED: process.env.FLASHBOTS_ENABLED === 'true' || false,

    // Monitoring Settings
    PROFIT_THRESHOLD_FACTOR: parseFloat(process.env.PROFIT_THRESHOLD_FACTOR) || 1.05, // 5% profit
    MONITOR_DELAY_MS: parseInt(process.env.MONITOR_DELAY_MS, 10) || 60000, // 60 seconds

    // Database
    DATABASE_PATH: process.env.DATABASE_PATH || './database/trades.db',

    // Logging
    LOG_FILE: process.env.LOG_FILE || './logs/bot.log',

    // Token Lists
    TOKEN_WHITELIST: process.env.TOKEN_WHITELIST ? process.env.TOKEN_WHITELIST.split(',') : [],
    TOKEN_BLACKLIST: process.env.TOKEN_BLACKLIST ? process.env.TOKEN_BLACKLIST.split(',') : [],

    // Additional Settings
    MIN_BASE_TOKEN_RESERVE: parseFloat(process.env.MIN_BASE_TOKEN_RESERVE) || 1, // Minimum reserve of base token to consider a pair viable
};

/**
 * Loads settings from settings.json if it exists.
 */
function loadSettings() {
    if (fs.existsSync(SETTINGS_FILE)) {
        try {
            const fileData = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            const fileSettings = JSON.parse(fileData);
            settings = { ...settings, ...fileSettings };
            console.log('Settings loaded from settings.json.');
        } catch (error) {
            console.error('Error reading settings.json:', error.message);
            console.error('Falling back to environment variables for settings.');
        }
    } else {
        console.log('settings.json not found. Using environment variables for settings.');
    }
}

/**
 * Saves specific settings to settings.json
 */
function saveSettings() {
    try {
        const settingsToSave = {
            ETH_AMOUNT_TO_SWAP: settings.ETH_AMOUNT_TO_SWAP,
            SLIPPAGE_TOLERANCE: settings.SLIPPAGE_TOLERANCE,
            GAS_PRICE_MULTIPLIER: settings.GAS_PRICE_MULTIPLIER,
            PROFIT_THRESHOLD: settings.PROFIT_THRESHOLD,
            STOP_LOSS_THRESHOLD: settings.STOP_LOSS_THRESHOLD,
            DEADLINE_BUFFER: settings.DEADLINE_BUFFER,
            MINIMUM_LOCKED_ETH: settings.MINIMUM_LOCKED_ETH,
            MAX_GAS_PRICE: settings.MAX_GAS_PRICE,
            BOTTLE_LIMIT_MIN_TIME: settings.BOTTLE_LIMIT_MIN_TIME,
            BOTTLE_LIMIT_MAX_CONCURRENT: settings.BOTTLE_LIMIT_MAX_CONCURRENT,
            MAX_RETRY_ATTEMPTS: settings.MAX_RETRY_ATTEMPTS,
            INITIAL_RETRY_DELAY: settings.INITIAL_RETRY_DELAY,
            PROFIT_THRESHOLD_FACTOR: settings.PROFIT_THRESHOLD_FACTOR,
            MONITOR_DELAY_MS: settings.MONITOR_DELAY_MS,
            TOKEN_WHITELIST: settings.TOKEN_WHITELIST,
            TOKEN_BLACKLIST: settings.TOKEN_BLACKLIST,
            FLASHBOTS_ENABLED: settings.FLASHBOTS_ENABLED,
            MIN_BASE_TOKEN_RESERVE: settings.MIN_BASE_TOKEN_RESERVE,
            RPC_URL_WSS: settings.RPC_URL_WSS,
            RPC_URL_LOCAL: settings.RPC_URL_LOCAL,
        };

        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsToSave, null, 2));
        console.log('Settings saved to settings.json.');
    } catch (error) {
        console.error('Error saving settings:', error.message);
    }
}

/**
 * Updates settings in-memory and persists them.
 */
function updateSettings(newSettings) {
    // Validate numerical fields
    const numericalFields = [
        'ETH_AMOUNT_TO_SWAP',
        'SLIPPAGE_TOLERANCE',
        'GAS_PRICE_MULTIPLIER',
        'PROFIT_THRESHOLD',
        'STOP_LOSS_THRESHOLD',
        'DEADLINE_BUFFER',
        'MINIMUM_LOCKED_ETH',
        'MAX_GAS_PRICE',
        'BOTTLE_LIMIT_MIN_TIME',
        'BOTTLE_LIMIT_MAX_CONCURRENT',
        'MAX_RETRY_ATTEMPTS',
        'INITIAL_RETRY_DELAY',
        'PROFIT_THRESHOLD_FACTOR',
        'MONITOR_DELAY_MS',
    ];

    for (const field of numericalFields) {
        if (newSettings[field] !== undefined && isNaN(newSettings[field])) {
            throw new Error(`Invalid value for ${field}: must be a number.`);
        }
    }

    settings = { ...settings, ...newSettings };
    saveSettings();
}

/**
 * Retrieve current settings.
 */
function getSettings() {
    return settings;
}

// Initialize settings on module load
loadSettings();

module.exports = { getSettings, updateSettings };
