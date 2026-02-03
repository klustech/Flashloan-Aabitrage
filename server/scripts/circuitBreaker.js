/**
 * server/scripts/circuitBreaker.js
 *
 * Circuit Breaker System for Flash Loan Arbitrage Bot
 * Protects against cascading losses and system failures
 *
 * Features:
 * - Daily drawdown limits
 * - Consecutive failure tracking
 * - Time-based cooldowns
 * - Automatic recovery
 * - Emergency stop functionality
 */

const { ethers, BigNumber } = require("ethers");
const EventEmitter = require("events");

// Circuit breaker states
const BreakerState = {
  CLOSED: "CLOSED",       // Normal operation
  HALF_OPEN: "HALF_OPEN", // Testing after cooldown
  OPEN: "OPEN",           // Circuit broken, no operations
  EMERGENCY: "EMERGENCY", // Manual emergency stop
};

// Trigger reasons
const TriggerReason = {
  CONSECUTIVE_LOSSES: "consecutive_losses",
  DAILY_DRAWDOWN: "daily_drawdown",
  FAILURE_RATE: "failure_rate",
  GAS_ANOMALY: "gas_anomaly",
  MANUAL: "manual",
  LIQUIDITY: "liquidity",
};

// Default configuration
const DEFAULT_CONFIG = {
  // Consecutive failure limits
  maxConsecutiveLosses: 5,
  maxConsecutiveFailures: 10,

  // Daily limits
  dailyDrawdownLimitDAI: 500,      // Stop if daily loss exceeds $500
  dailyMaxTransactions: 100,       // Max transactions per day

  // Failure rate limits
  failureRateWindow: 3600000,      // 1 hour window
  failureRateThreshold: 0.5,       // 50% failure rate triggers breaker

  // Cooldown periods (in milliseconds)
  cooldownPeriod: 300000,          // 5 minutes default cooldown
  escalatingCooldown: true,        // Double cooldown on repeated triggers
  maxCooldown: 3600000,            // Max 1 hour cooldown

  // Recovery
  recoveryThreshold: 3,            // Successful trades needed to fully recover
  testTradeLimit: 0.1,             // Test with 10% of normal size in half-open

  // Gas anomaly detection
  maxGasPriceGwei: 500,            // Emergency stop if gas exceeds this
  gasAnomalyWindow: 60000,         // 1 minute
  gasAnomalyThreshold: 3,          // Standard deviations

  // Persistence
  persistState: true,
  stateFile: "circuit_breaker_state.json",
};

class CircuitBreaker extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = BreakerState.CLOSED;
    this.triggerReason = null;

    // Tracking metrics
    this.consecutiveLosses = 0;
    this.consecutiveFailures = 0;
    this.dailyPnL = BigNumber.from(0);
    this.dailyTransactions = 0;
    this.lastDayReset = this.getStartOfDay();
    this.recentResults = [];  // { success, profit, timestamp }
    this.gasPriceHistory = [];
    this.cooldownMultiplier = 1;
    this.cooldownEndTime = 0;
    this.recoveryCount = 0;
    this.lastStateChange = Date.now();

    // Statistics
    this.stats = {
      totalTriggered: 0,
      triggersByReason: {},
      recoveries: 0,
      lastTriggered: null,
      lastRecovered: null,
    };

    this.loadState();
    this.startDailyResetTimer();
  }

  /**
   * Get start of current day (UTC)
   */
  getStartOfDay() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
  }

  /**
   * Start daily reset timer
   */
  startDailyResetTimer() {
    // Check every minute for day change
    setInterval(() => {
      const currentDayStart = this.getStartOfDay();
      if (currentDayStart > this.lastDayReset) {
        this.resetDailyCounters();
        this.lastDayReset = currentDayStart;
      }
    }, 60000);
  }

  /**
   * Reset daily counters
   */
  resetDailyCounters() {
    this.dailyPnL = BigNumber.from(0);
    this.dailyTransactions = 0;
    this.emit("dailyReset", { timestamp: Date.now() });
  }

  /**
   * Check if trading is allowed
   * @returns {Object} - { allowed, reason, state }
   */
  canTrade() {
    // Check for day rollover
    if (this.getStartOfDay() > this.lastDayReset) {
      this.resetDailyCounters();
      this.lastDayReset = this.getStartOfDay();
    }

    // Emergency state blocks everything
    if (this.state === BreakerState.EMERGENCY) {
      return {
        allowed: false,
        reason: "Emergency stop active",
        state: this.state,
      };
    }

    // Open state checks cooldown
    if (this.state === BreakerState.OPEN) {
      if (Date.now() < this.cooldownEndTime) {
        const remaining = Math.ceil((this.cooldownEndTime - Date.now()) / 1000);
        return {
          allowed: false,
          reason: `Circuit open, cooldown: ${remaining}s remaining`,
          state: this.state,
          cooldownRemaining: remaining,
        };
      }
      // Cooldown expired, transition to half-open
      this.transitionTo(BreakerState.HALF_OPEN);
    }

    // Half-open allows limited testing
    if (this.state === BreakerState.HALF_OPEN) {
      return {
        allowed: true,
        reason: "Testing after cooldown",
        state: this.state,
        testMode: true,
        sizeLimitPercent: this.config.testTradeLimit * 100,
      };
    }

    // Closed state - check limits
    if (this.dailyTransactions >= this.config.dailyMaxTransactions) {
      return {
        allowed: false,
        reason: "Daily transaction limit reached",
        state: this.state,
      };
    }

    return {
      allowed: true,
      reason: "Normal operation",
      state: this.state,
    };
  }

  /**
   * Record a trade result
   * @param {Object} result - Trade result
   */
  recordResult(result) {
    const { success, profit = BigNumber.from(0), gasPrice, timestamp = Date.now() } = result;

    // Update daily metrics
    this.dailyTransactions++;
    this.dailyPnL = this.dailyPnL.add(profit);

    // Track recent results
    this.recentResults.push({ success, profit, timestamp });
    // Keep last hour of results
    this.recentResults = this.recentResults.filter(
      r => timestamp - r.timestamp < this.config.failureRateWindow
    );

    // Track gas prices
    if (gasPrice) {
      this.gasPriceHistory.push({ price: gasPrice, timestamp });
      this.gasPriceHistory = this.gasPriceHistory.filter(
        g => timestamp - g.timestamp < this.config.gasAnomalyWindow
      );
    }

    // Update consecutive counters
    if (success) {
      if (profit.gte(0)) {
        this.consecutiveLosses = 0;
      } else {
        this.consecutiveLosses++;
      }
      this.consecutiveFailures = 0;

      // Check recovery in half-open state
      if (this.state === BreakerState.HALF_OPEN) {
        this.recoveryCount++;
        if (this.recoveryCount >= this.config.recoveryThreshold) {
          this.transitionTo(BreakerState.CLOSED);
          this.cooldownMultiplier = 1;
          this.stats.recoveries++;
          this.stats.lastRecovered = timestamp;
          this.emit("recovered", { timestamp });
        }
      }
    } else {
      this.consecutiveFailures++;
    }

    // Check trigger conditions
    this.checkTriggerConditions();
    this.saveState();
  }

  /**
   * Check if any trigger conditions are met
   */
  checkTriggerConditions() {
    // Already open or emergency
    if (this.state === BreakerState.OPEN || this.state === BreakerState.EMERGENCY) {
      return;
    }

    // Check consecutive losses
    if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      this.trigger(TriggerReason.CONSECUTIVE_LOSSES);
      return;
    }

    // Check consecutive failures
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.trigger(TriggerReason.FAILURE_RATE);
      return;
    }

    // Check daily drawdown
    const drawdownLimit = ethers.utils.parseUnits(
      this.config.dailyDrawdownLimitDAI.toString(),
      18
    );
    if (this.dailyPnL.lt(0) && this.dailyPnL.abs().gte(drawdownLimit)) {
      this.trigger(TriggerReason.DAILY_DRAWDOWN);
      return;
    }

    // Check failure rate
    if (this.recentResults.length >= 10) {
      const failures = this.recentResults.filter(r => !r.success).length;
      const rate = failures / this.recentResults.length;
      if (rate >= this.config.failureRateThreshold) {
        this.trigger(TriggerReason.FAILURE_RATE);
        return;
      }
    }

    // Check gas anomaly
    if (this.gasPriceHistory.length >= 5) {
      const prices = this.gasPriceHistory.map(g =>
        parseFloat(ethers.utils.formatUnits(g.price, "gwei"))
      );
      const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
      const std = Math.sqrt(
        prices.map(p => Math.pow(p - mean, 2)).reduce((a, b) => a + b, 0) / prices.length
      );
      const latest = prices[prices.length - 1];

      if (std > 0 && (latest - mean) / std > this.config.gasAnomalyThreshold) {
        this.trigger(TriggerReason.GAS_ANOMALY);
        return;
      }

      if (latest > this.config.maxGasPriceGwei) {
        this.trigger(TriggerReason.GAS_ANOMALY);
        return;
      }
    }
  }

  /**
   * Trigger the circuit breaker
   * @param {string} reason - Trigger reason
   */
  trigger(reason) {
    if (this.state === BreakerState.EMERGENCY) return;

    this.triggerReason = reason;
    this.transitionTo(BreakerState.OPEN);

    // Calculate cooldown with escalation
    let cooldown = this.config.cooldownPeriod;
    if (this.config.escalatingCooldown) {
      cooldown = Math.min(
        this.config.maxCooldown,
        cooldown * this.cooldownMultiplier
      );
      this.cooldownMultiplier *= 2;
    }
    this.cooldownEndTime = Date.now() + cooldown;
    this.recoveryCount = 0;

    // Update stats
    this.stats.totalTriggered++;
    this.stats.triggersByReason[reason] = (this.stats.triggersByReason[reason] || 0) + 1;
    this.stats.lastTriggered = Date.now();

    this.emit("triggered", {
      reason,
      cooldownMs: cooldown,
      cooldownEndTime: this.cooldownEndTime,
      consecutiveLosses: this.consecutiveLosses,
      consecutiveFailures: this.consecutiveFailures,
      dailyPnL: this.dailyPnL.toString(),
    });

    this.saveState();
  }

  /**
   * Transition to a new state
   * @param {string} newState - Target state
   */
  transitionTo(newState) {
    const oldState = this.state;
    this.state = newState;
    this.lastStateChange = Date.now();

    this.emit("stateChange", {
      from: oldState,
      to: newState,
      timestamp: Date.now(),
    });
  }

  /**
   * Emergency stop - manual override
   * @param {string} reason - Reason for emergency stop
   */
  emergencyStop(reason = "Manual intervention") {
    this.triggerReason = TriggerReason.MANUAL;
    this.transitionTo(BreakerState.EMERGENCY);

    this.emit("emergency", {
      reason,
      timestamp: Date.now(),
    });

    this.saveState();
  }

  /**
   * Reset from emergency state
   * @param {boolean} force - Force reset even if conditions aren't met
   */
  reset(force = false) {
    if (this.state !== BreakerState.EMERGENCY && !force) {
      return { success: false, reason: "Not in emergency state" };
    }

    this.transitionTo(BreakerState.HALF_OPEN);
    this.consecutiveLosses = 0;
    this.consecutiveFailures = 0;
    this.recoveryCount = 0;
    this.cooldownMultiplier = 1;
    this.cooldownEndTime = 0;
    this.triggerReason = null;

    this.emit("reset", { timestamp: Date.now() });
    this.saveState();

    return { success: true };
  }

  /**
   * Get current status
   * @returns {Object} - Status information
   */
  getStatus() {
    const canTradeResult = this.canTrade();

    return {
      state: this.state,
      canTrade: canTradeResult.allowed,
      reason: canTradeResult.reason,
      triggerReason: this.triggerReason,
      consecutiveLosses: this.consecutiveLosses,
      consecutiveFailures: this.consecutiveFailures,
      dailyPnL: ethers.utils.formatUnits(this.dailyPnL, 18),
      dailyTransactions: this.dailyTransactions,
      cooldownRemaining: this.state === BreakerState.OPEN
        ? Math.max(0, Math.ceil((this.cooldownEndTime - Date.now()) / 1000))
        : 0,
      recoveryProgress: this.state === BreakerState.HALF_OPEN
        ? `${this.recoveryCount}/${this.config.recoveryThreshold}`
        : null,
      stats: this.stats,
      lastStateChange: this.lastStateChange,
    };
  }

  /**
   * Save state to file
   */
  saveState() {
    if (!this.config.persistState) return;

    const state = {
      state: this.state,
      triggerReason: this.triggerReason,
      consecutiveLosses: this.consecutiveLosses,
      consecutiveFailures: this.consecutiveFailures,
      dailyPnL: this.dailyPnL.toString(),
      dailyTransactions: this.dailyTransactions,
      lastDayReset: this.lastDayReset,
      cooldownMultiplier: this.cooldownMultiplier,
      cooldownEndTime: this.cooldownEndTime,
      recoveryCount: this.recoveryCount,
      stats: this.stats,
      savedAt: Date.now(),
    };

    try {
      const fs = require("fs");
      const path = require("path");
      const filePath = path.resolve(__dirname, "..", this.config.stateFile);
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error(`[CircuitBreaker] Failed to save state: ${err.message}`);
    }
  }

  /**
   * Load state from file
   */
  loadState() {
    if (!this.config.persistState) return;

    try {
      const fs = require("fs");
      const path = require("path");
      const filePath = path.resolve(__dirname, "..", this.config.stateFile);

      if (!fs.existsSync(filePath)) return;

      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

      // Restore state if saved within last 24 hours
      if (data.savedAt && Date.now() - data.savedAt < 86400000) {
        this.state = data.state || BreakerState.CLOSED;
        this.triggerReason = data.triggerReason;
        this.consecutiveLosses = data.consecutiveLosses || 0;
        this.consecutiveFailures = data.consecutiveFailures || 0;
        this.cooldownMultiplier = data.cooldownMultiplier || 1;
        this.cooldownEndTime = data.cooldownEndTime || 0;
        this.recoveryCount = data.recoveryCount || 0;
        this.stats = data.stats || this.stats;

        // Only restore daily metrics if same day
        if (data.lastDayReset === this.getStartOfDay()) {
          this.dailyPnL = BigNumber.from(data.dailyPnL || 0);
          this.dailyTransactions = data.dailyTransactions || 0;
        }
      }
    } catch (err) {
      console.warn(`[CircuitBreaker] Failed to load state: ${err.message}`);
    }
  }
}

// Singleton instance
let instance = null;

function initCircuitBreaker(config = {}) {
  instance = new CircuitBreaker(config);
  return instance;
}

function getCircuitBreaker() {
  if (!instance) {
    instance = new CircuitBreaker();
  }
  return instance;
}

module.exports = {
  CircuitBreaker,
  initCircuitBreaker,
  getCircuitBreaker,
  BreakerState,
  TriggerReason,
  DEFAULT_CONFIG,
};
