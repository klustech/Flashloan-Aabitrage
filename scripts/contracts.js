// scripts/contracts.js

const { ethers } = require('ethers');
const { FlashbotsBundleProvider } = require('@flashbots/ethers-provider-bundle');
const { logMessage } = require('./logging');
const { getSettings } = require('./settings');
const WebSocket = require('ws');
const Bottleneck = require('bottleneck');
const { executeWithRetry } = require('./retry');
const EventEmitter = require('events');

const eventEmitter = new EventEmitter();

let provider, wallet, factoryContract, routerContract, flashbotsProvider;

/**
 * Bottleneck for rate limiting.
 */
const limiter = new Bottleneck({
    minTime: getSettings().BOTTLE_LIMIT_MIN_TIME, 
    maxConcurrent: getSettings().BOTTLE_LIMIT_MAX_CONCURRENT,
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
 * Top-level function to initialize the WebSocket provider.
 * 
 * Called inside initContracts() and from on('close') to reconnect.
 */
function initializeProvider() {
    const settings = getSettings();
    const RPC_URL = settings.RPC_URL_WSS;

    if (!RPC_URL) {
        throw new Error('RPC_URL_WSS is required in settings.');
    }

    provider = new ethers.providers.WebSocketProvider(RPC_URL);

    // Handle WS errors
    provider._websocket.on('error', (error) => {
        logMessage(`WebSocket error: ${error.message}`, {}, 'error');
    });

    // Handle WS closure + re-init
    provider._websocket.on('close', (code, reason) => {
        logMessage(`WebSocket closed: ${code} - ${reason || 'No reason'}`, {}, 'error');
        logMessage('Attempting to reconnect in 5 seconds...', {}, 'info');
        setTimeout(() => {
            initializeProvider(); // Recurse to re-init
        }, 5000);
    });

    // On open (no keep-alive pings)
    provider._websocket.on('open', () => {
        logMessage('WebSocket connection established.', {}, 'info');
    });
}

/**
 * Initializes the EVM provider, wallet, optional Flashbots provider,
 * and the factory/router contracts.
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

        // Set up provider (includes reconnection logic)
        initializeProvider();

        // Wrap with Bottleneck + retry
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

        // Emit 'connected' for any listeners that want to re-set event watchers
        eventEmitter.emit('connected');
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
    eventEmitter
};
