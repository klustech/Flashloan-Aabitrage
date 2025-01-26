// scripts/monitorPairs.js

const { ethers } = require('ethers');
const { getSettings } = require('./settings');
const { logMessage } = require('./logging');

// Initialize settings
const settings = getSettings();

// Initialize WebSocket Provider
const provider = new ethers.providers.WebSocketProvider(settings.RPC_URL_WSS);

// Factory Contract ABI (only the PairCreated event)
const factoryAbi = [
    'event PairCreated(address indexed token0, address indexed token1, address pair, uint)'
];

// Initialize Factory Contract
const factoryContract = new ethers.Contract(settings.FACTORY_ADDRESS, factoryAbi, provider);

// Event Listener for PairCreated
factoryContract.on('PairCreated', (token0, token1, pair, event) => {
    logMessage('Detected PairCreated Event:', { token0, token1, pair }, 'info');
    // Here, you can add additional logic to handle the new pair
    // For example, evaluating the pair and deciding to snipe
});

// Handle WebSocket Errors
provider._websocket.on('error', (error) => {
    logMessage(`WebSocket error: ${error.message}`, {}, 'error');
});

// Handle WebSocket Closure and Reconnection
provider._websocket.on('close', (code, reason) => {
    logMessage(`WebSocket closed: ${code} - ${reason || 'No reason provided'}`, {}, 'error');
    logMessage('Attempting to reconnect in 5 seconds...', {}, 'info');
    setTimeout(() => {
        reconnect();
    }, 5000);
});

// Reconnection Logic
function reconnect() {
    logMessage('Reconnecting to WebSocket provider...', {}, 'info');
    provider = new ethers.providers.WebSocketProvider(settings.RPC_URL_WSS);
    factoryContract = new ethers.Contract(settings.FACTORY_ADDRESS, factoryAbi, provider);
    
    // Re-attach the event listener
    factoryContract.on('PairCreated', (token0, token1, pair, event) => {
        logMessage('Detected PairCreated Event:', { token0, token1, pair }, 'info');
        // Additional logic here
    });

    // Re-attach error handlers
    provider._websocket.on('error', (error) => {
        logMessage(`WebSocket error: ${error.message}`, {}, 'error');
    });

    provider._websocket.on('close', (code, reason) => {
        logMessage(`WebSocket closed: ${code} - ${reason || 'No reason provided'}`, {}, 'error');
        logMessage('Attempting to reconnect in 5 seconds...', {}, 'info');
        setTimeout(() => {
            reconnect();
        }, 5000);
    });
}

logMessage('Starting PairCreated event listener...', {}, 'info');
