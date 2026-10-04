const { utils } = require("ethers");
const { normalizeRpcTransaction, normalizeBlockTag } = require("./stateOverrideProvider");

function address(value) {
  return value ? utils.getAddress(value).toLowerCase() : null;
}

function accountOverride(account = {}) {
  const out = {};
  if (account.balance !== undefined) out.balance = account.balance;
  if (account.nonce !== undefined) out.nonce = account.nonce;
  if (account.code !== undefined) out.code = account.code;
  if (account.storage && Object.keys(account.storage).length) {
    out.stateDiff = account.storage;
  }
  return out;
}

class TriggerStatePredictor {
  constructor(provider, { timeoutMs = 2500 } = {}) {
    this.provider = provider;
    this.timeoutMs = timeoutMs;
    this.stats = { attempts: 0, predicted: 0, unsupported: 0, failures: 0 };
  }

  callFromTrigger(trigger) {
    const tx = trigger?.tx || trigger;
    if (!tx) return null;
    const call = {
      from: tx.from,
      to: tx.to || trigger.to,
      data: tx.data || trigger.callData || trigger.data || "0x",
      value: tx.value || trigger.value || 0,
      gasLimit: tx.gasLimit || tx.gas,
      gasPrice: tx.gasPrice,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      accessList: tx.accessList,
      type: tx.type,
    };
    if (!call.to) return null;
    return normalizeRpcTransaction(call);
  }

  async predict(trigger, blockTag, trackedPools = []) {
    this.stats.attempts++;
    const call = this.callFromTrigger(trigger);
    const tracked = new Set(trackedPools.map(address).filter(Boolean));
    const hintedPools = new Set(
      (trigger?.logs || [])
        .map(log => {
          try { return address(log.address); } catch (_) { return null; }
        })
        .filter(a => a && tracked.has(a))
    );

    if (!call || typeof this.provider?.send !== "function") {
      this.stats.unsupported++;
      return {
        supported: false,
        reason: "trigger_call_or_debug_rpc_unavailable",
        stateOverrides: {},
        affectedPools: [...hintedPools],
      };
    }

    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("debug_traceCall timeout")), this.timeoutMs);
      timer.unref?.();
    });

    try {
      const tracePromise = this.provider.send("debug_traceCall", [
        call,
        normalizeBlockTag(blockTag),
        {
          tracer: "prestateTracer",
          tracerConfig: { diffMode: true },
          timeout: Math.max(1, Math.ceil(this.timeoutMs / 1000)) + "s",
        },
      ]);
      const trace = await Promise.race([tracePromise, timeout]);
      const post = trace?.post || {};
      const stateOverrides = {};
      const affectedPools = new Set(hintedPools);

      for (const [rawAddress, account] of Object.entries(post)) {
        let normalized;
        try { normalized = address(rawAddress); } catch (_) { continue; }
        const override = accountOverride(account);
        if (Object.keys(override).length) stateOverrides[normalized] = override;
        if (tracked.has(normalized)) affectedPools.add(normalized);
      }

      this.stats.predicted++;
      return {
        supported: true,
        stateOverrides,
        affectedPools: [...affectedPools],
        touchedAccounts: Object.keys(post).length,
        traceType: "prestateTracer-diff",
      };
    } catch (err) {
      this.stats.failures++;
      return {
        supported: false,
        reason: err.message,
        stateOverrides: {},
        affectedPools: [...hintedPools],
      };
    }
  }

  status() {
    return { ...this.stats };
  }
}

module.exports = { TriggerStatePredictor, accountOverride };
