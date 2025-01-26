const { ethers } = require('ethers');

const settings = require('./scripts/settings').getSettings();

const provider = new ethers.providers.WebSocketProvider(settings.RPC_URL_WSS);

provider.on('block', (blockNumber) => {
    console.log(`New block: ${blockNumber}`);
});

provider._websocket.on('error', (error) => {
    console.error(`WebSocket error: ${error.message}`);
});

provider._websocket.on('close', (code, reason) => {
    console.error(`WebSocket closed: ${code} - ${reason}`);
});
