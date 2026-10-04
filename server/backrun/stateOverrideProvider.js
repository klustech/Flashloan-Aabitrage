const { utils } = require("ethers");

function rpcQuantity(value) {
  if (value === undefined || value === null) return undefined;
  return utils.hexValue(value);
}

function normalizeRpcTransaction(tx = {}) {
  const out = {};
  for (const key of ["from", "to", "data"]) {
    if (tx[key] !== undefined && tx[key] !== null) out[key] = tx[key];
  }
  for (const [src, dst] of [
    ["gasLimit", "gas"],
    ["gas", "gas"],
    ["gasPrice", "gasPrice"],
    ["maxFeePerGas", "maxFeePerGas"],
    ["maxPriorityFeePerGas", "maxPriorityFeePerGas"],
    ["value", "value"],
    ["nonce", "nonce"],
    ["type", "type"],
  ]) {
    if (out[dst] !== undefined) continue;
    const value = tx[src];
    if (value !== undefined && value !== null) out[dst] = rpcQuantity(value);
  }
  if (tx.accessList) out.accessList = tx.accessList;
  return out;
}

function normalizeBlockTag(blockTag) {
  if (blockTag === undefined || blockTag === null) return "latest";
  if (typeof blockTag === "number") return utils.hexValue(blockTag);
  return blockTag;
}

class StateOverrideProvider {
  constructor(baseProvider, { blockTag = "latest", stateOverrides = {} } = {}) {
    if (!baseProvider || typeof baseProvider.send !== "function") {
      throw new Error("StateOverrideProvider requires a JSON-RPC provider with send()");
    }
    this.base = baseProvider;
    this.blockTag = normalizeBlockTag(blockTag);
    this.stateOverrides = stateOverrides;
    this._isProvider = true;
  }

  getNetwork() { return this.base.getNetwork(); }
  resolveName(name) { return this.base.resolveName ? this.base.resolveName(name) : Promise.resolve(name); }
  getBlock(tag) { return this.base.getBlock(tag); }
  getBlockNumber() { return this.base.getBlockNumber(); }
  getCode(address, tag) { return this.base.getCode(address, tag ?? this.blockTag); }
  getBalance(address, tag) { return this.base.getBalance(address, tag ?? this.blockTag); }
  getTransaction(hash) { return this.base.getTransaction(hash); }
  getTransactionReceipt(hash) { return this.base.getTransactionReceipt(hash); }
  getTransactionCount(address, tag) { return this.base.getTransactionCount(address, tag); }
  getGasPrice() { return this.base.getGasPrice(); }
  getFeeData() { return this.base.getFeeData(); }
  on(...args) { this.base.on(...args); return this; }
  off(...args) { this.base.off(...args); return this; }
  removeListener(...args) { this.base.removeListener(...args); return this; }

  async call(transaction, blockTag) {
    return this.base.send("eth_call", [
      normalizeRpcTransaction(transaction),
      normalizeBlockTag(blockTag ?? this.blockTag),
      this.stateOverrides,
    ]);
  }

  async estimateGas(transaction) {
    try {
      return await this.base.send("eth_estimateGas", [
        normalizeRpcTransaction(transaction),
        this.stateOverrides,
      ]);
    } catch (_) {
      return this.base.estimateGas(transaction);
    }
  }

  send(method, params) {
    return this.base.send(method, params);
  }
}

module.exports = {
  StateOverrideProvider,
  normalizeRpcTransaction,
  normalizeBlockTag,
};
