const { EventEmitter } = require("events");
const { providers } = require("ethers");
const { rawTransaction } = require("../rawTransaction");
class PublicPendingSource extends EventEmitter {
  constructor({ url, provider, websocketFactory = u => new providers.WebSocketProvider(u), maxInflight = 8 }) {
    super(); Object.assign(this, { url, provider, websocketFactory, maxInflight });
    this.closed = true; this.inflight = 0;
    this.stats = { events: 0, errors: 0, saturated: 0, connected: false, lastEventAt: null };
  }
  start() { if (!this.closed) return this; this.closed = false; this.connect(); return this; }
  connect() {
    if (this.closed) return;
    try {
      const ws = this.websocketFactory(this.url); this.ws = ws;
      this.listener = hash => this.fetch(hash);
      ws.on("pending", this.listener);
      const disconnect = () => {
        if (this.ws !== ws) return;
        this.stats.connected = false; this.ws = null;
        ws.removeListener("pending", this.listener); Promise.resolve(ws.destroy()).catch(() => {});
        if (!this.closed) { clearTimeout(this.timer); this.timer = setTimeout(() => this.connect(), 2000); this.timer.unref?.(); }
      };
      ws._websocket?.on("open", () => { if (this.ws === ws) this.stats.connected = true; });
      ws._websocket?.on("close", disconnect); ws._websocket?.on("error", disconnect);
      ws.on("error", disconnect);
      if (ws._websocket?.readyState === 1) this.stats.connected = true;
    } catch (_) {
      this.stats.errors++; this.emit("source_error", new Error("Pending stream connection failed"));
      if (!this.closed) { this.timer = setTimeout(() => this.connect(), 2000); this.timer.unref?.(); }
    }
  }
  async fetch(hash) {
    if (this.closed) return;
    if (this.inflight >= this.maxInflight) { this.stats.saturated++; return; }
    this.inflight++;
    try {
      const transaction = await this.provider.getTransaction(hash);
      if (!transaction || transaction.blockNumber !== null) return;
      const rawTx = await rawTransaction(this.provider, transaction);
      if (this.closed) return;
      this.stats.events++; this.stats.lastEventAt = Date.now();
      this.emit("hint", { hash, rawTx, transaction, source: "public_pending", receivedAt: Date.now() });
    } catch (_) { this.stats.errors++; this.emit("source_error", new Error("Pending signed transaction unavailable")); }
    finally { this.inflight--; }
  }
  stop() {
    this.closed = true; this.stats.connected = false; clearTimeout(this.timer);
    if (this.ws) { const ws = this.ws; this.ws = null; ws.removeListener("pending", this.listener); Promise.resolve(ws.destroy()).catch(() => {}); }
  }
  status() { return { ...this.stats, inflight: this.inflight, closed: this.closed }; }
}
module.exports = { PublicPendingSource };
