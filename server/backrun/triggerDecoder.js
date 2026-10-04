const { utils } = require("ethers");
const { address } = require("../bot/units");

const SWAP_TOPICS = new Set([
  utils.id("Swap(address,uint256,uint256,uint256,uint256,address)").toLowerCase(),
  utils.id("Swap(address,address,int256,int256,uint160,uint128,int24)").toLowerCase(),
  utils.id("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)").toLowerCase(),
]);

function decodeTriggerHint(hint, registry) {
  if (!hint || typeof hint !== "object") throw new Error("order-flow hint required");
  const tracked = new Set((registry?.values?.() || []).map(p => address(p.poolAddress)));
  const affected = new Set();

  for (const pool of hint.affectedPools || []) {
    const canonical = address(pool);
    if (tracked.has(canonical)) affected.add(canonical);
  }

  for (const log of hint.logs || []) {
    if (!log?.address || !Array.isArray(log.topics) || !log.topics.length) continue;
    const pool = address(log.address);
    if (!tracked.has(pool)) continue;
    if (SWAP_TOPICS.has(String(log.topics[0]).toLowerCase())) affected.add(pool);
  }

  return {
    hash: hint.hash || null,
    rawTx: hint.rawTx || null,
    source: hint.source || "unknown",
    affectedPools: [...affected],
    receivedAt: hint.receivedAt || Date.now(),
    usable: affected.size > 0,
    reason: affected.size ? null : "no_tracked_pool_impact_hint",
  };
}

module.exports = { decodeTriggerHint, SWAP_TOPICS };
