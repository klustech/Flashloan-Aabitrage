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

  let keepAliveInterval;

  provider._websocket.on('open', () => {
    logMessage('WebSocket connection established.', {}, 'info');
    keepAliveInterval = setInterval(async () => {
      if (provider && provider._websocket.readyState === provider._websocket.OPEN) {
        try {
          await provider.getBlockNumber();
        } catch (err) {
          logMessage(`Keepalive error: ${err.message}`, {}, 'error');
        }
      }
    }, 30000);
  });

  provider._websocket.on('error', (error) => {
    logMessage(`WebSocket error: ${error.message}`, {}, 'error');
  });

  provider._websocket.on('close', (code, reason) => {
    logMessage(`WebSocket closed: ${code} - ${reason || 'No reason'}`, {}, 'error');
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    logMessage('Attempting to reconnect in 5 seconds...', {}, 'info');
    setTimeout(() => {
      initializeProvider();
    }, 5000);
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
    if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
      if (/^[a-fA-F0-9]{64}$/.test(privateKey)) {
        privateKey = '0x' + privateKey;
      } else {
        throw new Error('Invalid PRIVATE_KEY format.');
      }
    }

    initializeProvider();
    provider = wrapProviderWithLimiter(provider);
    wallet = new ethers.Wallet(privateKey, provider);
    logMessage(`Wallet: ${wallet.address}`, {}, 'info');

    if (settings.FLASHBOTS_ENABLED) {
      flashbotsProvider = await FlashbotsBundleProvider.create(
        provider,
        wallet,
        'https://relay.flashbots.net/'
      );
      logMessage('FlashbotsBundleProvider initialized.', {}, 'info');
    }

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

    const blockNumber = await executeWithRetry(() => provider.getBlockNumber());
    logMessage(`Connected to chain. Current block: ${blockNumber}`, {}, 'info');
    eventEmitter.emit('connected');
  } catch (err) {
    logMessage(`Error in initContracts(): ${err.message}`, {}, 'error');
    throw err;
  }
}

function getFactoryContract() {
  if (!factoryContract) throw new Error('Factory not initialized.');
  return factoryContract;
}

function getRouterContract() {
  if (!routerContract) throw new Error('Router not initialized.');
  return routerContract;
}

function getProvider() {
  if (!provider) throw new Error('Provider not initialized.');
  return provider;
}

function getWallet() {
  if (!wallet) throw new Error('Wallet not initialized.');
  return wallet;
}

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
  eventEmitter,
};
