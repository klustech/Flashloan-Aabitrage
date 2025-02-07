// scripts/settings.js

const fs = require('fs');
const path = require('path');
require('dotenv').config(); // Load environment variables from .env file

// Define the path to the settings file
const SETTINGS_FILE = path.resolve(__dirname, '../settings.json');

// Define default settings (with proper numeric parsing)
let settings = {
  // Ethereum Addresses
  BASE_TOKEN_ADDRESS: process.env.BASE_TOKEN_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  FACTORY_ADDRESS: process.env.FACTORY_ADDRESS || '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
  ROUTER_ADDRESS: process.env.ROUTER_ADDRESS || '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',

  // Private Key
  PRIVATE_KEY: process.env.PRIVATE_KEY,

  // RPC URLs
  RPC_URL_MAINNET: process.env.RPC_URL_MAINNET,
  RPC_URL_WSS: process.env.RPC_URL_WSS,
  RPC_URL_LOCAL: process.env.RPC_URL_LOCAL,

  // Trading Settings
  ETH_AMOUNT_TO_SWAP: parseFloat(process.env.ETH_AMOUNT_TO_SWAP) || 0.1,
  SLIPPAGE_TOLERANCE: parseFloat(process.env.SLIPPAGE_TOLERANCE) || 5,
  GAS_PRICE_MULTIPLIER: parseFloat(process.env.GAS_PRICE_MULTIPLIER) || 2,
  PROFIT_THRESHOLD: parseFloat(process.env.PROFIT_THRESHOLD) || 5,
  STOP_LOSS_THRESHOLD: parseFloat(process.env.STOP_LOSS_THRESHOLD) || 20,
  DEADLINE_BUFFER: parseInt(process.env.DEADLINE_BUFFER, 10) || 60,
  // Base Token Reserve setting (this is important for evaluating pairs)
  MIN_BASE_TOKEN_RESERVE: parseFloat(process.env.MIN_BASE_TOKEN_RESERVE) || 5,
  MAX_GAS_PRICE: parseInt(process.env.MAX_GAS_PRICE, 10) || 200,
  
  // New: Maximum acceptable token risk score (lower is better)
  MAX_TOKEN_RISK_SCORE: parseFloat(process.env.MAX_TOKEN_RISK_SCORE) || 50,

  // Rate Limiting Settings
  BOTTLE_LIMIT_MIN_TIME: parseInt(process.env.BOTTLE_LIMIT_MIN_TIME, 10) || 200,
  BOTTLE_LIMIT_MAX_CONCURRENT: parseInt(process.env.BOTTLE_LIMIT_MAX_CONCURRENT, 10) || 5,

  // Retry Settings
  MAX_RETRY_ATTEMPTS: parseInt(process.env.MAX_RETRY_ATTEMPTS, 10) || 5,
  INITIAL_RETRY_DELAY: parseInt(process.env.INITIAL_RETRY_DELAY, 10) || 1000,

  // Flashbots Settings
  FLASHBOTS_ENABLED: process.env.FLASHBOTS_ENABLED === 'true',

  // Monitoring Settings
  PROFIT_THRESHOLD_FACTOR: parseFloat(process.env.PROFIT_THRESHOLD_FACTOR) || 1.05,
  MONITOR_DELAY_MS: parseInt(process.env.MONITOR_DELAY_MS, 10) || 60000,

  // Database Settings
  DATABASE_PATH: process.env.DATABASE_PATH || './database/trades.db',

  // Logging Settings
  LOG_FILE: process.env.LOG_FILE || './logs/bot.log',

  // Token Lists
  TOKEN_WHITELIST: process.env.TOKEN_WHITELIST ? process.env.TOKEN_WHITELIST.split(',') : [],
  TOKEN_BLACKLIST: process.env.TOKEN_BLACKLIST ? process.env.TOKEN_BLACKLIST.split(',') : [],
};

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

function saveSettings() {
  try {
    // Save only the settings we need
    const settingsToSave = {
      ETH_AMOUNT_TO_SWAP: settings.ETH_AMOUNT_TO_SWAP,
      SLIPPAGE_TOLERANCE: settings.SLIPPAGE_TOLERANCE,
      GAS_PRICE_MULTIPLIER: settings.GAS_PRICE_MULTIPLIER,
      PROFIT_THRESHOLD: settings.PROFIT_THRESHOLD,
      STOP_LOSS_THRESHOLD: settings.STOP_LOSS_THRESHOLD,
      DEADLINE_BUFFER: settings.DEADLINE_BUFFER,
      MIN_BASE_TOKEN_RESERVE: settings.MIN_BASE_TOKEN_RESERVE,
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
      RPC_URL_WSS: settings.RPC_URL_WSS,
      RPC_URL_LOCAL: settings.RPC_URL_LOCAL,
      BASE_TOKEN_ADDRESS: settings.BASE_TOKEN_ADDRESS,
      FACTORY_ADDRESS: settings.FACTORY_ADDRESS,
      ROUTER_ADDRESS: settings.ROUTER_ADDRESS,
      MAX_TOKEN_RISK_SCORE: settings.MAX_TOKEN_RISK_SCORE,
    };

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsToSave, null, 2));
    console.log('Settings saved to settings.json.');
  } catch (error) {
    console.error('Error saving settings:', error.message);
  }
}

function updateSettings(newSettings) {
  const numericalFields = [
    'ETH_AMOUNT_TO_SWAP',
    'SLIPPAGE_TOLERANCE',
    'GAS_PRICE_MULTIPLIER',
    'PROFIT_THRESHOLD',
    'STOP_LOSS_THRESHOLD',
    'DEADLINE_BUFFER',
    'MIN_BASE_TOKEN_RESERVE',
    'MAX_GAS_PRICE',
    'BOTTLE_LIMIT_MIN_TIME',
    'BOTTLE_LIMIT_MAX_CONCURRENT',
    'MAX_RETRY_ATTEMPTS',
    'INITIAL_RETRY_DELAY',
    'PROFIT_THRESHOLD_FACTOR',
    'MONITOR_DELAY_MS',
    'MAX_TOKEN_RISK_SCORE',
  ];

  for (const field of numericalFields) {
    if (newSettings[field] !== undefined && isNaN(newSettings[field])) {
      throw new Error(`Invalid value for ${field}: must be a number.`);
    }
  }
  settings = { ...settings, ...newSettings };
  saveSettings();
}

function getSettings() {
  return settings;
}

loadSettings();

module.exports = { getSettings, updateSettings };
