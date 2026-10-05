// MEV-Share hints carry no signed transaction, and their `hash` is a
// matchmaker double hash that cannot be looked up on chain. When the sender
// shares full logs, the Swap/Sync log data is enough to reconstruct the exact
// post-trigger state of V2 and V3 pools without the raw transaction:
//   V2 Sync  -> absolute reserves; V2 Swap -> exact reserve deltas
//   V3 Swap  -> absolute sqrtPriceX96, liquidity and tick, plus balance deltas
// Anything a tracked pool emits that cannot be derived exactly rejects the hint.
const { utils, BigNumber } = require("ethers");
const { bn, address } = require("../bot/units");

const TOPICS = {
  V2_SWAP: utils.id("Swap(address,uint256,uint256,uint256,uint256,address)").toLowerCase(),
  V2_SYNC: utils.id("Sync(uint112,uint112)").toLowerCase(),
  V3_SWAP: utils.id("Swap(address,address,int256,int256,uint160,uint128,int24)").toLowerCase(),
  PANCAKE_V3_SWAP: utils.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)").toLowerCase(),
};
const coder = utils.defaultAbiCoder;
const MAX_UINT112 = BigNumber.from(2).pow(112).sub(1);

function hintError(reason) { const error = new Error(reason); error.code = reason; return error; }

function parsePoolEffects(logs, registry) {
  const tracked = new Map(registry.values().map(p => [address(p.poolAddress), p]));
  const effects = new Map();
  for (const log of logs || []) {
    let pool;
    try { pool = tracked.get(address(log.address)); } catch (_) { continue; }
    if (!pool) continue;
    const topic = String(log.topics?.[0] || "").toLowerCase();
    if (!log.data || log.data === "0x") throw hintError("mev_share_log_data_withheld");
    const effect = effects.get(pool.poolAddress) || { pool: pool.poolAddress, dex: pool.dex, protocolVersion: pool.protocolVersion,
      token0: pool.token0, token1: pool.token1, delta0: bn(0), delta1: bn(0) };
    if (pool.protocolVersion === 2 && topic === TOPICS.V2_SWAP) {
      const [in0, in1, out0, out1] = coder.decode(["uint256", "uint256", "uint256", "uint256"], log.data);
      effect.delta0 = effect.delta0.add(in0).sub(out0); effect.delta1 = effect.delta1.add(in1).sub(out1);
    } else if (pool.protocolVersion === 2 && topic === TOPICS.V2_SYNC) {
      const [r0, r1] = coder.decode(["uint112", "uint112"], log.data);
      effect.reserves = [bn(r0), bn(r1)];
    } else if (pool.protocolVersion === 3 && (topic === TOPICS.V3_SWAP || topic === TOPICS.PANCAKE_V3_SWAP)) {
      const [amount0, amount1, sqrtPriceX96, liquidity, tick] =
        coder.decode(["int256", "int256", "uint160", "uint128", "int24"], log.data);
      effect.delta0 = effect.delta0.add(amount0); effect.delta1 = effect.delta1.add(amount1);
      Object.assign(effect, { sqrtPriceX96: bn(sqrtPriceX96), liquidity: bn(liquidity), tick: Number(tick) });
    } else throw hintError("mev_share_unsupported_pool_event");
    effects.set(pool.poolAddress, effect);
  }
  return [...effects.values()];
}

// ─── Fork storage application ────────────────────────────────────────────────
const word = value => utils.hexZeroPad(BigNumber.from(value).toHexString(), 32);
const mask = bits => BigNumber.from(2).pow(bits).sub(1);
const toTwos24 = tick => BigNumber.from(tick).toTwos(24);
const V2_RESERVES_SLOT = 8; // UniswapV2Pair / SushiSwap: reserve0 | reserve1 << 112 | blockTimestampLast << 224
const POOL = new utils.Interface([
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick)",
  "function liquidity() view returns (uint128)",
]);
const ERC20 = new utils.Interface(["function balanceOf(address) view returns (uint256)"]);

class ForkStateWriter {
  constructor(provider) { this.provider = provider; this.balanceSlots = new Map(); }
  async call(to, iface, name, args = []) {
    const data = await this.provider.send("eth_call", [{ to, data: iface.encodeFunctionData(name, args) }, "latest"]);
    return iface.decodeFunctionResult(name, data);
  }
  async storage(target, slot) { return bn(await this.provider.send("eth_getStorageAt", [target, word(slot), "latest"])); }
  async setStorage(target, slot, value) { await this.provider.send("hardhat_setStorageAt", [target, word(slot), word(value)]); }
  async balanceOf(token, holder) { return bn((await this.call(token, ERC20, "balanceOf", [holder]))[0]); }

  // Locate an ERC20 balance mapping by probing Solidity and Vyper layouts and
  // confirming each candidate with a reversible write.
  async balanceSlot(token, holder) {
    if (this.balanceSlots.has(token)) return this.balanceSlots.get(token);
    const balance = await this.balanceOf(token, holder);
    for (let slot = 0; slot < 64; slot++) for (const vyper of [false, true]) {
      const key = utils.keccak256(coder.encode(vyper ? ["uint256", "address"] : ["address", "uint256"], vyper ? [slot, holder] : [holder, slot]));
      const raw = await this.storage(token, key);
      if (!raw.eq(balance)) continue;
      const probe = balance.add(1);
      await this.setStorage(token, key, probe);
      const seen = await this.balanceOf(token, holder);
      await this.setStorage(token, key, raw);
      if (seen.eq(probe)) { const layout = { slot, vyper }; this.balanceSlots.set(token, layout); return layout; }
    }
    throw hintError("mev_share_token_balance_slot_unknown");
  }
  async adjustBalance(token, holder, delta) {
    if (bn(delta).isZero()) return;
    const { slot, vyper } = await this.balanceSlot(token, holder);
    const key = utils.keccak256(coder.encode(vyper ? ["uint256", "address"] : ["address", "uint256"], vyper ? [slot, holder] : [holder, slot]));
    const next = (await this.balanceOf(token, holder)).add(delta);
    if (next.lt(0)) throw hintError("mev_share_hint_inconsistent_with_parent_state");
    await this.setStorage(token, key, next);
    if (!(await this.balanceOf(token, holder)).eq(next)) throw hintError("mev_share_balance_write_unverified");
  }

  async applyV2(effect) {
    const [r0, r1, ts] = await this.call(effect.pool, POOL, "getReserves");
    const raw = await this.storage(effect.pool, V2_RESERVES_SLOT);
    if (!raw.and(mask(112)).eq(r0) || !raw.shr(112).and(mask(112)).eq(r1) || !raw.shr(224).eq(ts))
      throw hintError("mev_share_unsupported_v2_storage_layout");
    const next = effect.reserves || [bn(r0).add(effect.delta0), bn(r1).add(effect.delta1)];
    if (next.some(r => r.lte(0) || r.gt(MAX_UINT112))) throw hintError("mev_share_hint_inconsistent_with_parent_state");
    await this.setStorage(effect.pool, V2_RESERVES_SLOT, BigNumber.from(ts).shl(224).or(next[1].shl(112)).or(next[0]));
    const [v0, v1] = await this.call(effect.pool, POOL, "getReserves");
    if (!bn(v0).eq(next[0]) || !bn(v1).eq(next[1])) throw hintError("mev_share_reserve_write_unverified");
    // Balances move with reserves so the pair's balance-minus-reserve input
    // accounting stays correct for the backrun's own swap.
    await this.adjustBalance(effect.token0, effect.pool, next[0].sub(r0));
    await this.adjustBalance(effect.token1, effect.pool, next[1].sub(r1));
    return { pool: effect.pool, reserves: next.map(String) };
  }

  async applyV3(effect) {
    const [sqrtPriceX96, tick] = await this.call(effect.pool, POOL, "slot0");
    const raw0 = await this.storage(effect.pool, 0);
    if (!raw0.and(mask(160)).eq(sqrtPriceX96) || !raw0.shr(160).and(mask(24)).eq(toTwos24(tick)))
      throw hintError("mev_share_unsupported_v3_storage_layout");
    const [liquidity] = await this.call(effect.pool, POOL, "liquidity");
    if (bn(liquidity).isZero()) throw hintError("mev_share_v3_liquidity_slot_ambiguous");
    let liquiditySlot = null;
    // Uniswap V3 keeps liquidity in slot 4; other forks shift it. A wrong match
    // is caught by the liquidity() read-back below.
    for (const slot of [4, 5, 1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
      if ((await this.storage(effect.pool, slot)).and(mask(128)).eq(liquidity)) { liquiditySlot = slot; break; }
    }
    if (liquiditySlot === null) throw hintError("mev_share_unsupported_v3_storage_layout");
    const kept0 = raw0.shr(184).shl(184);
    await this.setStorage(effect.pool, 0, kept0.or(toTwos24(effect.tick).shl(160)).or(effect.sqrtPriceX96));
    const rawL = await this.storage(effect.pool, liquiditySlot);
    await this.setStorage(effect.pool, liquiditySlot, rawL.shr(128).shl(128).or(effect.liquidity));
    const [vPrice, vTick] = await this.call(effect.pool, POOL, "slot0"), [vLiquidity] = await this.call(effect.pool, POOL, "liquidity");
    if (!bn(vPrice).eq(effect.sqrtPriceX96) || Number(vTick) !== effect.tick || !bn(vLiquidity).eq(effect.liquidity))
      throw hintError("mev_share_v3_write_unverified");
    await this.adjustBalance(effect.token0, effect.pool, effect.delta0);
    await this.adjustBalance(effect.token1, effect.pool, effect.delta1);
    return { pool: effect.pool, sqrtPriceX96: effect.sqrtPriceX96.toString(), tick: effect.tick, liquidity: effect.liquidity.toString() };
  }

  async apply(effects) {
    if (!effects?.length) throw hintError("mev_share_hint_has_no_pool_effects");
    const applied = [];
    for (const effect of effects) applied.push(effect.protocolVersion === 2 ? await this.applyV2(effect) : await this.applyV3(effect));
    return applied;
  }
}

module.exports = { parsePoolEffects, ForkStateWriter, TOPICS, V2_RESERVES_SLOT };
