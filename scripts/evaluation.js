// scripts/evaluation.js

const { getSettings } = require('./settings');
const { ethers } = require('ethers');
const { executeWithRetry } = require('./retry');
const { logMessage } = require('./logging');
const { getProvider } = require('./contracts');

/**
 * Checks if a token is a honeypot by simulating multiple function calls.
 * @param {string} tokenAddress - The address of the token to check.
 * @returns {Promise<boolean>} - Returns true if it's a honeypot, else false.
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
 * Evaluates pair liquidity and other criteria.
 * @param {string} pairAddress - The address of the pair contract.
 * @param {string} token0 - Address of token0.
 * @param {string} token1 - Address of token1.
 * @returns {Promise<boolean>} - Returns true if the pair is acceptable, else false.
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

module.exports = {
    isHoneypot,
    evaluatePair
};
