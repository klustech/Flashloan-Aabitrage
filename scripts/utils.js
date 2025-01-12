// scripts/utils.js

const { logMessage } = require('./logging');
const { getSettings } = require('./settings');
const { ethers } = require('ethers');
const { executeWithRetry } = require('./retry');
const { getRouterContract, getProvider } = require('./contracts');
// Removed the following line to eliminate circular dependency:
// const { executeSell } = require('./tradingOperations'); // To call auto-sell

/**
 * Sleep helper.
 */
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

/**
 * Retrieves current token price in ETH.
 * @param {string} tokenAddress - The address of the token.
 * @returns {Promise<number>} - Current price in ETH.
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
 * @returns {Promise<{ maxFeePerGas: ethers.BigNumber, maxPriorityFeePerGas: ethers.BigNumber }>}
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

module.exports = {
    sleep,
    getCurrentTokenPrice,
    getAdjustedGasPrice
};
