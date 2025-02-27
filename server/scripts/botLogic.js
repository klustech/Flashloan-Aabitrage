// botLogic.js

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
const { ethers } = require("ethers");
const fs = require("fs");
const axios = require("axios");
const winston = require("winston");
const { FlashbotsBundleProvider } = require("@flashbots/ethers-provider-bundle");

// -----------------------------
// Caching for External API Responses
// -----------------------------
const cache = {
  coinGecko: {},
  duration: 60000 // cache duration: 60 seconds
};

async function getCachedCoinGeckoPrice(coinId, vsCurrency) {
  const cacheKey = `${coinId}_${vsCurrency}`;
  const now = Date.now();
  if (cache.coinGecko[cacheKey] && now - cache.coinGecko[cacheKey].timestamp < cache.duration) {
    return cache.coinGecko[cacheKey].data;
  }
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=${vsCurrency}`;
    const response = await axios.get(url);
    cache.coinGecko[cacheKey] = { data: response.data, timestamp: now };
    return response.data;
  } catch (error) {
    throw new Error(`Failed to fetch price from CoinGecko for ${coinId}: ${error.message}`);
  }
}

// -----------------------------
// Logger configuration
// -----------------------------
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `[${timestamp}] [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "bot.log" })
  ]
});

// -----------------------------
// Environment & Config
// -----------------------------
const {
  PRIVATE_KEY,
  MAINNET_RPC_URL,
  SEPOLIA_RPC_URL,
  CONTRACT_ADDRESS,
  AAVE_LENDING_POOL_ADDRESS_PROVIDER,
  SLIPPAGE_BIPS,
  GAS_PRICE_CEILING,
  FLASHBOTS_RELAY_URL,
  MIN_PROFIT_DAI
} = process.env;

const RPC_URL = MAINNET_RPC_URL || SEPOLIA_RPC_URL;
if (!PRIVATE_KEY || !CONTRACT_ADDRESS || !AAVE_LENDING_POOL_ADDRESS_PROVIDER || !RPC_URL) {
  throw new Error("Missing required .env fields: PRIVATE_KEY, CONTRACT_ADDRESS, AAVE_LENDING_POOL_ADDRESS_PROVIDER, RPC_URL");
}
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Use SLIPPAGE_BIPS from environment (default to 50 bips)
const SLIPPAGE_DEFAULT_BIPS = SLIPPAGE_BIPS ? parseInt(SLIPPAGE_BIPS) : 50;
const GAS_PRICE_LIMIT_GWEI = GAS_PRICE_CEILING ? parseInt(GAS_PRICE_CEILING) : 50;

// Global settings (in DAI, 18 decimals)
let globalMinBorrowAmount = ethers.utils.parseUnits("100", 18); // Minimum borrow threshold in DAI

logger.info("===== Flashloan Arbitrage Bot Initialized =====");
logger.info("PRIVATE_KEY: Loaded");
logger.info("RPC_URL: " + RPC_URL);
logger.info("CONTRACT_ADDRESS: " + CONTRACT_ADDRESS);
logger.info("SLIPPAGE_TOLERANCE: " + SLIPPAGE_DEFAULT_BIPS + " bips");
logger.info("GAS_PRICE_LIMIT: " + GAS_PRICE_LIMIT_GWEI + " gwei");
logger.info("Global MIN_BORROW_AMOUNT: " + ethers.utils.formatUnits(globalMinBorrowAmount, 18) + " DAI");

// --------------------
// Token & DEX Setup
// --------------------
const tokenAddresses = {
  DAI: process.env.TOKENS_DAI,
  WETH: process.env.TOKENS_WETH,
  USDC: process.env.TOKENS_USDC,
  USDT: process.env.TOKENS_USDT,
  UNI: process.env.TOKENS_UNI
};

const allowedDEXs = ["Uniswap", "SushiSwap"];

// --------------------
// Load ABIs
// --------------------
function loadABI(relativePath) {
  const fullPath = path.resolve(__dirname, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`ABI file not found: ${fullPath}`);
  }
  const data = require(fullPath);
  return Array.isArray(data) ? data : data.abi;
}
const arbitrageABI = loadABI("./abis/ArbitrageFlashloan.json");
const uniswapRouterABI = loadABI("./abis/UniswapV2Router02.json");
const sushiRouterABI = loadABI("./abis/SushiSwapRouter.json");
// Minimal Aave ABIs
const aaveProviderABI = ["function getLendingPool() external view returns (address)"];
const aaveLendingPoolABI = ["function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint256)"];

// --------------------
// Contract Instances
// --------------------
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbitrageABI, wallet);
const uniswapRouter = new ethers.Contract(process.env.UNISWAP_ROUTER_ADDRESS, uniswapRouterABI, wallet);
const sushiSwapRouter = new ethers.Contract(process.env.SUSHISWAP_ROUTER_ADDRESS, sushiRouterABI, wallet);

// --------------------
// Helper Functions
// --------------------

// Calculate minimum output given slippage (using BigNumber arithmetic)
function calculateMinOut(amountOut, slippageBips) {
  return amountOut.mul(ethers.BigNumber.from(10000 - slippageBips))
                  .div(ethers.BigNumber.from(10000));
}

// --------------------
// Dynamic Borrow Amount Calculation
// --------------------

// Query available liquidity (balance) of a token in the lending pool
async function getAvailableLiquidity(token) {
  const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
  const tokenContract = new ethers.Contract(tokenAddresses[token], ERC20_ABI, provider);
  const lpProvider = new ethers.Contract(AAVE_LENDING_POOL_ADDRESS_PROVIDER, aaveProviderABI, provider);
  const lendingPoolAddress = await lpProvider.getLendingPool();
  const liquidity = await tokenContract.balanceOf(lendingPoolAddress);
  logger.info(`Available liquidity for ${token} in lending pool: ${ethers.utils.formatUnits(liquidity, 18)} tokens`);
  return liquidity;
}

// A simple simulation of a DAI → WETH → DAI route on Uniswap.
// Assumes a fixed conversion rate: 1 ETH = 2000 DAI, and applies a slippage tolerance.
function simulateRoute(tradeAmount, slippageTolerance) {
  const wethAmount = tradeAmount / 2000;
  const wethAfterSlippage = wethAmount * (1 - slippageTolerance);
  const daiOut = wethAfterSlippage * 2000 * (1 - slippageTolerance);
  return daiOut;
}

// Perform a linear search over trial borrow amounts (from globalMinBorrowAmount to 10% of available liquidity)
// and pick the one that yields the highest estimated net profit.
async function getOptimalBorrowAmount(token) {
  const availableLiquidity = await getAvailableLiquidity(token);
  const maxTrialBorrow = availableLiquidity.mul(10).div(100); // 10% of available liquidity
  const steps = 5;
  let bestProfit = -Infinity;
  let bestBorrowDai = ethers.BigNumber.from("0");

  const minBorrow = parseFloat(ethers.utils.formatUnits(globalMinBorrowAmount, 18));
  const maxBorrow = parseFloat(ethers.utils.formatUnits(maxTrialBorrow, 18));
  const slippageTolerance = SLIPPAGE_DEFAULT_BIPS / 10000; // e.g., 50 bips = 0.005

  for (let i = 1; i <= steps; i++) {
    const trialBorrowNum = minBorrow + ((maxBorrow - minBorrow) * i) / steps;
    const simulatedOutput = simulateRoute(trialBorrowNum, slippageTolerance);
    // Apply a flashloan premium of 9 bips (0.09%)
    const totalCost = trialBorrowNum * 1.0009;
    const profit = simulatedOutput - totalCost;
    logger.info(`Trial borrow: ${trialBorrowNum.toFixed(6)} DAI, simulated output: ${simulatedOutput.toFixed(6)} DAI, profit: ${profit.toFixed(6)} DAI`);
    if (profit > bestProfit) {
      bestProfit = profit;
      bestBorrowDai = ethers.utils.parseUnits(trialBorrowNum.toString(), 18);
    }
  }
  logger.info(`Optimal dynamic borrow: ${ethers.utils.formatUnits(bestBorrowDai, 18)} DAI (estimated net profit: ${bestProfit.toFixed(6)} DAI)`);
  // Convert the optimal borrow (in DAI) to WETH for the flashloan call using Uniswap.
  const amounts = await uniswapRouter.getAmountsOut(bestBorrowDai, [tokenAddresses.DAI, tokenAddresses.WETH]);
  const optimalBorrowWETH = amounts[1];
  logger.info(`Converted optimal borrow to WETH: ${ethers.utils.formatUnits(optimalBorrowWETH, 18)} WETH`);
  return optimalBorrowWETH;
}

// --------------------
// Other Utility Functions (Gas estimation, Aave premium, etc.)
// --------------------
async function getDynamicSlippage() {
  try {
    if (cache.dynamicSlippage && Date.now() - cache.dynamicSlippage.timestamp < cache.duration) {
      return cache.dynamicSlippage.value;
    }
    const endpoint = "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_24hr_change=true";
    const response = await axios.get(endpoint);
    const vol = Math.abs(response.data.ethereum.usd_24h_change) || 0;
    const baseSlippage = 50;
    const dynamicSlippage = Math.min(baseSlippage + Math.round(vol * 5), 200);
    logger.info(`Dynamic Slippage determined: ${dynamicSlippage} bips`);
    cache.dynamicSlippage = { value: dynamicSlippage, timestamp: Date.now() };
    return dynamicSlippage;
  } catch (error) {
    if (error.response && error.response.status === 429) {
      logger.warn("Rate-limited by CoinGecko, using default slippage");
    } else {
      logger.error(`Slippage fetch error: ${error.message}`);
    }
    return SLIPPAGE_DEFAULT_BIPS;
  }
}

async function estimateGasCostInDAI(txEstimate) {
  try {
    const gasPrice = await provider.getGasPrice();
    logger.info(`Current Gas Price: ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei`);
    const gasCostETH = txEstimate.mul(gasPrice);
    logger.info(`Estimated Gas Cost: ${ethers.utils.formatEther(gasCostETH)} ETH`);
    const ethPriceData = await getCachedCoinGeckoPrice("ethereum", "usd");
    const daiPriceData = await getCachedCoinGeckoPrice("dai", "usd");
    const costInDAI = parseFloat(ethers.utils.formatEther(gasCostETH)) * ethPriceData.ethereum.usd / daiPriceData.dai.usd;
    const gasCostInDAI = ethers.utils.parseUnits(costInDAI.toFixed(18), 18);
    logger.info(`Gas Cost in DAI: ${ethers.utils.formatUnits(gasCostInDAI, 18)} DAI`);
    return gasCostInDAI;
  } catch (error) {
    logger.error(`Gas estimation failed: ${error.message}`);
    return ethers.constants.Zero;
  }
}

async function getAaveFlashloanPremium() {
  try {
    const lpProvider = new ethers.Contract(AAVE_LENDING_POOL_ADDRESS_PROVIDER, aaveProviderABI, provider);
    const lpAddr = await lpProvider.getLendingPool();
    const lendingPool = new ethers.Contract(lpAddr, aaveLendingPoolABI, provider);
    const premium = await lendingPool.FLASHLOAN_PREMIUM_TOTAL();
    logger.info(`Aave Flashloan Premium: ${premium.toString()} bips`);
    return premium;
  } catch (error) {
    logger.error(`Error fetching Aave flashloan premium: ${error.message}`);
    return ethers.BigNumber.from("0");
  }
}

// --------------------
// Dynamic Route Generation (using your existing logic)
// --------------------
function generateDynamicRoutes(baseToken, tokenMap, dexes) {
  const routes = [];
  // 2-hop routes: [base, X, base]
  for (let token in tokenMap) {
    if (token === baseToken) continue;
    for (let dex of dexes) {
      routes.push({
        name: `Dynamic: ${baseToken}→${token}→${baseToken} (${dex})`,
        steps: [
          { dex: dex, path: [tokenMap[baseToken], tokenMap[token]] },
          { dex: dex, path: [tokenMap[token], tokenMap[baseToken]] }
        ]
      });
    }
  }
  // 3-hop routes: [base, X, Y, base]
  for (let tokenX in tokenMap) {
    if (tokenX === baseToken) continue;
    for (let tokenY in tokenMap) {
      if (tokenY === baseToken || tokenY === tokenX) continue;
      for (let dex1 of dexes) {
        for (let dex2 of dexes) {
          routes.push({
            name: `Dynamic: ${baseToken}→${tokenX}→${tokenY}→${baseToken} (${dex1}→${dex2}→${dex1})`,
            steps: [
              { dex: dex1, path: [tokenMap[baseToken], tokenMap[tokenX]] },
              { dex: dex2, path: [tokenMap[tokenX], tokenMap[tokenY]] },
              { dex: dex1, path: [tokenMap[tokenY], tokenMap[baseToken]] }
            ]
          });
        }
      }
    }
  }
  return routes;
}
const ROUTES = generateDynamicRoutes("DAI", tokenAddresses, allowedDEXs);

function getDexRouter(dexName) {
  if (dexName === "Uniswap") return uniswapRouter;
  if (dexName === "SushiSwap") return sushiSwapRouter;
  throw new Error(`Unknown DEX: ${dexName}`);
}

async function simulateRoute(routeDef, borrowAmount, slippageBips) {
  let currentAmount = borrowAmount;
  for (const step of routeDef.steps) {
    try {
      const router = getDexRouter(step.dex);
      logger.info(
        `Simulating step on ${step.dex} for route '${routeDef.name}' with path [${step.path.join(" -> ")}] and input: ${ethers.utils.formatUnits(currentAmount, 18)}`
      );
      const amounts = await router.getAmountsOut(currentAmount, step.path);
      const rawOut = amounts[amounts.length - 1];
      const minOut = calculateMinOut(rawOut, slippageBips);
      currentAmount = minOut;
      logger.info(`Step successful; output: ${ethers.utils.formatUnits(currentAmount, 18)}`);
    } catch (error) {
      logger.warn(`Skipping route '${routeDef.name}' on ${step.dex} due to error: ${error.message}`);
      return ethers.constants.Zero;
    }
    if (currentAmount.eq(ethers.constants.Zero)) return ethers.constants.Zero;
  }
  return currentAmount;
}

async function selectBestRoute(borrowAmount, slippageBips) {
  let bestRoute = null;
  let bestFinalOut = ethers.constants.Zero;
  for (const routeDef of ROUTES) {
    const finalOut = await simulateRoute(routeDef, borrowAmount, slippageBips);
    logger.info(`Route '${routeDef.name}' yields final output: ${ethers.utils.formatUnits(finalOut, 18)} DAI (est.)`);
    if (finalOut.gt(bestFinalOut)) {
      bestFinalOut = finalOut;
      bestRoute = routeDef;
    }
  }
  return { bestRoute, bestFinalOut };
}

// --------------------
// Main Simulation & Execution Function
// --------------------
async function simulateAndExecuteArb(useFlashbots = false) {
  logger.info("\n===== Initiating Arbitrage Check =====");
  if (!(await getGasPriceOK())) return false;

  const dynamicSlippage = await getDynamicSlippage();
  // Determine the optimal borrow dynamically (in WETH) based on available DAI liquidity.
  const optimalBorrowWETH = await getOptimalBorrowAmount("DAI");
  if (optimalBorrowWETH.eq(ethers.constants.Zero)) {
    logger.warn("Optimal borrow amount is zero; skipping arbitrage.");
    return false;
  }
  // Convert the optimal borrow from WETH back to DAI for route simulation.
  const amountsBack = await uniswapRouter.getAmountsOut(optimalBorrowWETH, [tokenAddresses.WETH, tokenAddresses.DAI]);
  const simulationBorrowDai = amountsBack[amountsBack.length - 1];

  const { bestRoute, bestFinalOut } = await selectBestRoute(simulationBorrowDai, dynamicSlippage);
  if (!bestRoute || bestFinalOut.eq(ethers.constants.Zero)) {
    logger.info("No route provided a positive output. Skipping.");
    return false;
  }
  logger.info(`\nBest Route Selected: ${bestRoute.name}`);
  logger.info(`Expected Final Output: ${ethers.utils.formatUnits(bestFinalOut, 18)} DAI`);

  const premiumBps = await getAaveFlashloanPremium();
  const totalDebt = optimalBorrowWETH.add(optimalBorrowWETH.mul(premiumBps).div(10000));
  const potentialProfit = bestFinalOut.sub(totalDebt);
  const gasCostInDAI = await estimateGasCostInDAI(
    await arbContract.estimateGas.initiateFlashLoan(
      tokenAddresses.DAI,
      optimalBorrowWETH,
      bestRoute.steps[0].path,
      bestRoute.steps[1].path,
      bestRoute.steps.length > 2 ? bestRoute.steps[2].path : [],
      calculateMinOut(bestFinalOut, dynamicSlippage),
      calculateMinOut(bestFinalOut, dynamicSlippage),
      calculateMinOut(bestFinalOut, dynamicSlippage),
      ethers.utils.parseUnits(MIN_PROFIT_DAI || "1", 18)
    )
  );
  logger.info(`Potential Profit: ${ethers.utils.formatUnits(potentialProfit, 18)} DAI`);
  logger.info(`Net Profit after gas: ${ethers.utils.formatUnits(potentialProfit.sub(gasCostInDAI), 18)} DAI`);

  const minProfit = ethers.utils.parseUnits(MIN_PROFIT_DAI || "1", 18);
  if (potentialProfit.sub(gasCostInDAI).lt(minProfit)) {
    logger.info("No profitable opportunity after gas costs. Skipping.");
    return false;
  }

  logger.info("Profitable route confirmed. Initiating flashloan...");
  const txData = arbContract.interface.encodeFunctionData("initiateFlashLoan", [
    tokenAddresses.DAI,
    optimalBorrowWETH,
    {
      uniswapPath: bestRoute.steps[0].path,
      sushiPath: bestRoute.steps[1].path,
      thirdPath: bestRoute.steps.length > 2 ? bestRoute.steps[2].path : [],
      minOutUni: calculateMinOut(bestFinalOut, dynamicSlippage),
      minOutSushi: calculateMinOut(bestFinalOut, dynamicSlippage),
      minOutThird: calculateMinOut(bestFinalOut, dynamicSlippage),
      minProfit: minProfit
    }
  ]);

  if (useFlashbots) {
    const success = await submitViaFlashbots(txData);
    if (success) {
      logger.info("Flashbots transaction included successfully.");
      return true;
    } else {
      logger.warn("Flashbots submission failed. Falling back to public mempool...");
    }
  }

  try {
    const tx = await arbContract.sendTransaction({
      to: arbContract.address,
      data: txData,
      gasLimit: 2000000
    });
    logger.info(`Public TX submitted. Hash: ${tx.hash}`);
    await tx.wait();
    logger.info("Flashloan executed via public mempool successfully.");
    return true;
  } catch (error) {
    logger.error(`Execution failed: ${error.message}`);
    return false;
  }
}

// --------------------
// Flashbots Submission
// --------------------
async function submitViaFlashbots(data) {
  const fbProvider = await FlashbotsBundleProvider.create(provider, wallet, FLASHBOTS_RELAY_URL)
    .catch(err => {
      logger.warn("Flashbots provider not initialized. Cannot submit via Flashbots.");
      return null;
    });
  if (!fbProvider) return false;
  const targetBlockNumber = (await provider.getBlockNumber()) + 1;
  logger.info(`Submitting Flashbots bundle for block ${targetBlockNumber}...`);
  const transaction = {
    chainId: (await provider.getNetwork()).chainId,
    to: arbContract.address,
    data,
    gasPrice: 0,
    gasLimit: 2000000
  };
  const signedBundle = [{ signer: wallet, transaction }];
  try {
    const bundleResp = await fbProvider.sendRawBundle(signedBundle, targetBlockNumber);
    const waitRes = await bundleResp.wait();
    if (waitRes === 0) {
      logger.info("Flashbots: bundle included in block.");
      return true;
    } else {
      logger.warn(`Flashbots: bundle not included. Code: ${waitRes}`);
      return false;
    }
  } catch (error) {
    logger.error(`Flashbots submission error: ${error.message}`);
    return false;
  }
}

// --------------------
// Auxiliary Functions
// --------------------
async function getGasPriceOK() {
  try {
    const gasPrice = await provider.getGasPrice();
    const gasPriceGwei = parseFloat(ethers.utils.formatUnits(gasPrice, "gwei"));
    logger.info(`Current Gas Price: ${gasPriceGwei} gwei`);
    if (gasPriceGwei > GAS_PRICE_LIMIT_GWEI) {
      logger.warn(`Gas price too high: ${gasPriceGwei} > limit of ${GAS_PRICE_LIMIT_GWEI}. Skipping trade.`);
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`Error fetching gas price: ${error.message}`);
    return false;
  }
}

async function getCurrentMarketData() {
  try {
    const endpoint = "https://api.coingecko.com/api/v3/simple/price?ids=dai,weth&vs_currencies=usd";
    const response = await axios.get(endpoint);
    return response.data;
  } catch (err) {
    logger.error(`Error fetching market data: ${err.message}`);
    return {};
  }
}

async function backtestArbitrage(startBlock, endBlock) {
  logger.info(`Backtest from block ${startBlock} to ${endBlock}. Not implemented.`);
}

module.exports = {
  simulateAndExecuteArb,
  getCurrentMarketData,
  backtestArbitrage,
  updateMinBorrowAmount: (newMin) => {
    globalMinBorrowAmount = ethers.utils.parseUnits(newMin.toString(), 18);
    logger.info(`Global minimum borrow amount updated to: ${ethers.utils.formatUnits(globalMinBorrowAmount, 18)} DAI`);
  }
  // (Add other exports as needed)
};
