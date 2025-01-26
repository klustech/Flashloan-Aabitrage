// scripts/evaluation.js

const { getSettings } = require('./settings');
const { ethers } = require('ethers');
const { executeWithRetry } = require('./retry');
const { logMessage } = require('./logging');
const { getProvider } = require('./contracts');

/**
 * Checks if a token is a honeypot by simulating a small transfer.
 *
 * @param {string} tokenAddress
 * @returns {Promise<boolean>} true if honeypot, false if not
 */
async function isHoneypot(tokenAddress) {
    const provider = getProvider();
    const wallet = ethers.Wallet.createRandom().connect(provider);

    const tokenAbi = [
        'function transfer(address to, uint256 amount) external returns (bool)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function transferFrom(address from, address to, uint256 amount) external returns (bool)',
    ];

    const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, wallet);

    try {
        // A small non-zero amount
        const smallAmount = ethers.utils.parseUnits('0.0001', 18);

        logMessage(`Attempting small transfer to check honeypot logic.`, {}, 'info');
        await executeWithRetry(() => tokenContract.callStatic.transfer(wallet.address, smallAmount));

        logMessage(`Approving small amount for honeypot check.`, {}, 'info');
        await executeWithRetry(() => tokenContract.callStatic.approve(wallet.address, smallAmount));

        logMessage(`transferFrom call for honeypot check.`, {}, 'info');
        await executeWithRetry(() => tokenContract.callStatic.transferFrom(wallet.address, wallet.address, smallAmount));

        // If no revert => not a honeypot
        logMessage(`Honeypot check passed for ${tokenAddress}.`, {}, 'info');
        return false;
    } catch (err) {
        logMessage(`Honeypot check fail for ${tokenAddress}: ${err.message}`, {}, 'error');
        return true;
    }
}

/**
 * Evaluates pair liquidity and other criteria
 */
async function evaluatePair(pairAddress, token0, token1) {
    try {
        const settings = getSettings();
        const provider = getProvider();

        const pairAbi = [
            'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
        ];
        const pairContract = new ethers.Contract(pairAddress, pairAbi, provider);

        const reserves = await executeWithRetry(() => pairContract.getReserves());

        // figure out base vs other
        const baseToken = settings.BASE_TOKEN_ADDRESS.toLowerCase();
        let baseReserve, otherReserve;

        if (token0.toLowerCase() === baseToken) {
            baseReserve = parseFloat(ethers.utils.formatUnits(reserves.reserve0, 18));
            otherReserve = parseFloat(ethers.utils.formatUnits(reserves.reserve1, 18));
        } else {
            baseReserve = parseFloat(ethers.utils.formatUnits(reserves.reserve1, 18));
            otherReserve = parseFloat(ethers.utils.formatUnits(reserves.reserve0, 18));
        }

        logMessage(`Reserves => Base Token: ${baseReserve}, Other Token: ${otherReserve}`, {}, 'info');

        const minBaseReserve = settings.MIN_BASE_TOKEN_RESERVE || 1;
        if (baseReserve < minBaseReserve) {
            logMessage(`Base token reserve too low: ${baseReserve} < ${minBaseReserve}`, {}, 'error');
            return false;
        }

        logMessage(`Pair ${pairAddress} passed reserve checks.`, {}, 'info');
        return true;
    } catch (err) {
        logMessage(`evaluatePair error: ${err.message}`, {}, 'error');
        return false;
    }
}

module.exports = {
    isHoneypot,
    evaluatePair
};
