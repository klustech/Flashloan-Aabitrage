const { EventEmitter } = require("node:events");
const { utils } = require("ethers");

class TriggerIntake extends EventEmitter {
  constructor({ maxPending = 2048 } = {}) {
    super();
    this.maxPending = maxPending;
    this.pending = new Map();
    this.seen = new Map();
    this.stats = { received: 0, accepted: 0, duplicate: 0, dropped: 0 };
  }

  normalize(trigger) {
    if (!trigger || typeof trigger !== "object") throw new Error("trigger required");
    const rawTx = trigger.rawTx || null;
    const hash = trigger.hash || (rawTx ? utils.keccak256(rawTx) : null);
    if (!hash) throw new Error("trigger hash or rawTx required");
    const pools = [...new Set((trigger.affectedPools || []).map(x => String(x).toLowerCase()))];
    return {
      ...trigger,
      hash: hash.toLowerCase(),
      rawTx,
      affectedPools: pools,
      receivedAt: trigger.receivedAt || Date.now(),
    };
  }

  push(trigger) {
    this.stats.received++;
    const item = this.normalize(trigger);
    if (this.seen.has(item.hash)) {
      this.stats.duplicate++;
      return false;
    }
    this.seen.set(item.hash, item.receivedAt);
    while (this.seen.size > this.maxPending * 8) this.seen.delete(this.seen.keys().next().value);
    if (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value;
      this.pending.delete(oldest);
      this.stats.dropped++;
    }
    this.pending.set(item.hash, item);
    this.stats.accepted++;
    this.emit("trigger", item);
    return true;
  }

  take(hash) {
    hash = String(hash).toLowerCase();
    const item = this.pending.get(hash) || null;
    if (item) this.pending.delete(hash);
    return item;
  }

  snapshot() {
    return { ...this.stats, pending: this.pending.size };
  }
}

module.exports = { TriggerIntake };
