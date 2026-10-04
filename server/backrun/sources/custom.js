const { EventEmitter } = require("events");
// The source is an explicit injection point. Calling feed does not bypass
// decoder, predictor, authentication at ingress, or execution guards.
class CustomSource extends EventEmitter {
  constructor() { super(); this.connected = false; this.events = 0; }
  start() { this.connected = true; return this; }
  stop() { this.connected = false; }
  feed(hint) {
    if (!this.connected) throw new Error("Custom source stopped");
    this.events++; this.emit("hint", { ...hint, source: "custom", receivedAt: Date.now() });
  }
  status() { return { connected: this.connected, events: this.events }; }
}
module.exports = { CustomSource };
