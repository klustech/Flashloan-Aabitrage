const { paperOnly, assertLiveAllowed } = require("../config/paperPolicy");
class TradingStateMachine {
  constructor() {
    this.state = "STOPPED";
    this.revision = 0;
    this.reason = null;
    this.armedUntil = 0;
  }
  snapshot() {
    return {
      paperOnly: paperOnly(),
      state: this.state,
      mode: this.state.startsWith("LIVE")
        ? "LIVE"
        : this.state === "PAPER"
        ? "PAPER"
        : this.state,
      armed: this.state === "LIVE_ARMED" || this.state === "LIVE_RUNNING",
      revision: this.revision,
      reason: this.reason,
      armedUntil: this.armedUntil,
    };
  }
  set(state, reason = null) {
    if (state.startsWith("LIVE")) assertLiveAllowed();
    this.state = state;
    this.reason = reason;
    this.revision++;
    if (!state.startsWith("LIVE")) this.armedUntil = 0;
    return this.snapshot();
  }
  paper() {
    return this.set("PAPER");
  }
  stop() {
    return this.set("STOPPED");
  }
  pause(reason = "Operator pause") {
    return this.set("PAUSED", reason);
  }
  arm(readiness) {
    assertLiveAllowed();
    if (this.state !== "PAPER") throw new Error("Start PAPER before arming");
    if (!readiness?.ready)
      throw new Error(
        `LIVE refused: ${(readiness?.errors || ["readiness unavailable"]).join(
          "; "
        )}`
      );
    this.armedUntil = Date.now() + 60000;
    return this.set("LIVE_ARMED");
  }
  live() {
    assertLiveAllowed();
    if (this.state !== "LIVE_ARMED" || Date.now() > this.armedUntil) {
      this.paper();
      throw new Error("LIVE arm expired");
    }
    return this.set("LIVE_RUNNING");
  }
  canSign(revision) {
    return (
      !paperOnly() &&
      this.state === "LIVE_RUNNING" &&
      (revision === undefined || revision === this.revision)
    );
  }
}
const tradingState = new TradingStateMachine();
module.exports = { TradingStateMachine, tradingState };
