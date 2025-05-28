// server/scripts/botLogic.js

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
const { ethers } = require("ethers");
const fs = require("fs");
const axios = require("axios");
const winston = require("winston");
const {
  FlashbotsBundleProvider,
} = require("@flashbots/ethers-provider-bundle");

// -----------------------------
// Caching for External API Responses
// -----------------------------
const cache = {
  coinGecko: {},
  dynamicSlippage: null,
  duration: 60000, // 60 seconds
};

async function getCachedCoinGeckoPrice(coinId, vsCurrency) {
  const cacheKey = `${coinId}_${vsCurrency}`;
  const now = Date.now();
  if (
    cache.coinGecko[cacheKey] &&
    now - cache.coinGecko[cacheKey].timestamp < cache.duration
  ) {
    return cache.coinGecko[cacheKey].data;
  }
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=${vsCurrency}`;
  const response = await axios.get(url);
  cache.coinGecko[cacheKey] = { data: response.data, timestamp: now };
  return response.data;
}

// -----------------------------
// Logger Configuration
// -----------------------------
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) =>
        `[${timestamp}] [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "bot.log" }),
  ],
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
  MIN_PROFIT_DAI,
} = process.env;

const RPC_URL = MAINNET_RPC_URL || SEPOLIA_RPC_URL;
if (
  !PRIVATE_KEY ||
  !CONTRACT_ADDRESS ||
  !AAVE_LENDING_POOL_ADDRESS_PROVIDER ||
  !RPC_URL
) {
  throw new Error("Missing required .env fields.");
}

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const SLIPPAGE_DEFAULT_BIPS = SLIPPAGE_BIPS ? parseInt(SLIPPAGE_BIPS) : 50;
const GAS_CEILING_BN = GAS_PRICE_CEILING
  ? ethers.utils.parseUnits(GAS_PRICE_CEILING, "gwei")
  : ethers.utils.parseUnits("50", "gwei");
let globalMinBorrowAmount = ethers.utils.parseUnits("100", 18); // 100 DAI

logger.info("===== Flashloan Arbitrage Bot Initialized =====");
logger.info("RPC_URL: " + RPC_URL);
logger.info("CONTRACT_ADDRESS: " + CONTRACT_ADDRESS);
logger.info(`SLIPPAGE_TOLERANCE: ${SLIPPAGE_DEFAULT_BIPS} bips`);
logger.info(
  `GAS_PRICE_CEILING: ${ethers.utils.formatUnits(GAS_CEILING_BN, "gwei")} gwei`
);
logger.info(
  `Global MIN_BORROW_AMOUNT: ${ethers.utils.formatUnits(
    globalMinBorrowAmount,
    18
  )} DAI`
);

// -----------------------------
// Token & DEX Setup
// -----------------------------
const tokenAddresses = {
  DAI: process.env.TOKENS_DAI,
  WETH: process.env.TOKENS_WETH,
  USDC: process.env.TOKENS_USDC,
  USDT: process.env.TOKENS_USDT,
  UNI: process.env.TOKENS_UNI,
};

// -----------------------------
// Load ABIs
// -----------------------------
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
const lendingPoolABI = loadABI("./abis/LendingPool.json");
const aaveProviderABI = [
  "function getLendingPool() external view returns (address)",
];
const aaveLendingPoolABI = [
  "function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint256)",
];

// -----------------------------
// Contract Instances
// -----------------------------
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbitrageABI, wallet);
const uniswapRouter = new ethers.Contract(
  process.env.UNISWAP_ROUTER_ADDRESS,
  uniswapRouterABI,
  wallet
);
const sushiSwapRouter = new ethers.Contract(
  process.env.SUSHISWAP_ROUTER_ADDRESS,
  sushiRouterABI,
  wallet
);

// -----------------------------
// Helper Functions
// -----------------------------
function calculateMinOut(amountOut, slippageBips) {
  return amountOut
    .mul(ethers.BigNumber.from(10000 - slippageBips))
    .div(ethers.BigNumber.from(10000));
}

async function getDynamicSlippage() {
  const now = Date.now();
  if (
    cache.dynamicSlippage &&
    now - cache.dynamicSlippage.timestamp < cache.duration
  ) {
    return cache.dynamicSlippage.value;
  }
  try {
    const endpoint =
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_24hr_change=true";
    const response = await axios.get(endpoint);
    const vol = Math.abs(response.data.ethereum.usd_24h_change) || 0;
    const dynamic = Math.min(SLIPPAGE_DEFAULT_BIPS + Math.round(vol * 5), 200);
    cache.dynamicSlippage = { value: dynamic, timestamp: now };
    logger.info(`Dynamic Slippage determined: ${dynamic} bips`);
    return dynamic;
  } catch {
    logger.warn("Slippage fetch error, using default.");
    return SLIPPAGE_DEFAULT_BIPS;
  }
}

async function getAvailableLiquidity(token) {
  const lpProvider = new ethers.Contract(
    AAVE_LENDING_POOL_ADDRESS_PROVIDER,
    aaveProviderABI,
    provider
  );
  const lendingPoolAddress = await lpProvider.getLendingPool();
  const lendingPool = new ethers.Contract(
    lendingPoolAddress,
    lendingPoolABI,
    provider
  );
  try {
    const reserveData = await lendingPool.getReserveData(tokenAddresses[token]);
    const liquidity = reserveData.availableLiquidity;
    logger.info(
      `Available liquidity for ${token}: ${ethers.utils.formatUnits(
        liquidity,
        18
      )} tokens`
    );
    return liquidity;
  } catch (err) {
    logger.error(`Error fetching reserve data for ${token}: ${err}`);
    return ethers.constants.Zero;
  }
}

async function getOptimalBorrowAmount(token) {
  const availableLiquidity = await getAvailableLiquidity(token);
  if (availableLiquidity.eq(ethers.constants.Zero))
    return ethers.constants.Zero;

  const maxTrial = availableLiquidity.mul(10).div(100);
  const steps = 5;
  let bestProfit = -Infinity;
  let bestAmount = ethers.constants.Zero;

  const minVal = parseFloat(
    ethers.utils.formatUnits(globalMinBorrowAmount, 18)
  );
  const maxVal = parseFloat(ethers.utils.formatUnits(maxTrial, 18));
  const slip = SLIPPAGE_DEFAULT_BIPS / 10000;

  for (let i = 1; i <= steps; i++) {
    const trial = minVal + ((maxVal - minVal) * i) / steps;
    const out = (trial / 2000) * (1 - slip) * 2000 * (1 - slip);
    const cost = trial * 1.0009;
    const profit = out - cost;
    if (profit > bestProfit) {
      bestProfit = profit;
      bestAmount = ethers.utils.parseUnits(trial.toString(), 18);
    }
    logger.info(
      `Trial borrow: ${trial.toFixed(6)} DAI, profit: ${profit.toFixed(6)} DAI`
    );
  }
  logger.info(
    `Optimal borrow: ${ethers.utils.formatUnits(
      bestAmount,
      18
    )} DAI (est. profit ${bestProfit.toFixed(6)} DAI)`
  );
  const amounts = await uniswapRouter.getAmountsOut(bestAmount, [
    tokenAddresses.DAI,
    tokenAddresses.WETH,
  ]);
  return amounts[1];
}

// -----------------------------
// Static curated routes (2-hop & 3-hop)
// -----------------------------
const ROUTES = [
  // 2-hop: DAI → WETH → DAI
  {
    name: "DAI→WETH→DAI (Uniswap)",
    steps: [
      { dex: "Uniswap", path: [tokenAddresses.DAI, tokenAddresses.WETH] },
      { dex: "Uniswap", path: [tokenAddresses.WETH, tokenAddresses.DAI] },
    ],
  },
  {
    name: "DAI→WETH→DAI (SushiSwap)",
    steps: [
      { dex: "SushiSwap", path: [tokenAddresses.DAI, tokenAddresses.WETH] },
      { dex: "SushiSwap", path: [tokenAddresses.WETH, tokenAddresses.DAI] },
    ],
  },

  // 2-hop: DAI → USDC → DAI
  {
    name: "DAI→USDC→DAI (Uniswap)",
    steps: [
      { dex: "Uniswap", path: [tokenAddresses.DAI, tokenAddresses.USDC] },
      { dex: "Uniswap", path: [tokenAddresses.USDC, tokenAddresses.DAI] },
    ],
  },
  {
    name: "DAI→USDC→DAI (SushiSwap)",
    steps: [
      { dex: "SushiSwap", path: [tokenAddresses.DAI, tokenAddresses.USDC] },
      { dex: "SushiSwap", path: [tokenAddresses.USDC, tokenAddresses.DAI] },
    ],
  },

  // 3-hop: DAI → WETH → USDC → DAI
  {
    name: "DAI→WETH→USDC→DAI (Uni→Sushi→Uni)",
    steps: [
      { dex: "Uniswap", path: [tokenAddresses.DAI, tokenAddresses.WETH] },
      { dex: "SushiSwap", path: [tokenAddresses.WETH, tokenAddresses.USDC] },
      { dex: "Uniswap", path: [tokenAddresses.USDC, tokenAddresses.DAI] },
    ],
  },
  {
    name: "DAI→WETH→USDC→DAI (Sushi→Uni→Sushi)",
    steps: [
      { dex: "SushiSwap", path: [tokenAddresses.DAI, tokenAddresses.WETH] },
      { dex: "Uniswap", path: [tokenAddresses.WETH, tokenAddresses.USDC] },
      { dex: "SushiSwap", path: [tokenAddresses.USDC, tokenAddresses.DAI] },
    ],
  },

  // 3-hop: DAI → USDC → WETH → DAI
  {
    name: "DAI→USDC→WETH→DAI (Uni→Sushi→Uni)",
    steps: [
      { dex: "Uniswap", path: [tokenAddresses.DAI, tokenAddresses.USDC] },
      { dex: "SushiSwap", path: [tokenAddresses.USDC, tokenAddresses.WETH] },
      { dex: "Uniswap", path: [tokenAddresses.WETH, tokenAddresses.DAI] },
    ],
  },
  {
    name: "DAI→USDC→WETH→DAI (Sushi→Uni→Sushi)",
    steps: [
      { dex: "SushiSwap", path: [tokenAddresses.DAI, tokenAddresses.USDC] },
      { dex: "Uniswap", path: [tokenAddresses.USDC, tokenAddresses.WETH] },
      { dex: "SushiSwap", path: [tokenAddresses.WETH, tokenAddresses.DAI] },
    ],
  },
];

// -----------------------------
// Route Simulation helpers
// -----------------------------
// -----------------------------
// Route Simulation
// -----------------------------
async function simulateRoute(routeDef, borrowAmount, slippageBips) {
  let amt = borrowAmount;
  for (const step of routeDef.steps) {
    try {
      const router = getDexRouter(step.dex);
      const amounts = await router.getAmountsOut(amt, step.path);
      const raw = amounts[amounts.length - 1];
      amt = calculateMinOut(raw, slippageBips);
    } catch {
      return ethers.constants.Zero;
    }
    if (amt.eq(ethers.constants.Zero)) return amt;
  }
  return amt;
}

async function selectBestRoute(borrowAmount, slippageBips) {
  let best = null;
  let bestOut = ethers.constants.Zero;
  for (const route of ROUTES) {
    const out = await simulateRoute(route, borrowAmount, slippageBips);
    if (out.gt(bestOut)) {
      bestOut = out;
      best = route;
    }
  }
  return { bestRoute: best, bestOut };
}

// -----------------------------
// Main Simulation & Execution
// -----------------------------
async function simulateAndExecuteArb(useFlashbots = true) {
  logger.info("=== Arbitrage Check ===");

  // ---------------------------------
  // 1. gas-price ceiling guard
  // ---------------------------------
  let gasOK;
  try {
    const gp = await provider.getGasPrice();
    gasOK = gp.lte(GAS_CEILING_BN);
  } catch {
    gasOK = false;
  }
  if (!gasOK) {
    logger.info("Gas above ceiling, skipping.");
    return;
  }

  // ---------------------------------
  // 2. determine slippage + borrow
  // ---------------------------------
  const slip = await getDynamicSlippage();
  const optimalWETH = await getOptimalBorrowAmount("DAI");
  if (optimalWETH.eq(0)) return;

  const back = await uniswapRouter.getAmountsOut(optimalWETH, [
    tokenAddresses.WETH,
    tokenAddresses.DAI,
  ]);
  const simBorrow = back[back.length - 1];

  const { bestRoute, bestOut } = await selectBestRoute(simBorrow, slip);
  if (!bestRoute || bestOut.eq(0)) {
    logger.info("No profitable route.");
    return;
  }

  const premiumBps = await getAaveFlashloanPremium();
  const totalDebt = optimalWETH.add(optimalWETH.mul(premiumBps).div(10000));
  const potentialProfit = bestOut.sub(totalDebt);

  // ---------------------------------
  // 3. per-hop minOuts
  // ---------------------------------
  let current = simBorrow;
  const minOuts = [];
  for (const step of bestRoute.steps) {
    const amounts = await getDexRouter(step.dex).getAmountsOut(
      current,
      step.path
    );
    const raw = amounts[amounts.length - 1];
    const min = calculateMinOut(raw, slip);
    minOuts.push(min);
    current = min;
  }
  const [minOutUni, minOutSushi, minOutThird = ethers.BigNumber.from("0")] =
    minOuts;
  // ---------------------------------
  // 4. *** Option-1 fix: ensure thirdPath non-empty ***
  // ---------------------------------
  const ensurePath = (path, fallback) =>
    Array.isArray(path) && path.length >= 2 ? path : fallback;

  const thirdPathSafe = ensurePath(
    bestRoute.steps.length > 2 ? bestRoute.steps[2].path : [],
    bestRoute.steps[1].path // reuse 2nd hop to satisfy contract
  );
  const minOutThirdSafe =
    bestRoute.steps.length > 2 ? minOutThird : ethers.BigNumber.from(0);

  // ---------------------------------
  // 5. gas estimate & profit check
  // ---------------------------------
  const estimate = await arbContract.estimateGas.initiateFlashLoan(
    tokenAddresses.DAI,
    optimalWETH,
    {
      uniPath: bestRoute.steps[0].path,
      sushiPath: bestRoute.steps[1].path,
      thirdPath: thirdPathSafe,
      minOutUni,
      minOutSushi,
      minOutThird: minOutThirdSafe,
      minProfit: ethers.utils.parseUnits(MIN_PROFIT_DAI || "1", 18),
    }
  );
  const gasCost = await estimateGasCostInDAI(estimate);
  const net = potentialProfit.sub(gasCost);
  logger.info(`Net profit: ${ethers.utils.formatUnits(net, 18)} DAI`);

  if (net.lt(ethers.utils.parseUnits(MIN_PROFIT_DAI || "1", 18))) {
    logger.info("Profit below min; skipping execution.");
    return;
  }

  // ---------------------------------
  // 6. encode calldata
  // ---------------------------------
  const data = arbContract.interface.encodeFunctionData("initiateFlashLoan", [
    tokenAddresses.DAI,
    optimalWETH,
    {
      uniPath: bestRoute.steps[0].path,
      sushiPath: bestRoute.steps[1].path,
      thirdPath: thirdPathSafe,
      minOutUni,
      minOutSushi,
      minOutThird: minOutThirdSafe,
      minProfit: ethers.utils.parseUnits(MIN_PROFIT_DAI || "1", 18),
    },
  ]);

  // ---------------------------------
  // 7. Flashbots first
  // ---------------------------------
  if (useFlashbots) {
    const fb = await FlashbotsBundleProvider.create(
      provider,
      wallet,
      FLASHBOTS_RELAY_URL
    ).catch(() => null);
    if (fb) {
      const block = (await provider.getBlockNumber()) + 1;
      const bundle = [
        {
          signer: wallet,
          transaction: {
            to: arbContract.address,
            data,
            gasLimit: 2_000_000,
            gasPrice: 0,
          },
        },
      ];
      const resp = await fb.sendRawBundle(bundle, block);
      if ((await resp.wait()) === 0) {
        logger.info("Flashbots bundle included.");
        return true;
      }
    }
    logger.warn("Flashbots failed; falling back.");
  }

  // ---------------------------------
  // 8. Public mempool fallback
  // ---------------------------------
  try {
    const tx = await arbContract.initiateFlashLoan(
      tokenAddresses.DAI,
      optimalWETH,
      {
        uniPath: bestRoute.steps[0].path,
        sushiPath: bestRoute.steps[1].path,
        thirdPath: thirdPathSafe,
        minOutUni,
        minOutSushi,
        minOutThird: minOutThirdSafe,
        minProfit: ethers.utils.parseUnits(MIN_PROFIT_DAI || "1", 18),
      },
      { gasLimit: 2_000_000 }
    );
    logger.info(`Public TX submitted: ${tx.hash}`);
    await tx.wait();
    logger.info("Public execution successful.");
    return true;
  } catch (e) {
    logger.error(e);
    return false;
  }
}
// keeps the last value used for the first-hop borrow size heuristic
let globalSimulationInputAmount = 1_000_000; // default like before

module.exports.updateSimulationInputAmount = (newAmt) => {
  globalSimulationInputAmount = Number(newAmt);
  logger.info(
    `Global SIMULATION_INPUT_AMOUNT set to ${globalSimulationInputAmount}`
  );
};

// -----------------------------
// Exports and CLI Runner
// -----------------------------
module.exports.simulateAndExecuteArb = simulateAndExecuteArb;
module.exports.getCurrentMarketData = async () => {
  try {
    return await getCachedCoinGeckoPrice("dai", "usd");
  } catch {
    return {};
  }
};
module.exports.backtestArbitrage = async (start, end) => {
  logger.info(`Backtest from ${start} to ${end} not implemented.`);
};
module.exports.updateMinBorrowAmount = (newMin) => {
  globalMinBorrowAmount = ethers.utils.parseUnits(newMin.toString(), 18);
  logger.info(`Global MIN_BORROW_AMOUNT set to ${newMin} DAI`);
};

// optional standalone loop
if (require.main === module) {
  (async () => {
    while (true) {
      try {
        await simulateAndExecuteArb(true);
      } catch (e) {
        logger.error(e);
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  })();
}
