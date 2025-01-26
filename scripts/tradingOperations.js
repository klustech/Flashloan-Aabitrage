// scripts/tradingOperations.js

const { evaluatePair, isHoneypot } = require('./evaluation'); // Updated import
const { getAdjustedGasPrice, getCurrentTokenPrice } = require('./utils'); // Removed monitorTokenPrice
const { getRouterContract, getWallet, getFlashbotsProvider, getProvider } = require('./contracts');
const { logMessage } = require('./logging');
const { getSettings } = require('./settings');
const { ethers } = require('ethers');
const { executeWithRetry } = require('./retry');
const { successfulTrades } = require('./state');
const { insertTrade } = require('./database');

// ─────────────────────────────────────────────────────────
// 1) Debug logs to confirm if evaluatePair & isHoneypot load
// ─────────────────────────────────────────────────────────
logMessage(`evaluatePair is a ${typeof evaluatePair}`, {}, 'info');
logMessage(`isHoneypot is a ${typeof isHoneypot}`, {}, 'info');

/**
 * Executes a purchase using Flashbots if enabled, else falls back to the public mempool.
 * @param {string} pairAddress - Address of the liquidity pair.
 * @param {string} token0 - Address of token0.
 * @param {string} token1 - Address of token1.
 */
async function executePurchase(pairAddress, token0, token1) {
    const settings = getSettings();
    try {
        logMessage(`Executing purchase on pair ${pairAddress}...`, {}, 'info');

        const baseTokenAddress = settings.BASE_TOKEN_ADDRESS.toLowerCase();
        const tokenToBuy = token1.toLowerCase() === baseTokenAddress ? token0 : token1;

        // Defensive check
        if (typeof evaluatePair !== 'function') {
            throw new Error('evaluatePair is not a function');
        }

        // Evaluate pair
        const pairOk = await evaluatePair(pairAddress, token0, token1);
        if (!pairOk) {
            logMessage(`Pair ${pairAddress} did not pass checks.`, {}, 'warn');
            return;
        }

        // Honeypot check
        if (await isHoneypot(tokenToBuy)) {
            logMessage(`Token ${tokenToBuy} appears to be a honeypot.`, {}, 'error');
            return;
        }

        const path = [baseTokenAddress, tokenToBuy];
        const deadline = Math.floor(Date.now() / 1000) + settings.DEADLINE_BUFFER;
        const { maxFeePerGas, maxPriorityFeePerGas } = await getAdjustedGasPrice();
        const amountIn = ethers.utils.parseEther(settings.ETH_AMOUNT_TO_SWAP.toString());

        // Build transaction data for the swap
        const router = getRouterContract();
        const wallet = getWallet();
        const swapData = router.interface.encodeFunctionData('swapExactETHForTokens', [
            0, // amountOutMin
            path,
            wallet.address, // Ensure 'to' is not the zero address
            deadline
        ]);

        const txRequest = {
            chainId: (await getProvider().getNetwork()).chainId,
            type: 2, // EIP-1559
            value: amountIn,
            data: swapData,
            to: router.address,
            maxFeePerGas,
            maxPriorityFeePerGas,
            gasLimit: 200000,
            nonce: await getProvider().getTransactionCount(wallet.address, 'latest'),
        };

        // Attempt Flashbots
        const flashbotsProvider = await getFlashbotsProvider();
        if (flashbotsProvider) {
            logMessage('Sending purchase via Flashbots bundle...', {}, 'info');
            const signedTx = await wallet.signTransaction(txRequest);

            // Parse the signed transaction to obtain the correct transaction hash
            const parsedTx = ethers.utils.parseTransaction(signedTx);
            const txHash = parsedTx.hash;

            // Send bundle to the next block
            const blockNumber = await getProvider().getBlockNumber();
            const bundleResponse = await flashbotsProvider.sendBundle(
                [{ signedTransaction: signedTx }],
                blockNumber + 1
            );

            const bundleResolution = await bundleResponse.wait();
            if (bundleResolution === 0) {
                // 0 => included
                logMessage('Flashbots bundle included in block!', {}, 'info');

                // Wait for transaction confirmation using the correct txHash
                const receipt = await getProvider().waitForTransaction(txHash);
                logMessage(`Purchase confirmed: ${receipt.transactionHash}`, {}, 'info');

                await recordBuyTrade(pairAddress, tokenToBuy, txHash);
            } else {
                // If not included, fallback
                logMessage(`Flashbots bundle not included! Code: ${bundleResolution}`, {}, 'error');
                await fallbackMempoolPurchase(path, deadline, amountIn, maxFeePerGas, maxPriorityFeePerGas);
            }
        } else {
            // Flashbots is disabled; proceed with mempool
            logMessage('Flashbots disabled. Using public mempool.', {}, 'warn');
            await fallbackMempoolPurchase(path, deadline, amountIn, maxFeePerGas, maxPriorityFeePerGas);
        }
    } catch (error) {
        logMessage(`executePurchase error: ${error.reason || error.message}`, {}, 'error');
    }
}

/**
 * If Flashbots fails or is disabled, perform a normal mempool transaction.
 * @param {string[]} path - The swap path.
 * @param {number} deadline - Transaction deadline.
 * @param {ethers.BigNumber} amountIn - Amount of ETH to swap.
 * @param {ethers.BigNumber} maxFeePerGas - Max fee per gas.
 * @param {ethers.BigNumber} maxPriorityFeePerGas - Max priority fee per gas.
 */
async function fallbackMempoolPurchase(path, deadline, amountIn, maxFeePerGas, maxPriorityFeePerGas) {
    const router = getRouterContract();
    const wallet = getWallet();

    try {
        const tx = await router.swapExactETHForTokens(
            0,
            path,
            wallet.address, // Ensure 'to' is not the zero address
            deadline,
            {
                gasLimit: 200000,
                maxFeePerGas,
                maxPriorityFeePerGas,
                value: amountIn,
            }
        );
        logMessage(`Purchase (fallback) tx sent: ${tx.hash}`, {}, 'info');
        const receipt = await tx.wait();
        logMessage(`Purchase confirmed: ${receipt.transactionHash}`, {}, 'info');

        await recordBuyTrade(path[1], path[1], tx.hash);
    } catch (error) {
        logMessage(`Fallback purchase error: ${error.reason || error.message}`, {}, 'error');
    }
}

/**
 * Record buy trade, store buy price, and auto-monitor price for potential sell.
 * @param {string} pairAddress - Address of the liquidity pair.
 * @param {string} tokenToBuy - Address of the token bought.
 * @param {string} txHash - Transaction hash of the buy.
 */
async function recordBuyTrade(pairAddress, tokenToBuy, txHash) {
    const settings = getSettings();

    // 1) Calculate approximate buy price in ETH
    const buyPriceInETH = await getTokenBuyPriceEstimate(
        tokenToBuy,
        ethers.utils.parseEther(settings.ETH_AMOUNT_TO_SWAP.toString())
    );

    // 2) Store the trade with buyPriceInETH
    const tradeDetails = {
        timestamp: new Date().toISOString(),
        tokenAddress: tokenToBuy,
        pairAddress,
        amountIn: settings.ETH_AMOUNT_TO_SWAP.toString(),
        txHash,
        type: 'buy',
        buyPriceInETH: buyPriceInETH.toString(),
    };
    successfulTrades.push(tradeDetails);
    await insertTrade(tradeDetails);

    // 3) Start monitoring the token for an auto-sell
    // UNCOMMENT BELOW to enable automated TP/SL checks:
    await monitorTokenPrice(tokenToBuy, buyPriceInETH);
}

/**
 * Approximates buy price in ETH by using router.getAmountsOut(1 token).
 * @param {string} tokenAddress - The address of the token.
 * @param {ethers.BigNumber} spentEthBN - Amount of ETH spent.
 * @returns {Promise<number>} - Approximate buy price in ETH.
 */
async function getTokenBuyPriceEstimate(tokenAddress, spentEthBN) {
    try {
        const router = getRouterContract();
        const path = [tokenAddress, getSettings().BASE_TOKEN_ADDRESS];
        const oneToken = ethers.utils.parseUnits('1', 18); // Adjust decimals as needed
        const amountsOut = await executeWithRetry(() => router.getAmountsOut(oneToken, path));
        return parseFloat(ethers.utils.formatEther(amountsOut[1]));
    } catch (err) {
        logMessage(`getTokenBuyPriceEstimate error: ${err.message}`, {}, 'error');
        return 0;
    }
}

/**
 * Executes a sell transaction, attempting Flashbots first, then fallback to mempool.
 * @param {string} tokenAddress - Address of the token to sell.
 */
async function executeSell(tokenAddress) {
    try {
        logMessage(`Executing sell for ${tokenAddress}...`, {}, 'info');
        const { maxFeePerGas, maxPriorityFeePerGas } = await getAdjustedGasPrice();

        // Approve if needed
        const router = getRouterContract();
        const wallet = getWallet();

        const tokenContract = new ethers.Contract(tokenAddress, [
            'function approve(address spender, uint256 amount) external returns (bool)',
            'function allowance(address owner, address spender) view returns (uint256)',
            'function balanceOf(address owner) view returns (uint256)',
        ], wallet);

        const allowance = await executeWithRetry(() => tokenContract.allowance(wallet.address, router.address));
        const balance = await executeWithRetry(() => tokenContract.balanceOf(wallet.address));

        if (balance.eq(0)) {
            logMessage('No token balance to sell.', {}, 'warn');
            return;
        }

        if (allowance.lt(balance)) {
            // Approve
            const approveTx = await tokenContract.approve(
                router.address,
                ethers.constants.MaxUint256,
                {
                    gasLimit: 100000,
                    maxFeePerGas,
                    maxPriorityFeePerGas,
                }
            );
            await approveTx.wait();
            logMessage('Router approved for token spend.', {}, 'info');
        }

        // Build the swap data
        const deadline = Math.floor(Date.now() / 1000) + getSettings().DEADLINE_BUFFER;
        const path = [tokenAddress, getSettings().BASE_TOKEN_ADDRESS];

        const swapData = router.interface.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens', [
            balance.toString(),
            0,
            path,
            wallet.address, // Ensure 'to' is not the zero address
            deadline
        ]);

        const txRequest = {
            chainId: (await getProvider().getNetwork()).chainId,
            type: 2, // EIP-1559
            to: router.address,
            data: swapData,
            maxFeePerGas,
            maxPriorityFeePerGas,
            gasLimit: 300000,
            nonce: await getProvider().getTransactionCount(wallet.address, 'latest'),
        };

        // Attempt Flashbots
        const flashbotsProvider = await getFlashbotsProvider();
        if (flashbotsProvider) {
            logMessage('Sending sell via Flashbots bundle...', {}, 'info');
            const signedTx = await wallet.signTransaction(txRequest);
            const parsedTx = ethers.utils.parseTransaction(signedTx);
            const txHash = parsedTx.hash;

            const blockNumber = await getProvider().getBlockNumber();
            const bundleResponse = await flashbotsProvider.sendBundle(
                [{ signedTransaction: signedTx }],
                blockNumber + 1
            );

            const bundleResolution = await bundleResponse.wait();
            if (bundleResolution === 0) {
                logMessage('Flashbots sell bundle included!', {}, 'info');

                const receipt = await getProvider().waitForTransaction(txHash);
                logMessage(`Sell confirmed: ${receipt.transactionHash}`, {}, 'info');

                await recordSellTrade(tokenAddress, balance, txHash);
            } else {
                logMessage(`Flashbots sell bundle not included. Code: ${bundleResolution}`, {}, 'error');
                await fallbackMempoolSell(tokenAddress, balance);
            }
        } else {
            logMessage('Flashbots disabled. Using public mempool for sell.', {}, 'warn');
            await fallbackMempoolSell(tokenAddress, balance);
        }
    } catch (error) {
        logMessage(`executeSell error: ${error.reason || error.message}`, {}, 'error');
    }
}

/**
 * Fallback to normal mempool for sell.
 * @param {string} tokenAddress - Address of the token to sell.
 * @param {ethers.BigNumber} balance - Amount of tokens to sell.
 */
async function fallbackMempoolSell(tokenAddress, balance) {
    const router = getRouterContract();
    const wallet = getWallet();
    const { maxFeePerGas, maxPriorityFeePerGas } = await getAdjustedGasPrice();

    const path = [tokenAddress, getSettings().BASE_TOKEN_ADDRESS];
    const deadline = Math.floor(Date.now() / 1000) + getSettings().DEADLINE_BUFFER;

    try {
        const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            balance.toString(),
            0,
            path,
            wallet.address, // Ensure 'to' is not the zero address
            deadline,
            {
                maxFeePerGas,
                maxPriorityFeePerGas,
                gasLimit: 300000,
            }
        );

        logMessage(`Sell (fallback) tx sent: ${tx.hash}`, {}, 'info');
        const receipt = await tx.wait();
        logMessage(`Sell confirmed: ${receipt.transactionHash}`, {}, 'info');

        await recordSellTrade(tokenAddress, balance, tx.hash);
    } catch (error) {
        logMessage(`Fallback sell error: ${error.reason || error.message}`, {}, 'error');
    }
}

/**
 * Records a sell trade in the database.
 * @param {string} tokenAddress - Address of the token sold.
 * @param {ethers.BigNumber} amountInBN - Amount of tokens sold.
 * @param {string} txHash - Transaction hash of the sell.
 */
async function recordSellTrade(tokenAddress, amountInBN, txHash) {
    const tradeDetails = {
        timestamp: new Date().toISOString(),
        tokenAddress,
        amountIn: ethers.utils.formatUnits(amountInBN, 18),
        txHash,
        type: 'sell',
    };
    successfulTrades.push(tradeDetails);
    await insertTrade(tradeDetails);
}

// ───────────────────────────────────────────────────────────────────
// ADDED BELOW: minimal, self-contained "monitorTokenPrice" function
// ───────────────────────────────────────────────────────────────────

const monitoringIntervals = {}; // Track intervals by token for preventing duplicates

/**
 * Monitors the token price periodically, auto-executing sell on profit or loss threshold.
 *
 * @param {string} tokenAddress - The newly purchased token address.
 * @param {number} buyPriceInETH - Approximate buy price in ETH (from getTokenBuyPriceEstimate).
 */
async function monitorTokenPrice(tokenAddress, buyPriceInETH) {
    const settings = getSettings();

    // Convert the user’s thresholds (PROFIT_THRESHOLD, STOP_LOSS_THRESHOLD) from percentages to factors.
    // e.g. PROFIT_THRESHOLD=5 => factorProfit=1.05 (5% above buy price)
    // e.g. STOP_LOSS_THRESHOLD=20 => factorStop=0.80 (20% below buy price)
    const factorProfit = 1 + (settings.PROFIT_THRESHOLD / 100);
    const factorStop = 1 - (settings.STOP_LOSS_THRESHOLD / 100);

    // Clear any existing interval for this token to avoid duplications
    if (monitoringIntervals[tokenAddress]) {
        clearInterval(monitoringIntervals[tokenAddress]);
    }

    // Periodic check function
    const checkPrice = async () => {
        try {
            const currentPrice = await getCurrentTokenPrice(tokenAddress);
            if (!currentPrice || currentPrice <= 0) return;

            // If price >= buyPriceInETH * factorProfit => take profit
            if (currentPrice >= (buyPriceInETH * factorProfit)) {
                logMessage(
                  `TP Triggered for ${tokenAddress}: currentPrice=${currentPrice} buyPrice=${buyPriceInETH}`,
                  {},
                  'info'
                );
                await executeSell(tokenAddress);

                // Once sold, stop monitoring
                clearInterval(monitoringIntervals[tokenAddress]);
                delete monitoringIntervals[tokenAddress];
            }
            // If price <= buyPriceInETH * factorStop => stop loss
            else if (currentPrice <= (buyPriceInETH * factorStop)) {
                logMessage(
                  `SL Triggered for ${tokenAddress}: currentPrice=${currentPrice} buyPrice=${buyPriceInETH}`,
                  {},
                  'info'
                );
                await executeSell(tokenAddress);

                // Once sold, stop monitoring
                clearInterval(monitoringIntervals[tokenAddress]);
                delete monitoringIntervals[tokenAddress];
            }
        } catch (err) {
            logMessage(`Error in monitorTokenPrice for ${tokenAddress}: ${err.message}`, {}, 'error');
        }
    };

    // Set up the interval using MONITOR_DELAY_MS from settings
    monitoringIntervals[tokenAddress] = setInterval(checkPrice, settings.MONITOR_DELAY_MS);

    logMessage(
      `Started monitoring ${tokenAddress}.
       BuyPrice=${buyPriceInETH},
       ProfitFactor=${factorProfit},
       StopFactor=${factorStop}`,
      {},
      'info'
    );
}

// ─────────────────────────────────────────────────────────
// Export the main entry points. All else remains unchanged.
// ─────────────────────────────────────────────────────────
module.exports = {
    executePurchase,
    executeSell,
};
