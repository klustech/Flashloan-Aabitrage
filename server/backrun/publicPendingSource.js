const EventEmitter = require("events");
const { providers, utils } = require("ethers");

const DEFAULT_AGGREGATORS = [
  "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", // KyberSwap Meta Aggregation Router v2
  "0x1111111254EEB25477B68fb85Ed929f73A960582", // 1inch
  "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD", // Uniswap Universal Router
];

function normalize(address) {
  try { return utils.getAddress(address).toLowerCase(); } catch (_) { return null; }
}

function unsignedFields(tx) {
  const out = {
    chainId: tx.chainId,
    nonce: tx.nonce,
    gasLimit: tx.gasLimit,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    type: tx.type,
  };
  if (tx.gasPrice != null) out.gasPrice = tx.gasPrice;
  if (tx.maxFeePerGas != null) out.maxFeePerGas = tx.maxFeePerGas;
  if (tx.maxPriorityFeePerGas != null) out.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
  if (tx.accessList != null) out.accessList = tx.accessList;
  return out;
}

function serializeSignedTransaction(tx) {
  if (!tx?.r || !tx?.s || tx?.v === undefined || tx?.v === null) return null;
  try {
    return utils.serializeTransaction(unsignedFields(tx), {
      r: tx.r,
      s: tx.s,
      v: tx.v,
    });
  } catch (_) {
    return null;
  }
}

class PublicPendingSource extends EventEmitter {
  constructor({
    websocketUrl,
    routers = [],
    extraRouters = [],
    providerFactory = url => new providers.WebSocketProvider(url),
    maxInflight = 64,
  } = {}) {
    super();
    this.websocketUrl = websocketUrl;
    this.providerFactory = providerFactory;
    this.maxInflight = maxInflight;
    this.routers = new Set(
      [...DEFAULT_AGGREGATORS, ...routers, ...extraRouters]
        .map(normalize)
        .filter(Boolean)
    );
    this.closed = true;
    this.inflight = 0;
    this.stats = {
      connected: false,
      pendingSeen: 0,
      fetched: 0,
      relevant: 0,
      emitted: 0,
      droppedBusy: 0,
      errors: 0,
    };
    this.listener = hash => this.handle(hash);
  }

  start() {
    if (!this.closed) return this;
    if (!this.websocketUrl) throw new Error("MAINNET_WEBSOCKET required for public pending backruns");
    this.closed = false;
    this.provider = this.providerFactory(this.websocketUrl);
    this.provider.on("pending", this.listener);
    this.provider.on("error", err => this.emit("source_error", err));
    this.stats.connected = true;
    return this;
  }

  async handle(hash) {
    if (this.closed) return;
    this.stats.pendingSeen++;
    if (this.inflight >= this.maxInflight) {
      this.stats.droppedBusy++;
      return;
    }
    this.inflight++;
    try {
      const tx = await this.provider.getTransaction(hash);
      this.stats.fetched++;
      if (!tx?.to || !this.routers.has(normalize(tx.to))) return;
      this.stats.relevant++;
      const rawTx = serializeSignedTransaction(tx);
      this.emit("trigger", {
        source: "public_pending",
        hash: tx.hash || hash,
        rawTx,
        tx,
        to: tx.to,
        callData: tx.data,
        functionSelector: tx.data?.slice(0,10),
        receivedAt: Date.now(),
      });
      this.stats.emitted++;
    } catch (err) {
      this.stats.errors++;
      this.emit("source_error", err);
    } finally {
      this.inflight--;
    }
  }

  stop() {
    this.closed = true;
    if (this.provider) {
      this.provider.removeListener("pending", this.listener);
      Promise.resolve(this.provider.destroy?.()).catch(()=>{});
      this.provider = null;
    }
    this.stats.connected = false;
  }

  status() {
    return { ...this.stats, routers: this.routers.size, inflight: this.inflight };
  }
}

module.exports = { PublicPendingSource, serializeSignedTransaction, DEFAULT_AGGREGATORS };
