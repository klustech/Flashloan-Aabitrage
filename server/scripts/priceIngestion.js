/**
 * server/scripts/priceIngestion.js
 *
 * Provides utilities for keeping a cache of Uniswap/Sushiswap pool reserves.
 * The previous version of this module returned placeholder data.  The
 * implementation now subscribes to `Sync` events via a WebSocket provider and
 * can fetch the latest reserves using the Multicall contract.
 *
 * Environment variables used:
 *   - MAINNET_WEBSOCKET   – WebSocket URL for Ethereum mainnet
 *   - MAINNET_RPC_URL     – Fallback HTTP RPC URL if no WebSocket is provided
 *   - MULTICALL_ADDRESS   – Address of the Multicall contract (default: v2)
 */

const { ethers } = require("ethers");

// Simple Multicall contract interface. We only need the aggregate function to
// batch fetch reserves for a list of pools. Using the direct contract interface
// avoids relying on the deprecated `@makerdao/multicall` constructor which is no
// longer exported by the library.
const MULTICALL_ABI = [
  "function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)",
];

const reserveCache = new Map();
const subscriptions = new Map();

const WS_URL = process.env.MAINNET_WEBSOCKET;
const RPC_URL = process.env.MAINNET_RPC_URL;
const provider = WS_URL
  ? new ethers.providers.WebSocketProvider(WS_URL)
  : new ethers.providers.JsonRpcProvider(RPC_URL);

const MULTICALL_ADDRESS =
  process.env.MULTICALL_ADDRESS || "0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696"; // mainnet v2

// Ethers.js contract instance for the Multicall contract
const multicall = new ethers.Contract(
  MULTICALL_ADDRESS,
  MULTICALL_ABI,
  provider
);

const PAIR_ABI = [
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "function getReserves() view returns (uint112,uint112,uint32)",
];

/**
 * initSubscriptions:
 *   (Originally subscribed to on-chain pool “Sync” events via WebSocket. Stubbed out.)
 *
 * @param {string[]} pools  – List of pool addresses to subscribe to (ignored).
 */
async function initSubscriptions(pools) {
  for (const addr of pools) {
    if (subscriptions.has(addr)) continue;
    const contract = new ethers.Contract(addr, PAIR_ABI, provider);
    const handler = (r0, r1) => {
      reserveCache.set(addr, {
        reserve0: r0.toString(),
        reserve1: r1.toString(),
        timestamp: Date.now(),
      });
    };
    contract.on("Sync", handler);
    subscriptions.set(addr, { contract, handler });
    // Prime the cache with an initial reserve fetch
    try {
      const [reserve0, reserve1] = await contract.getReserves();
      handler(reserve0, reserve1);
    } catch (err) {
      console.warn(
        `Failed to fetch initial reserves for ${addr}: ${err.message}`
      );
    }
  }
}

/**
 * fetchMulticallReservesForRoute:
 *   (Originally used @makerdao/multicall to batch-fetch reserves. Stubbed out.)
 *
 * @param {Object} routeOrPoolInfo – Route or pool details (ignored).
 */
async function fetchMulticallReservesForRoute(routeOrPoolInfo) {
  // If an array is passed, treat each entry as a hop and recurse
  if (Array.isArray(routeOrPoolInfo)) {
    for (const hop of routeOrPoolInfo) {
      await fetchMulticallReservesForRoute(hop);
    }
    return;
  }

  const poolAddress = routeOrPoolInfo.poolAddress || routeOrPoolInfo;
  if (!poolAddress || !ethers.utils.isAddress(poolAddress)) {
    console.warn(
      `Multicall skipped for invalid pool address: ${JSON.stringify(
        routeOrPoolInfo
      )}`
    );
    return;
  }

  const pairInterface = new ethers.utils.Interface(PAIR_ABI);
  const callData = pairInterface.encodeFunctionData("getReserves");
  try {
    const [, returnData] = await multicall.aggregate([[poolAddress, callData]]);
    const [r0, r1] = pairInterface.decodeFunctionResult(
      "getReserves",
      returnData[0]
    );
    reserveCache.set(poolAddress, {
      reserve0: r0.toString(),
      reserve1: r1.toString(),
      timestamp: Date.now(),
    });
  } catch (err) {
    console.warn(`Multicall failed for ${poolAddress}: ${err.message}`);
  }
}

module.exports = {
  initSubscriptions,
  reserveCache,
  fetchMulticallReservesForRoute,
};
