/**
 * onchainPools.js — pool discovery + reserve reads straight from the chain.
 *
 * Replaces the decommissioned api.thegraph.com hosted-service discovery (which
 * returned nothing / 300s-stale data) with deterministic on-chain reads for a
 * curated set of target tokens:
 *   - Uniswap-V2 / Sushiswap: pair address via CREATE2 (no RPC) + getReserves
 *   - Uniswap-V3: factory.getPool per fee tier + slot0/liquidity + token balances
 * Everything is batched through Multicall3 in one or two round-trips, so the
 * reserves feeding the sizer are current chain state, not a cached snapshot.
 *
 * Returns the same shape as liquidityScanner.getTopLiquidityPairs:
 *   { token0, token1, pairAddress, dex, fee, reserveUSD, feeBps, ... }
 */
const { ethers } = require("ethers");
const { getNetworkConfig } = require("../config/networkConfig");
const { v3VirtualReserves } = require("./ammMath");

// Multicall3 is deployed at the same address on all major chains.
const MULTICALL3 =
  process.env.MULTICALL3_ADDRESS ||
  process.env.MULTICALL_ADDRESS ||
  "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  "function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])",
];
const pairIface = new ethers.utils.Interface([
  "function getReserves() view returns (uint112,uint112,uint32)",
]);
const v3FactoryIface = new ethers.utils.Interface([
  "function getPool(address,address,uint24) view returns (address)",
]);
const v3PoolIface = new ethers.utils.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
]);
const erc20Iface = new ethers.utils.Interface([
  "function balanceOf(address) view returns (uint256)",
]);

const V2_DEXES = ["uniswap_v2", "sushiswap", "sushiswap_v2"];
const V3_FEE_TIERS = [500, 3000, 10000];

// Decimals + USD prices for the *quote* leg only (used for ranking/filtering;
// actual sizing always uses raw reserves). Stablecoins ≈ $1; volatile legs are
// priced from env so we never need an oracle call just to rank candidates.
const DECIMALS = {
  DAI: 18,
  USDC: 6,
  USDT: 6,
  WETH: 18,
  WBTC: 8,
  WMATIC: 18,
  USDBC: 6,
  "USDC.E": 6,
};
function quoteUsd(symbol) {
  const s = symbol.toUpperCase();
  if (["DAI", "USDC", "USDT", "USDBC", "USDC.E"].includes(s)) return 1;
  if (s === "WETH") return parseFloat(process.env.ETH_USD || "3000");
  if (s === "WBTC") return parseFloat(process.env.WBTC_USD || "60000");
  return null; // not priceable -> contributes 0 to the USD proxy
}
const decimalsOf = (symbol) => DECIMALS[symbol.toUpperCase()] ?? 18;

function computeV2Pair(factory, tokenA, tokenB, initCodeHash) {
  const [t0, t1] =
    tokenA.toLowerCase() < tokenB.toLowerCase()
      ? [tokenA, tokenB]
      : [tokenB, tokenA];
  const salt = ethers.utils.keccak256(
    ethers.utils.solidityPack(["address", "address"], [t0, t1])
  );
  return ethers.utils.getCreate2Address(factory, salt, initCodeHash);
}

// Balanced-AMM USD proxy: if we can price either leg, total ≈ 2× the priced leg.
function reserveUsdProxy(sym0, sym1, res0, res1) {
  const p0 = quoteUsd(sym0);
  const p1 = quoteUsd(sym1);
  const legVal = (res, sym, p) =>
    p == null
      ? null
      : parseFloat(ethers.utils.formatUnits(res, decimalsOf(sym))) * p;
  const v0 = legVal(res0, sym0, p0);
  const v1 = legVal(res1, sym1, p1);
  if (v0 != null && v1 != null) return v0 + v1;
  if (v0 != null) return v0 * 2;
  if (v1 != null) return v1 * 2;
  return 0;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function multicallTry(multicall, calls, batchSize = 100) {
  const results = [];
  for (const batch of chunk(calls, batchSize)) {
    const res = await multicall.tryAggregate(false, batch);
    results.push(...res);
  }
  return results;
}

/**
 * Discover liquid pools on-chain for a network's curated token set.
 * @returns {Promise<Array>} pools sorted by descending reserveUSD, trimmed to topN
 */
async function discoverOnchainPools(
  chain = "ethereum",
  { topN = 40, minLiquidityUSD = 0, provider } = {}
) {
  const cfg = getNetworkConfig(chain);
  const rpc =
    provider ||
    new ethers.providers.JsonRpcProvider(
      cfg.rpcUrl || process.env.MAINNET_RPC_URL
    );
  const multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, rpc);
  const tokens = cfg.tokens || {};
  const symbols = Object.keys(tokens);

  const tokenPairs = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      tokenPairs.push([symbols[i], symbols[j]]);
    }
  }

  const pools = [];

  // ─── Uniswap V2 / Sushiswap (deterministic pair address, then getReserves) ───
  const v2Entries = [];
  for (const dexName of V2_DEXES) {
    const d = cfg.dexRouters[dexName];
    if (!d || !d.factory || !d.initCodeHash) continue;
    const dex = dexName === "sushiswap" ? "sushiswap_v2" : dexName;
    for (const [sa, sb] of tokenPairs) {
      const a = tokens[sa];
      const b = tokens[sb];
      if (!a || !b) continue;
      v2Entries.push({
        sa,
        sb,
        a,
        b,
        dex,
        pairAddress: computeV2Pair(d.factory, a, b, d.initCodeHash),
      });
    }
  }
  if (v2Entries.length) {
    const calls = v2Entries.map((e) => ({
      target: e.pairAddress,
      callData: pairIface.encodeFunctionData("getReserves"),
    }));
    const res = await multicallTry(multicall, calls);
    res.forEach((r, idx) => {
      if (!r || !r.success) return;
      let r0, r1;
      try {
        [r0, r1] = pairIface.decodeFunctionResult("getReserves", r.returnData);
      } catch (_) {
        return;
      }
      if (r0.isZero() || r1.isZero()) return;
      const e = v2Entries[idx];
      const aIs0 = e.a.toLowerCase() < e.b.toLowerCase();
      const [t0, t1, s0, s1] = aIs0
        ? [e.a, e.b, e.sa, e.sb]
        : [e.b, e.a, e.sb, e.sa];
      const reserveUSD = reserveUsdProxy(s0, s1, r0, r1);
      if (reserveUSD < minLiquidityUSD) return;
      pools.push({
        token0: t0,
        token1: t1,
        pairAddress: e.pairAddress,
        dex: e.dex,
        fee: 0.003,
        feeBps: 30,
        reserveUSD,
        reserve0: r0.toString(),
        reserve1: r1.toString(),
      });
    });
  }

  // ─── Uniswap V3 (getPool per fee tier, then slot0/liquidity/balances) ───
  const v3 = cfg.dexRouters.uniswap_v3;
  if (v3 && v3.factory) {
    const poolCalls = [];
    for (const [sa, sb] of tokenPairs) {
      const a = tokens[sa];
      const b = tokens[sb];
      if (!a || !b) continue;
      for (const fee of V3_FEE_TIERS) {
        poolCalls.push({
          sa,
          sb,
          a,
          b,
          fee,
          target: v3.factory,
          callData: v3FactoryIface.encodeFunctionData("getPool", [a, b, fee]),
        });
      }
    }
    const poolRes = await multicallTry(
      multicall,
      poolCalls.map((c) => ({ target: c.target, callData: c.callData }))
    );
    const found = [];
    poolRes.forEach((r, idx) => {
      if (!r || !r.success) return;
      let addr;
      try {
        [addr] = v3FactoryIface.decodeFunctionResult("getPool", r.returnData);
      } catch (_) {
        return;
      }
      if (!addr || addr === ethers.constants.AddressZero) return;
      found.push({ ...poolCalls[idx], poolAddress: addr });
    });

    if (found.length) {
      const dataCalls = [];
      for (const f of found) {
        dataCalls.push({
          target: f.poolAddress,
          callData: v3PoolIface.encodeFunctionData("slot0"),
        });
        dataCalls.push({
          target: f.poolAddress,
          callData: v3PoolIface.encodeFunctionData("liquidity"),
        });
        dataCalls.push({
          target: f.a,
          callData: erc20Iface.encodeFunctionData("balanceOf", [f.poolAddress]),
        });
        dataCalls.push({
          target: f.b,
          callData: erc20Iface.encodeFunctionData("balanceOf", [f.poolAddress]),
        });
      }
      const dataRes = await multicallTry(multicall, dataCalls);
      found.forEach((f, k) => {
        const slot = dataRes[4 * k];
        const liq = dataRes[4 * k + 1];
        const balA = dataRes[4 * k + 2];
        const balB = dataRes[4 * k + 3];
        if (!slot?.success || !liq?.success) return;
        let sqrtPriceX96, liquidity, balanceA, balanceB;
        try {
          [sqrtPriceX96] = v3PoolIface.decodeFunctionResult(
            "slot0",
            slot.returnData
          );
          [liquidity] = v3PoolIface.decodeFunctionResult(
            "liquidity",
            liq.returnData
          );
          balanceA = balA?.success
            ? erc20Iface.decodeFunctionResult("balanceOf", balA.returnData)[0]
            : ethers.constants.Zero;
          balanceB = balB?.success
            ? erc20Iface.decodeFunctionResult("balanceOf", balB.returnData)[0]
            : ethers.constants.Zero;
        } catch (_) {
          return;
        }
        if (sqrtPriceX96.isZero() || liquidity.isZero()) return;
        const aIs0 = f.a.toLowerCase() < f.b.toLowerCase();
        const [t0, t1, s0, s1] = aIs0
          ? [f.a, f.b, f.sa, f.sb]
          : [f.b, f.a, f.sb, f.sa];
        const [bal0, bal1] = aIs0 ? [balanceA, balanceB] : [balanceB, balanceA];
        // True TVL from token balances; if balances missing, fall back to virtual reserves.
        let reserveUSD = reserveUsdProxy(s0, s1, bal0, bal1);
        if (reserveUSD === 0) {
          const vr = v3VirtualReserves(sqrtPriceX96, liquidity);
          reserveUSD = reserveUsdProxy(s0, s1, vr.reserve0, vr.reserve1);
        }
        if (reserveUSD < minLiquidityUSD) return;
        pools.push({
          token0: t0,
          token1: t1,
          pairAddress: f.poolAddress,
          dex: "uniswap_v3",
          fee: f.fee,
          feeBps: Math.max(1, Math.round(f.fee / 100)),
          reserveUSD,
          sqrtPriceX96: sqrtPriceX96.toString(),
          liquidity: liquidity.toString(),
        });
      });
    }
  }

  pools.sort((a, b) => b.reserveUSD - a.reserveUSD);
  return pools.slice(0, topN);
}

module.exports = { discoverOnchainPools, computeV2Pair };

