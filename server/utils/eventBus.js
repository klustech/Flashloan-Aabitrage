/**
 * server/utils/eventBus.js
 *
 * Simple event bus for cross-module communication without circular dependencies.
 * Used for broadcasting real-time events like opportunities and trades.
 */

const { EventEmitter } = require("events");

class BotEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(20); // Allow multiple subscribers
  }

  // Emit a new arbitrage opportunity detected
  emitOpportunity(opportunity) {
    this.emit("opportunity", opportunity);
  }

  // Emit a trade execution result
  emitTradeExecuted(result) {
    this.emit("trade_executed", result);
  }

  // Emit a price update
  emitPriceUpdate(priceData) {
    this.emit("price_update", priceData);
  }

  // Emit circuit breaker state change
  emitCircuitBreakerChange(state) {
    this.emit("circuit_breaker", state);
  }

  // Emit Connext transfer event
  emitConnextTransfer(transferData) {
    this.emit("connext_transfer", transferData);
  }
}

// Singleton instance
const eventBus = new BotEventBus();

module.exports = eventBus;
