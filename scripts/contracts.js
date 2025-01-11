// scripts/contracts.js

const { ethers } = require('ethers');
const { FlashbotsBundleProvider } = require('@flashbots/ethers-provider-bundle');
const { logMessage } = require('./logging');
const { getSettings } = require('./settings');
const WebSocket = require('ws');
const Bottleneck = require('bottleneck');
const { executeWithRetry } = require('./retry');

let provider, wallet, factoryContract, routerContract, flashbotsProvider;

/**
 * Initializes Bottleneck for rate limiting.
 */
const limiter = new Bottleneck({
    minTime: getSettings().BOTTLE_LIMIT_MIN_TIME, // Minimum ms between requests
    maxConcurrent: getSettings().BOTTLE_LIMIT_MAX_CONCURRENT, // Max concurrent requests
});

/**
 * Wrap Ethers.js provider's .send method with Bottleneck + retry logic.
 */
function wrapProviderWithLimiter(originalProvider) {
    const originalSend = originalProvider.send.bind(originalProvider);
    originalProvider.send = limiter.wrap(async (method, params) => {
        return executeWithRetry(() => originalSend(method, params));
    });
    return originalProvider;
}

/**
 * Initializes the EVM provider, wallet, and optional Flashbots provider,
 * as well as the factory & router contracts.
 */
async function initContracts() {
    try {
        logMessage('Initializing contracts...', {}, 'info');

        const settings = getSettings();
        let privateKey = settings.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error('PRIVATE_KEY not set.');
        }

        // Validate private key format
        if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
            if (/^[a-fA-F0-9]{64}$/.test(privateKey)) {
                privateKey = '0x' + privateKey;
            } else {
                throw new Error('Invalid PRIVATE_KEY format.');
            }
        }

        // Validate WebSocket URL
        const RPC_URL = settings.RPC_URL_WSS;
        if (!RPC_URL) {
            throw new Error('RPC_URL_WSS is required in settings.');
        }

        // Initialize WS provider with reconnection logic
        const initializeProvider = () => {
            try {
                provider = new ethers.providers.WebSocketProvider(RPC_URL);
                provider._websocket.on('error', (err) => {
                    logMessage(`WebSocket error: ${err.message}`, {}, 'error');
                });
                provider._websocket.on('close', (code, reason) => {
                    logMessage(`WebSocket closed: ${code} - ${reason || 'No reason'}`, {}, 'error');
                    logMessage('Attempting to reconnect in 5s...', {}, 'info');
                    setTimeout(initializeProvider, 5000);
                });
                provider._websocket.on('open', () => {
                    logMessage('WebSocket connection established.', {}, 'info');
                    const pingInterval = setInterval(() => {
                        if (provider._websocket.readyState === WebSocket.OPEN) {
                            provider._websocket.ping();
                        } else {
                            clearInterval(pingInterval);
                        }
                    }, 30000);
                });
                logMessage('WS Provider initialized.', {}, 'info');
            } catch (error) {
                logMessage(`Failed to initialize WebSocketProvider: ${error.message}`, {}, 'error');
                throw error;
            }
        };

        initializeProvider();

        // Wrap the WS provider with Bottleneck + retry
        provider = wrapProviderWithLimiter(provider);

        // Create wallet
        wallet = new ethers.Wallet(privateKey, provider);
        logMessage(`Wallet: ${wallet.address}`, {}, 'info');

        // Optionally create Flashbots provider
        if (settings.FLASHBOTS_ENABLED) {
            flashbotsProvider = await FlashbotsBundleProvider.create(
                provider,
                wallet,
                'https://relay.flashbots.net/'
            );
            logMessage('FlashbotsBundleProvider initialized.', {}, 'info');
        }

        // Initialize contracts
        const FACTORY_ADDRESS = ethers.utils.getAddress(settings.FACTORY_ADDRESS);
        const ROUTER_ADDRESS = ethers.utils.getAddress(settings.ROUTER_ADDRESS);

        factoryContract = new ethers.Contract(
            FACTORY_ADDRESS,
            ['event PairCreated(address indexed token0, address indexed token1, address pair, uint)'],
            provider
        );

        routerContract = new ethers.Contract(
            ROUTER_ADDRESS,
            [
                'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable',
                'function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)',
                'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
            ],
            wallet
        );

        // Test provider connectivity
        const blockNumber = await executeWithRetry(() => provider.getBlockNumber());
        logMessage(`Connected to chain. Current block: ${blockNumber}`, {}, 'info');

        return { provider, wallet, factoryContract, routerContract, flashbotsProvider };
    } catch (err) {
        logMessage(`Error in initContracts(): ${err.message}`, {}, 'error');
        throw err;
    }
}

/** Return the factory contract */
function getFactoryContract() {
    if (!factoryContract) {
        throw new Error('Factory not initialized.');
    }
    return factoryContract;
}

/** Return the router contract */
function getRouterContract() {
    if (!routerContract) {
        throw new Error('Router not initialized.');
    }
    return routerContract;
}

/** Return the provider */
function getProvider() {
    if (!provider) {
        throw new Error('Provider not initialized.');
    }
    return provider;
}

/** Return the wallet */
function getWallet() {
    if (!wallet) {
        throw new Error('Wallet not initialized.');
    }
    return wallet;
}

/** Return the flashbots provider, if enabled */
function getFlashbotsProvider() {
    return flashbotsProvider;
}

module.exports = {
    initContracts,
    getFactoryContract,
    getRouterContract,
    getProvider,
    getWallet,
    getFlashbotsProvider,
};
