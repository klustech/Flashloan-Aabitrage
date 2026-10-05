const { randomUUID } = require("crypto");
const { PoolRegistry } = require("../market/poolRegistry");
const { createAdapters } = require("../dex");
const { QuoteEngine } = require("../bot/quoteEngine");
const { address } = require("../bot/units");
const { checkSignal, mapLimit } = require("../bot/asyncControl");
class StatePredictor {
  constructor({ backend, profile, tokens }) { Object.assign(this, { backend, profile, tokens }); }
  async withContext({ trigger, registry, block, signal }, work) {
    const hinted = !trigger.rawTx;
    if (hinted && !trigger.poolEffects?.length) throw new Error("raw_trigger_unavailable_for_exact_prediction");
    return this.backend.exclusive(async () => {
      const started = Date.now();
      const applied = hinted ? await this.backend.applyHint(trigger, block, signal) : await this.backend.applyTrigger(trigger, block, signal);
      checkSignal(signal);
      const tracked = new Map(registry.values().map(p => [p.poolAddress, p]));
      const changedPools = new Set();
      // Raw triggers: actual simulated logs identify every touched tracked pool,
      // including Mint/Burn/Sync. MEV-Share: only pools whose full post-state was
      // derived from shared logs (any other tracked-pool event rejected the hint).
      const touched = hinted ? trigger.poolEffects.map(e => e.pool) : applied.triggerReceipt.logs.map(log => log.address);
      for (const pool of touched) {
        const p = address(pool);
        if (tracked.has(p)) changedPools.add(p);
      }
      if (!changedPools.size) throw new Error("simulated_trigger_has_no_tracked_pool_impact");
      const adapters = createAdapters(this.backend.provider, this.profile);
      const states = new Map(await mapLimit([...changedPools], 4, async p => {
        const pool = tracked.get(p);
        return [p, await adapters[pool.dex].getDynamicState(pool, applied.block.number)];
      }, signal));
      const overlay = new PoolRegistry(this.tokens), now = Date.now(), id = randomUUID();
      for (const pool of registry.values()) overlay.add({ ...pool, ...states.get(pool.poolAddress),
        stateBlock: block.number, stateTimestamp: now, predictionContext: id });
      const quoter = new QuoteEngine(adapters); quoter.beginBlock(id);
      const context = { id, active: true, provider: this.backend.provider, adapters, quoter,
        registry: overlay, triggerHash: trigger.hash, parentBlock: block.number, parentHash: block.hash,
        simulationBlock: applied.block.number, changedPools, simulationGas: applied.triggerReceipt?.gasUsed ?? null,
        simulationSource: hinted ? "ISOLATED_FORK_LOG_DERIVED_STATE" : "ISOLATED_HARDHAT_FORK",
        predictionMode: hinted ? "MEV_SHARE_LOG_DERIVED" : "RAW_TRIGGER_REPLAY", predictedAt: now, predictionMs: now - started,
        header: applied.header, assertActive() {
          checkSignal(signal);
          if (!this.active) throw new Error("Post-trigger context expired");
        } };
      try { return await work(context); } finally { context.active = false; }
    }, signal);
  }
}
module.exports = { StatePredictor };
