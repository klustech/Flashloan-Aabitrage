const https = require("https");
const EventEmitter = require("events");

class MevShareStream extends EventEmitter {
  constructor({
    url = "https://mev-share.flashbots.net/api/v1/transactions",
    reconnectMs = 1500,
  } = {}) {
    super();
    this.url = url;
    this.reconnectMs = reconnectMs;
    this.closed = true;
    this.request = null;
    this.stats = { connected: false, events: 0, reconnects: 0, errors: 0 };
  }

  start() {
    if (!this.closed) return this;
    this.closed = false;
    this.connect();
    return this;
  }

  connect() {
    if (this.closed) return;
    const req = https.get(
      this.url,
      { headers: { accept: "text/event-stream", "accept-encoding": "identity" } },
      res => {
        if (res.statusCode !== 200) {
          this.stats.errors++;
          res.resume();
          return this.scheduleReconnect(new Error("MEV-Share stream HTTP " + res.statusCode));
        }
        this.stats.connected = true;
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", chunk => {
          buffer += chunk.replace(/\\r\\n/g, "\\n");
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            this.parseFrame(frame);
          }
        });
        res.on("end", () => this.scheduleReconnect());
        res.on("error", err => this.scheduleReconnect(err));
      }
    );
    req.on("error", err => this.scheduleReconnect(err));
    this.request = req;
  }

  parseFrame(frame) {
    const data = frame
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim())
      .join("\n");
    if (!data) return;
    try {
      const event = JSON.parse(data);
      if (!event?.hash) return;
      this.stats.events++;
      this.emit("trigger", {
        source: "mev_share",
        hash: event.hash,
        logs: event.logs || [],
        txs: event.txs || [],
        to: event.to || event.txs?.[0]?.to,
        callData: event.callData || event.txs?.[0]?.callData,
        functionSelector: event.functionSelector || event.txs?.[0]?.functionSelector,
        receivedAt: Date.now(),
        mevGasPrice: event.mevGasPrice,
        gasUsed: event.gasUsed,
      });
    } catch (err) {
      this.stats.errors++;
      this.emit("stream_error", err);
    }
  }

  scheduleReconnect(err) {
    if (err) {
      this.stats.errors++;
      this.emit("stream_error", err);
    }
    this.stats.connected = false;
    this.request?.destroy();
    this.request = null;
    if (this.closed) return;
    clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => {
      this.stats.reconnects++;
      this.connect();
    }, this.reconnectMs);
    this.reconnect.unref?.();
  }

  stop() {
    this.closed = true;
    clearTimeout(this.reconnect);
    this.request?.destroy();
    this.request = null;
    this.stats.connected = false;
  }

  status() {
    return { url: this.url, ...this.stats };
  }
}

module.exports = { MevShareStream };