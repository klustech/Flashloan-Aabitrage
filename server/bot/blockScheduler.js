const { providers } = require('ethers');
class BlockScheduler {
  constructor({ provider, run, enabled = () => true, cancellable = () => true, budgetMs = () => 5000, websocketUrl, onError = () => {}, pollIntervalMs = 1000, websocketFactory = url => new providers.WebSocketProvider(url) }) {
    Object.assign(this, { provider, run, enabled, cancellable, budgetMs, websocketUrl, onError, pollIntervalMs, websocketFactory });
    this.stats = { source: 'http', received: 0, scans: 0, superseded: 0, budgetExpired: 0 };
    this.closed = true; this.running = false; this.pending = null; this.active = null; this.lastNumber = null;
    this.blockListener = number => this.enqueue(number);
    this.websocketBlockListener = number => Promise.resolve().then(() => this.provider.getBlock(number)).then(block => { if (block?.hash) this.enqueue(block.number); }).catch(err => { if (!this.closed) this.onError(err); });
  }
  start() {
    if (!this.closed) return this;
    this.closed = false;
    this.provider.pollingInterval = this.pollIntervalMs;
    this.provider.on('block', this.blockListener); // Independent HTTP fallback remains subscribed.
    if (this.websocketUrl) this.connectWebsocket();
    return this;
  }
  connectWebsocket() {
    if (this.closed) return;
    try {
      const ws = this.websocketFactory(this.websocketUrl);
      this.websocket = ws; this.stats.source = 'websocket+http';
      ws.on('block', this.websocketBlockListener);
      const disconnected = () => {
        if (this.websocket !== ws) return;
        this.websocket = null; this.stats.source = 'http';
        ws.removeListener('block', this.websocketBlockListener);
        Promise.resolve(ws.destroy()).catch(() => {});
        if (!this.closed) { clearTimeout(this.reconnect); this.reconnect = setTimeout(() => this.connectWebsocket(), 5000); this.reconnect.unref?.(); }
      };
      // Ethers v5 exposes the transport here; use close/error only to recover.
      ws._websocket?.on('close', disconnected);
      ws._websocket?.on('error', disconnected);
      ws.on('error', disconnected);
    } catch (err) { this.stats.source = 'http'; this.onError(err); if (!this.closed) { this.reconnect = setTimeout(() => this.connectWebsocket(), 5000); this.reconnect.unref?.(); } }
  }
  enqueue(number) {
    if (this.closed || !this.enabled() || !Number.isSafeInteger(number)) return;
    if (number === this.lastNumber || number <= (this.highestSeen ?? -1)) return;
    this.highestSeen = number;
    this.stats.received++; this.pending = number;
    if (this.active && this.cancellable()) { this.stats.superseded++; this.active.abort(); }
    if (!this.running) this.drain();
  }
  async drain() {
    this.running = true;
    try {
      while (!this.closed && this.pending !== null) {
        const number = this.pending; this.pending = null;
        if (!this.enabled()) continue;
        const controller = new AbortController(); this.active = controller;
        const timer = setTimeout(() => { this.stats.budgetExpired++; controller.abort(); }, this.budgetMs());
        try { this.stats.scans++; await this.run({ signal: controller.signal, triggerBlock: number }); this.lastNumber = number; }
        catch (err) { if (err.name !== 'AbortError') this.onError(err); }
        finally { clearTimeout(timer); this.active = null; }
      }
    } finally { this.running = false; }
  }
  stop() {
    this.closed = true; this.pending = null; this.active?.abort(); clearTimeout(this.reconnect);
    this.provider.removeListener('block', this.blockListener);
    if (this.websocket) { const ws = this.websocket; this.websocket = null; ws.removeListener('block', this.websocketBlockListener); Promise.resolve(ws.destroy()).catch(() => {}); }
  }
  status() { return { ...this.stats, running: this.running, queuedBlock: this.pending, lastBlock: this.lastNumber }; }
}
module.exports = { BlockScheduler };
