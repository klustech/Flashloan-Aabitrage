// server/scripts/liquidityScanner.js

/**
 * Scans UniswapV2 and SushiSwap factories for the top‐N pools by liquidity.
 * Each on‐chain call is wrapped in its own try/catch, with a higher RPC timeout
 * and a small throttle to avoid flooding the endpoint.
 */

require("dotenv").config({
  path: require("path").resolve(__dirname, "../../.env"),
  override: true,
});
const { ethers } = require("ethers");

// Load environment variables
const {
  MAINNET_RPC_URL,
  SEPOLIA_RPC_URL,
  UNISWAP_FACTORY_ADDRESS,
  SUSHISWAP_FACTORY_ADDRESS,
} = process.env;

// Determine RPC URL
const RPC_URL = MAINNET_RPC_URL || SEPOLIA_RPC_URL;
if (!RPC_URL) {
  throw new Error("MAINNET_RPC_URL or SEPOLIA_RPC_URL must be set in .env");
}

// ─────────────────────────────────────────────────────────────────────────────
// Use a provider with an extended 120_000 ms timeout to prevent CALL_EXCEPTION
// under heavy load. We pass a single object { url, timeout } (ethers v5 syntax).
// ─────────────────────────────────────────────────────────────────────────────
const provider = new ethers.providers.JsonRpcProvider({
  url: RPC_URL,
  timeout: 120_000,
});

const FACTORY_ABI = [
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
];
const PAIR_ABI = [
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

if (!UNISWAP_FACTORY_ADDRESS || !SUSHISWAP_FACTORY_ADDRESS) {
  throw new Error(
    "Factory addresses missing in .env (UNISWAP_FACTORY_ADDRESS / SUSHISWAP_FACTORY_ADDRESS)."
  );
}

/**
 * Tiny sleep helper to avoid firing hundreds of RPC calls back‐to‐back.
 * After every 20 calls, wait 50 ms so Infura/Alchemy can catch up.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * scanFactory
 *
 * @param {string}    factoryAddr      – address of Uniswap/Sushi factory
 * @param {BigNumber} minLiquidity     – minimum reserve threshold (wei)
 * @param {number}    topN             – number of top pools to return
 * @param {string}    dexLabel         – “Uniswap” or “SushiSwap” (for logging)
 *
 * @returns {Promise<Array<{ dex:string, token0:string, token1:string, depth:BigNumber }>>}
 */
async function scanFactory(factoryAddr, minLiquidity, topN, dexLabel) {
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);

  // 1) Wrap allPairsLength() in try/catch
  let totalPairs;
  try {
    totalPairs = (await factory.allPairsLength()).toNumber();
  } catch (err) {
    console.warn(
      `⚠ scanFactory(${dexLabel}): allPairsLength() failed: ${err.message}`
    );
    return [];
  }

  const out = [];

  for (let i = 0; i < totalPairs; i++) {
    // 2) Throttle every 20 calls
    if (i > 0 && i % 20 === 0) {
      await sleep(50);
    }

    // 3) Fetch pair address (wrapped in its own try/catch)
    let pairAddr;
    try {
      pairAddr = await factory.allPairs(i);
    } catch (err) {
      console.warn(
        `⚠ scanFactory(${dexLabel}): allPairs(${i}) failed: ${err.message}`
      );
      continue; // Skip this index, continue scanning others
    }

    // 4) Instantiate pair contract
    const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);

    // 5) Fetch reserves (wrapped)
    let r0, r1;
    try {
      const reserves = await pair.getReserves();
      r0 = reserves[0];
      r1 = reserves[1];
    } catch (err) {
      console.warn(
        `⚠ scanFactory(${dexLabel}): getReserves() for pair ${pairAddr} failed: ${err.message}`
      );
      continue;
    }

    // 6) Skip if below minLiquidity
    if (r0.lt(minLiquidity) || r1.lt(minLiquidity)) {
      continue;
    }

    // 7) Fetch token0 and token1 (wrapped)
    let t0, t1;
    try {
      t0 = await pair.token0();
      t1 = await pair.token1();
    } catch (err) {
      console.warn(
        `⚠ scanFactory(${dexLabel}): token0/token1 for ${pairAddr} failed: ${err.message}`
      );
      continue;
    }

    // 8) Compute “depth” = r0 * r1 and collect
    const depth = r0.mul(r1);
    out.push({ dex: dexLabel, token0: t0, token1: t1, depth });
  }

  // 9) Sort descending by depth, return topN
  out.sort((a, b) => b.depth.sub(a.depth).toNumber());
  return out.slice(0, topN);
}

/**
 * getTopLiquidityPairs
 *
 * @param {{ topN?: number, minLiquidity?: string }} opts
 *   - topN: how many pools to return (default 10)
 *   - minLiquidity: string amount (e.g. "1000") in 18‐decimal units
 */
async function getTopLiquidityPairs(opts = {}) {
  const topN = opts.topN ?? 10;
  const minLiquidity = ethers.utils.parseUnits(opts.minLiquidity ?? "1000", 18);

  // Run both scans in parallel; each scan has its own try/catch
  const [uniList, sushiList] = await Promise.all([
    scanFactory(UNISWAP_FACTORY_ADDRESS, minLiquidity, topN, "Uniswap"),
    scanFactory(SUSHISWAP_FACTORY_ADDRESS, minLiquidity, topN, "SushiSwap"),
  ]);

  // Merge & re‐sort
  const merged = uniList.concat(sushiList);
  merged.sort((a, b) => b.depth.sub(a.depth).toNumber());
  return merged.slice(0, topN);
}

module.exports = { getTopLiquidityPairs };
