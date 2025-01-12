// scripts/utils.js

const { logMessage } = require('./logging');
const { getSettings } = require('./settings');
const { ethers } = require('ethers');
const { executeWithRetry } = require('./retry');
const { getRouterContract, getProvider } = require('./contracts');
const { executeSell } = require('./tradingOperations'); // To call auto-sell

/**
 * Sleep helper.
 */
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

/**
 * Checks if a token is a honeypot by simulating multiple function calls.
 */
async function isHoneypot(tokenAddress) {
    const settings = getSettings();
    const provider = getProvider();
    const wallet = ethers.Wallet.createRandom().connect(provider);

    const tokenAbi = [
        'function transfer(address to, uint256 amount) external returns (bool)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function transferFrom(address from, address to, uint256 amount) external returns (bool)',
    ];

    const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, wallet);

    try {
        await executeWithRetry(() => tokenContract.callStatic.transfer(
            ethers.constants.AddressZero,
            ethers.utils.parseUnits('1', 18)
        ));
        await executeWithRetry(() => tokenContract.callStatic.approve(
            wallet.address,
            ethers.utils.parseUnits('1', 18)
        ));
        await executeWithRetry(() => tokenContract.callStatic.transferFrom(
            wallet.address,
            wallet.address,
            ethers.utils.parseUnits('1', 18)
        ));
        // If all pass, not a honeypot
        return false;
    } catch (err) {
        logMessage(`Honeypot check fail for ${tokenAddress}: ${err.message}`, {}, 'error');
        return true;
    }
}

/**
 * Evaluates pair liquidity, etc.
 */
async function evaluatePair(pairAddress, token0, token1) {
    const settings = getSettings();
    const provider = getProvider();

    try {
        const pairAbi = [
            'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
        ];
        const pairContract = new ethers.Contract(pairAddress, pairAbi, provider);

        const reserves = await executeWithRetry(() => pairContract.getReserves());
        const reserve0 = parseFloat(ethers.utils.formatUnits(reserves.reserve0, settings.BASE_TOKEN_DECIMALS || 18));
        const reserve1 = parseFloat(ethers.utils.formatUnits(reserves.reserve1, settings.TOKEN_DECIMALS || 18));

        logMessage(`Reserves => 0: ${reserve0}, 1: ${reserve1}`, {}, 'info');

        if (reserve0 < (settings.MIN_BASE_TOKEN_RESERVE || 1)) {
            logMessage(`Base token reserve too low: ${reserve0} < ${settings.MIN_BASE_TOKEN_RESERVE}`, {}, 'error');
            return false;
        }

        return true;
    } catch (err) {
        logMessage(`evaluatePair error: ${err.message}`, {}, 'error');
        return false;
    }
}

/**
 * Retrieves current token price in ETH.
 */
async function getCurrentTokenPrice(tokenAddress) {
    const settings = getSettings();
    const router = getRouterContract();

    try {
        const amountIn = ethers.utils.parseUnits('1', settings.BASE_TOKEN_DECIMALS || 18);
        const path = [tokenAddress, settings.BASE_TOKEN_ADDRESS];
        const amountsOut = await executeWithRetry(() => router.getAmountsOut(amountIn, path));
        const priceInETH = parseFloat(ethers.utils.formatEther(amountsOut[amountsOut.length - 1]));
        return priceInETH;
    } catch (err) {
        logMessage(`getCurrentTokenPrice error for ${tokenAddress}: ${err.message}`, {}, 'error');
        throw err;
    }
}

/**
 * Retrieves/adjusts gas prices for EIP-1559 transactions (Dynamic Gas Bidding).
 */
async function getAdjustedGasPrice() {
    const settings = getSettings();
    const provider = getProvider();

    try {
        const feeData = await executeWithRetry(() => provider.getFeeData());
        if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas) {
            throw new Error('Missing fee data.');
        }

        // Example dynamic logic:
        // If baseFee < 20 gwei => minimal multiplier
        // If 20 <= baseFee < 60 => normal multiplier
        // If baseFee >= 60 => more aggressive
        const baseFee = feeData.maxFeePerGas; // EIP-1559 base fee
        const priorityFee = feeData.maxPriorityFeePerGas;
        const baseFeeGwei = parseFloat(ethers.utils.formatUnits(baseFee, 'gwei'));
        logMessage(`BaseFee in Gwei: ${baseFeeGwei}`, {}, 'info');

        let multiplier;
        if (baseFeeGwei < 20) {
            multiplier = ethers.BigNumber.from('1');
        } else if (baseFeeGwei < 60) {
            multiplier = ethers.BigNumber.from(settings.GAS_PRICE_MULTIPLIER || '2');
        } else {
            // Big hype scenario
            multiplier = ethers.BigNumber.from(settings.HYPE_GAS_MULTIPLIER || '3');
        }

        const maxFeePerGas = baseFee.mul(multiplier);
        const maxPriorityFeePerGas = priorityFee.mul(multiplier);

        return { maxFeePerGas, maxPriorityFeePerGas };
    } catch (err) {
        logMessage(`getAdjustedGasPrice error: ${err.message}`, {}, 'error');
        throw err;
    }
}

/**
 * Monitors token price post-purchase for potential selling (Auto-Sell).
 */
async function monitorTokenPrice(tokenAddress, buyPriceInETH) {
    const settings = getSettings();
    logMessage(`Monitoring price for ${tokenAddress} at buy price ${buyPriceInETH} ETH...`, {}, 'info');

    setTimeout(async () => {
        try {
            const currentPrice = await getCurrentTokenPrice(tokenAddress);
            logMessage(`Current price for ${tokenAddress}: ${currentPrice} ETH.`, {}, 'info');

            // If currentPrice >= buyPriceInETH * threshold => AUTO-SELL
            const profitTargetMultiplier = settings.PROFIT_THRESHOLD_FACTOR || 1.20; // e.g. 20% profit
            if (currentPrice >= buyPriceInETH * profitTargetMultiplier) {
                logMessage(
                    `Price threshold reached for ${tokenAddress}! AUTO-SELL triggered...`,
                    {},
                    'info'
                );
                await executeSell(tokenAddress);
            } else {
                // Price not high enough yet, re-check in another interval
                logMessage(`Price not at profit target yet. Re-checking in 60s...`, {}, 'info');
                monitorTokenPrice(tokenAddress, buyPriceInETH);
            }
        } catch (error) {
            logMessage(`monitorTokenPrice error: ${error.message}`, {}, 'error');
        }
    }, settings.MONITOR_DELAY_MS || 60000);
}

module.exports = {
    isHoneypot,
    evaluatePair,
    getCurrentTokenPrice,
    getAdjustedGasPrice,
    monitorTokenPrice,
    sleep,
};
