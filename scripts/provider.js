// scripts/provider.js

require('dotenv').config(); // Ensure environment variables are loaded

const { ethers } = require('ethers');
const { logMessage } = require('./logging');

// Initialize Provider
const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);

// Initialize Wallet
let wallet;
try {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        throw new Error('PRIVATE_KEY is not set in environment variables.');
    }
    // Validate PRIVATE_KEY format
    if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
        throw new Error('Invalid PRIVATE_KEY format in .env file.');
    }
    wallet = new ethers.Wallet(privateKey, provider);
    logMessage(`Wallet initialized: ${wallet.address}`, {}, 'info');
} catch (error) {
    logMessage(`Error initializing wallet: ${error.message}`, {}, 'error');
    process.exit(1); // Exit the application if wallet initialization fails
}

module.exports = {
    provider,
    wallet,
};

