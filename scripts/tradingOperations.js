// scripts/tradingOperations.js

const { evaluatePair, isHoneypot } = require('./evaluation');
const { getAdjustedGasPrice, getCurrentTokenPrice } = require('./utils');
const { getRouterContract, getWallet, getFlashbotsProvider, getProvider } = require('./contracts');
const { logMessage } = require('./logging');
const { getSettings } = require('./settings');
const { ethers } = require('ethers');
const { executeWithRetry } = require('./retry');
const { successfulTrades } = require('./state');
const { insertTrade } = require('./database');

logMessage(`evaluatePair is a ${typeof evaluatePair}`, {}, 'info');
logMessage(`isHoneypot is a ${typeof isHoneypot}`, {}, 'info');

const MAX_FLASHBOTS_RETRIES = 3;

/**
 * Checks that the wallet has sufficient funds for the transaction.
 * @param {ethers.BigNumber} requiredAmount
 */
async function checkSufficientBalance(requiredAmount) {
  const wallet = getWallet();
  const balance = await wallet.getBalance();
  if (balance.lt(requiredAmount)) {
    throw new Error('Insufficient funds for transaction and gas');
  }
}

/**
 * Executes a purchase using Flashbots if enabled; otherwise, falls back to the public mempool.
 * @param {string} pairAddress
 * @param {string} token0
 * @param {string} token1
 */
async function executePurchase(pairAddress, token0, token1) {
  const settings = getSettings();
  try {
    logMessage(`Executing purchase on pair ${pairAddress}...`, {}, 'info');

    const baseTokenAddress = settings.BASE_TOKEN_ADDRESS.toLowerCase();
    const tokenToBuy = token1.toLowerCase() === baseTokenAddress ? token0 : token1;

    // Evaluate pair viability (now including token risk)
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
    let { maxFeePerGas, maxPriorityFeePerGas } = await getAdjustedGasPrice();
    const amountIn = ethers.utils.parseEther(settings.ETH_AMOUNT_TO_SWAP.toString());
    const gasLimit = ethers.BigNumber.from(200000);
    const estimatedCost = amountIn.add(gasLimit.mul(maxFeePerGas));
    await checkSufficientBalance(estimatedCost);

    const router = getRouterContract();
    const wallet = getWallet();
    const swapData = router.interface.encodeFunctionData('swapExactETHForTokens', [
      0,
      path,
      wallet.address,
      deadline
    ]);

    const txRequest = {
      chainId: (await getProvider().getNetwork()).chainId,
      type: 2,
      value: amountIn,
      data: swapData,
      to: router.address,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasLimit,
      nonce: await getProvider().getTransactionCount(wallet.address, 'latest'),
    };

    // Attempt Flashbots if enabled
    const flashbotsProvider = await getFlashbotsProvider();
    if (flashbotsProvider) {
      let attempt = 0;
      let bundleIncluded = false;
      let txHash;
      while (attempt < MAX_FLASHBOTS_RETRIES && !bundleIncluded) {
        logMessage(`Attempt ${attempt + 1} to send Flashbots bundle with gas parameters: maxFeePerGas=${maxFeePerGas.toString()}, maxPriorityFeePerGas=${maxPriorityFeePerGas.toString()}`, {}, 'info');
        const signedTx = await wallet.signTransaction(txRequest);
        const parsedTx = ethers.utils.parseTransaction(signedTx);
        txHash = parsedTx.hash;
        const blockNumber = await getProvider().getBlockNumber();
        const bundleResponse = await flashbotsProvider.sendBundle(
          [{ signedTransaction: signedTx }],
          blockNumber + 1
        );
        const bundleResolution = await bundleResponse.wait();
        if (bundleResolution === 0) {
          logMessage('Flashbots bundle included in block!', {}, 'info');
          bundleIncluded = true;
          break;
        } else {
          logMessage(`Flashbots bundle not included on attempt ${attempt + 1}. Code: ${bundleResolution}`, {}, 'error');
          // Increase gas parameters by 10%
          maxFeePerGas = maxFeePerGas.mul(110).div(100);
          maxPriorityFeePerGas = maxPriorityFeePerGas.mul(110).div(100);
          txRequest.maxFeePerGas = maxFeePerGas;
          txRequest.maxPriorityFeePerGas = maxPriorityFeePerGas;
          attempt++;
        }
      }
      if (bundleIncluded) {
        const receipt = await getProvider().waitForTransaction(txHash);
        logMessage(`Purchase confirmed: ${receipt.transactionHash}`, {}, 'info');
        await recordBuyTrade(pairAddress, tokenToBuy, txHash);
        return;
      } else {
        logMessage(`Flashbots bundle failed after ${MAX_FLASHBOTS_RETRIES} attempts; falling back to public mempool.`, {}, 'warn');
        await fallbackMempoolPurchase(path, deadline, amountIn, maxFeePerGas, maxPriorityFeePerGas);
      }
    } else {
      logMessage('Flashbots disabled. Using public mempool.', {}, 'warn');
      await fallbackMempoolPurchase(path, deadline, amountIn, maxFeePerGas, maxPriorityFeePerGas);
    }
  } catch (error) {
    logMessage(`executePurchase error: ${error.reason || error.message}`, {}, 'error');
  }
}

/**
 * Fallback: Execute purchase via public mempool.
 */
async function fallbackMempoolPurchase(path, deadline, amountIn, maxFeePerGas, maxPriorityFeePerGas) {
  const router = getRouterContract();
  const wallet = getWallet();
  try {
    const tx = await router.swapExactETHForTokens(
      0,
      path,
      wallet.address,
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
 * Records a buy trade and starts dynamic monitoring.
 */
async function recordBuyTrade(pairAddress, tokenToBuy, txHash) {
  const settings = getSettings();
  const buyPriceInETH = await getTokenBuyPriceEstimate(
    tokenToBuy,
    ethers.utils.parseEther(settings.ETH_AMOUNT_TO_SWAP.toString())
  );
  const tradeDetails = {
    timestamp: new Date().toISOString(),
    tokenAddress: tokenToBuy,
    pairAddress,
    amountIn: settings.ETH_AMOUNT_TO_SWAP.toString(),
    txHash,
    type: 'buy',
    state: 'Holding',
    buyPriceInETH: buyPriceInETH.toString()
  };
  successfulTrades.push(tradeDetails);
  await insertTrade(tradeDetails);
  // Start dynamic price monitoring
  await monitorTokenPrice(tokenToBuy, buyPriceInETH);
  // NEW: Also start monitoring for abnormal swap (sell) events on the bought token’s pair
  await monitorBoughtTokenSwaps(tokenToBuy, pairAddress);
}

/**
 * Approximates the buy price in ETH using getAmountsOut.
 */
async function getTokenBuyPriceEstimate(tokenAddress, spentEthBN) {
  try {
    const router = getRouterContract();
    const path = [tokenAddress, getSettings().BASE_TOKEN_ADDRESS];
    const oneToken = ethers.utils.parseUnits('1', 18);
    const amountsOut = await executeWithRetry(() => router.getAmountsOut(oneToken, path));
    return parseFloat(ethers.utils.formatEther(amountsOut[1]));
  } catch (err) {
    logMessage(`getTokenBuyPriceEstimate error: ${err.message}`, {}, 'error');
    return 0;
  }
}

/**
 * Executes a sell transaction.
 */
async function executeSell(tokenAddress) {
  try {
    logMessage(`Executing sell for ${tokenAddress}...`, {}, 'info');
    const { maxFeePerGas, maxPriorityFeePerGas } = await getAdjustedGasPrice();
    const router = getRouterContract();
    const wallet = getWallet();
    const tokenContract = new ethers.Contract(tokenAddress, [
      'function approve(address spender, uint256 amount) external returns (bool)',
      'function allowance(address owner, address spender) view returns (uint256)',
      'function balanceOf(address owner) view returns (uint256)'
    ], wallet);

    const allowance = await executeWithRetry(() => tokenContract.allowance(wallet.address, router.address));
    const balance = await executeWithRetry(() => tokenContract.balanceOf(wallet.address));
    if (balance.eq(0)) {
      logMessage('No token balance to sell.', {}, 'warn');
      return;
    }
    if (allowance.lt(balance)) {
      const approveTx = await tokenContract.approve(
        router.address,
        ethers.constants.MaxUint256,
        { gasLimit: 100000, maxFeePerGas, maxPriorityFeePerGas }
      );
      await approveTx.wait();
      logMessage('Router approved for token spend.', {}, 'info');
    }

    const deadline = Math.floor(Date.now() / 1000) + getSettings().DEADLINE_BUFFER;
    const path = [tokenAddress, getSettings().BASE_TOKEN_ADDRESS];
    const swapData = router.interface.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens', [
      balance.toString(),
      0,
      path,
      wallet.address,
      deadline
    ]);

    const txRequest = {
      chainId: (await getProvider().getNetwork()).chainId,
      type: 2,
      to: router.address,
      data: swapData,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasLimit: 300000,
      nonce: await getProvider().getTransactionCount(wallet.address, 'latest'),
    };

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
 * Fallback: Execute sell via public mempool.
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
      wallet.address,
      deadline,
      { maxFeePerGas, maxPriorityFeePerGas, gasLimit: 300000 }
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
 * Records a sell trade.
 */
async function recordSellTrade(tokenAddress, amountInBN, txHash) {
  const tradeDetails = {
    timestamp: new Date().toISOString(),
    tokenAddress,
    amountIn: ethers.utils.formatUnits(amountInBN, 18),
    txHash,
    type: 'sell',
    state: 'Sold'
  };
  successfulTrades.push(tradeDetails);
  await insertTrade(tradeDetails);
}

/**
 * Dynamic monitoring for trailing TP/SL.
 */
const monitoringIntervals = {};

async function monitorTokenPrice(tokenAddress, buyPriceInETH) {
  const settings = getSettings();
  let highestPrice = buyPriceInETH;
  let dynamicTPThreshold = buyPriceInETH * (1 + settings.PROFIT_THRESHOLD / 100);
  let dynamicSLThreshold = buyPriceInETH * (1 - settings.STOP_LOSS_THRESHOLD / 100);

  if (monitoringIntervals[tokenAddress]) {
    clearInterval(monitoringIntervals[tokenAddress]);
  }

  const checkPrice = async () => {
    try {
      const currentPrice = await getCurrentTokenPrice(tokenAddress);
      if (!currentPrice || currentPrice <= 0) return;
      if (currentPrice > highestPrice) {
        highestPrice = currentPrice;
        dynamicTPThreshold = highestPrice * (1 + settings.PROFIT_THRESHOLD / 100);
        dynamicSLThreshold = highestPrice * (1 - settings.STOP_LOSS_THRESHOLD / 100);
        logMessage(
          `New highest price for ${tokenAddress}: ${highestPrice}. Updated thresholds: TP=${dynamicTPThreshold}, SL=${dynamicSLThreshold}`,
          {},
          'info'
        );
      }
      if (currentPrice >= dynamicTPThreshold) {
        logMessage(`Dynamic TP Triggered for ${tokenAddress}: currentPrice=${currentPrice}, dynamicTPThreshold=${dynamicTPThreshold}`, {}, 'info');
        await executeSell(tokenAddress);
        clearInterval(monitoringIntervals[tokenAddress]);
        delete monitoringIntervals[tokenAddress];
      } else if (currentPrice <= dynamicSLThreshold) {
        logMessage(`Dynamic SL Triggered for ${tokenAddress}: currentPrice=${currentPrice}, dynamicSLThreshold=${dynamicSLThreshold}`, {}, 'info');
        await executeSell(tokenAddress);
        clearInterval(monitoringIntervals[tokenAddress]);
        delete monitoringIntervals[tokenAddress];
      }
    } catch (err) {
      logMessage(`Error in monitorTokenPrice for ${tokenAddress}: ${err.message}`, {}, 'error');
    }
  };

  monitoringIntervals[tokenAddress] = setInterval(checkPrice, settings.MONITOR_DELAY_MS);
  logMessage(
    `Started dynamic monitoring for ${tokenAddress}.\nInitial BuyPrice=${buyPriceInETH},\nInitial dynamicTPThreshold=${dynamicTPThreshold},\nInitial dynamicSLThreshold=${dynamicSLThreshold}`,
    {},
    'info'
  );
}

/**
 * NEW: Monitors the pair contract for abnormal sell (swap) events.
 * If a swap event indicates that a large amount of the bought token is sold (exceeding a threshold of the reserve),
 * it immediately triggers a sell to frontrun the abnormal sell.
 *
 * @param {string} tokenAddress - The bought token's address.
 * @param {string} pairAddress - The pair contract address.
 */
async function monitorBoughtTokenSwaps(tokenAddress, pairAddress) {
  try {
    const provider = getProvider();
    const PAIR_SWAP_ABI = [
      "event Swap(uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address to)",
      "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
      "function token0() view returns (address)",
      "function token1() view returns (address)"
    ];
    const pairContract = new ethers.Contract(pairAddress, PAIR_SWAP_ABI, provider);
    
    logMessage(`Setting up swap event monitoring for token ${tokenAddress} on pair ${pairAddress}`, {}, 'info');
    
    // Define an abnormal threshold (e.g., if the sold amount is 10% or more of the reserve)
    const abnormalThreshold = 0.1;
    const listener = async (...args) => {
      // args: [amount0In, amount1In, amount0Out, amount1Out, to, event]
      const event = args[args.length - 1];
      const token0 = await pairContract.token0();
      const token1 = await pairContract.token1();
      const reserves = await pairContract.getReserves();
      let reserveToken, amountOut;
      if (tokenAddress.toLowerCase() === token0.toLowerCase()) {
        reserveToken = parseFloat(ethers.utils.formatUnits(reserves.reserve0, 18));
        amountOut = parseFloat(ethers.utils.formatUnits(args[2], 18)); // amount0Out
      } else if (tokenAddress.toLowerCase() === token1.toLowerCase()) {
        reserveToken = parseFloat(ethers.utils.formatUnits(reserves.reserve1, 18));
        amountOut = parseFloat(ethers.utils.formatUnits(args[3], 18)); // amount1Out
      } else {
        return; // Token not found in this pair
      }
      if (reserveToken > 0 && (amountOut / reserveToken) >= abnormalThreshold) {
        logMessage(`Abnormal sell detected for token ${tokenAddress}: amountOut ${amountOut} is ${((amountOut / reserveToken) * 100).toFixed(2)}% of reserve.`, {}, 'warn');
        await executeSell(tokenAddress);
        pairContract.off('Swap', listener);
      }
    };
    
    pairContract.on('Swap', listener);
  } catch (error) {
    logMessage(`Error setting up swap monitoring for token ${tokenAddress}: ${error.message}`, {}, 'error');
  }
}

module.exports = {
  executePurchase,
  executeSell
};
