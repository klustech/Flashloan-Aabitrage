/**
 * server/scripts/riskManager.js
 *
 * Advanced statistical risk controls for the arbitrage bot.
 * Implements VaR-based position limits, Sharpe ratio tracking,
 * anomaly detection, and automated strategy pause.
 */

const { ethers, BigNumber } = require("ethers");
const winston = require("winston");
const EventEmitter = require("events");

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [new winston.transports.Console()],
});

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const RISK_CONFIG = {
  // VaR Settings
  VAR_CONFIDENCE_LEVEL: parseFloat(process.env.VAR_CONFIDENCE || "0.95"), // 95% confidence
  VAR_HORIZON_HOURS: parseInt(process.env.VAR_HORIZON_HOURS || "24", 10),
  MAX_VAR_PERCENT: parseFloat(process.env.MAX_VAR_PERCENT || "5"), // Max 5% VaR

  // Position Limits
  MAX_SINGLE_TRADE_DAI: parseFloat(process.env.MAX_SINGLE_TRADE_DAI || "10000"),
  MAX_DAILY_VOLUME_DAI: parseFloat(process.env.MAX_DAILY_VOLUME_DAI || "100000"),
  MAX_OPEN_POSITIONS: parseInt(process.env.MAX_OPEN_POSITIONS || "5", 10),

  // Drawdown Limits
  MAX_DAILY_DRAWDOWN_PERCENT: parseFloat(process.env.MAX_DAILY_DRAWDOWN_PERCENT || "10"),
  MAX_WEEKLY_DRAWDOWN_PERCENT: parseFloat(process.env.MAX_WEEKLY_DRAWDOWN_PERCENT || "20"),

  // Performance Thresholds
  MIN_SHARPE_RATIO: parseFloat(process.env.MIN_SHARPE_RATIO || "0.5"),
  MIN_WIN_RATE: parseFloat(process.env.MIN_WIN_RATE || "0.3"), // 30%

  // Anomaly Detection
  ANOMALY_ZSCORE_THRESHOLD: parseFloat(process.env.ANOMALY_ZSCORE || "3"),
  MIN_SAMPLES_FOR_ANOMALY: parseInt(process.env.MIN_ANOMALY_SAMPLES || "20", 10),

  // Auto-pause Settings
  AUTO_PAUSE_ON_ANOMALY: process.env.AUTO_PAUSE_ON_ANOMALY !== "false",
  PAUSE_COOLDOWN_MINUTES: parseInt(process.env.PAUSE_COOLDOWN_MINUTES || "30", 10),

  // Data Retention
  TRADE_HISTORY_DAYS: parseInt(process.env.TRADE_HISTORY_DAYS || "30", 10),
};

// ─────────────────────────────────────────────────────────────────────────────
// Statistical Utilities
// ─────────────────────────────────────────────────────────────────────────────

const stats = {
  /**
   * Calculate mean
   */
  mean(values) {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  },

  /**
   * Calculate standard deviation
   */
  stdDev(values) {
    if (values.length < 2) return 0;
    const avg = this.mean(values);
    const squareDiffs = values.map((v) => Math.pow(v - avg, 2));
    return Math.sqrt(this.mean(squareDiffs));
  },

  /**
   * Calculate percentile
   */
  percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  },

  /**
   * Calculate Z-score for a value
   */
  zScore(value, mean, stdDev) {
    if (stdDev === 0) return 0;
    return (value - mean) / stdDev;
  },

  /**
   * Calculate Sharpe ratio
   * @param {number[]} returns - Array of returns
   * @param {number} riskFreeRate - Annual risk-free rate (default 0)
   */
  sharpeRatio(returns, riskFreeRate = 0) {
    if (returns.length < 2) return 0;

    const avgReturn = this.mean(returns);
    const stdReturn = this.stdDev(returns);

    if (stdReturn === 0) return avgReturn > 0 ? Infinity : -Infinity;

    // Annualize (assuming daily returns)
    const annualizedReturn = avgReturn * 365;
    const annualizedStd = stdReturn * Math.sqrt(365);

    return (annualizedReturn - riskFreeRate) / annualizedStd;
  },

  /**
   * Calculate Value at Risk (Historical)
   */
  historicalVaR(returns, confidence = 0.95) {
    if (returns.length === 0) return 0;
    const percentileValue = (1 - confidence) * 100;
    return -this.percentile(returns, percentileValue);
  },

  /**
   * Calculate Maximum Drawdown
   */
  maxDrawdown(equityCurve) {
    if (equityCurve.length < 2) return 0;

    let peak = equityCurve[0];
    let maxDD = 0;

    for (const value of equityCurve) {
      if (value > peak) peak = value;
      const drawdown = (peak - value) / peak;
      if (drawdown > maxDD) maxDD = drawdown;
    }

    return maxDD;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Risk Manager Class
// ─────────────────────────────────────────────────────────────────────────────

class RiskManager extends EventEmitter {
  constructor() {
    super();

    // Trade history
    this.trades = [];
    this.dailyPnL = [];
    this.equityCurve = [0]; // Starting equity

    // Current state
    this.state = {
      isPaused: false,
      pauseReason: null,
      pausedAt: null,
      currentEquity: 0,
      dailyVolume: 0,
      openPositions: 0,
    };

    // Metrics
    this.metrics = {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      totalProfit: 0,
      totalLoss: 0,
      largestWin: 0,
      largestLoss: 0,
    };

    // Alerts
    this.alerts = [];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Trade Recording
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Record a completed trade
   */
  recordTrade(trade) {
    const {
      timestamp = Date.now(),
      profitDai,
      volumeDai,
      gasUsed,
      gasCostDai,
      route,
      success,
    } = trade;

    const tradeRecord = {
      timestamp,
      profitDai: parseFloat(profitDai),
      volumeDai: parseFloat(volumeDai),
      gasUsed,
      gasCostDai: parseFloat(gasCostDai),
      netProfitDai: parseFloat(profitDai) - parseFloat(gasCostDai),
      route,
      success,
    };

    this.trades.push(tradeRecord);
    this._updateMetrics(tradeRecord);
    this._updateEquityCurve(tradeRecord);
    this._checkRiskLimits();

    // Clean old trades
    this._cleanOldTrades();

    return tradeRecord;
  }

  _updateMetrics(trade) {
    this.metrics.totalTrades++;

    if (trade.netProfitDai > 0) {
      this.metrics.winningTrades++;
      this.metrics.totalProfit += trade.netProfitDai;
      if (trade.netProfitDai > this.metrics.largestWin) {
        this.metrics.largestWin = trade.netProfitDai;
      }
    } else {
      this.metrics.losingTrades++;
      this.metrics.totalLoss += Math.abs(trade.netProfitDai);
      if (Math.abs(trade.netProfitDai) > this.metrics.largestLoss) {
        this.metrics.largestLoss = Math.abs(trade.netProfitDai);
      }
    }

    // Update daily volume
    const today = new Date().toDateString();
    const tradeDay = new Date(trade.timestamp).toDateString();
    if (today === tradeDay) {
      this.state.dailyVolume += trade.volumeDai;
    }
  }

  _updateEquityCurve(trade) {
    const lastEquity = this.equityCurve[this.equityCurve.length - 1];
    this.state.currentEquity = lastEquity + trade.netProfitDai;
    this.equityCurve.push(this.state.currentEquity);

    // Update daily PnL
    const today = new Date().toDateString();
    const existingDay = this.dailyPnL.find((d) => d.date === today);

    if (existingDay) {
      existingDay.pnl += trade.netProfitDai;
      existingDay.trades++;
    } else {
      this.dailyPnL.push({
        date: today,
        pnl: trade.netProfitDai,
        trades: 1,
      });
    }
  }

  _cleanOldTrades() {
    const cutoff = Date.now() - RISK_CONFIG.TRADE_HISTORY_DAYS * 24 * 60 * 60 * 1000;
    this.trades = this.trades.filter((t) => t.timestamp > cutoff);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Risk Checks
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check all risk limits
   */
  _checkRiskLimits() {
    const violations = [];

    // Check daily drawdown
    const dailyDrawdown = this._calculateDailyDrawdown();
    if (dailyDrawdown > RISK_CONFIG.MAX_DAILY_DRAWDOWN_PERCENT) {
      violations.push({
        type: "DAILY_DRAWDOWN",
        value: dailyDrawdown,
        limit: RISK_CONFIG.MAX_DAILY_DRAWDOWN_PERCENT,
        message: `Daily drawdown ${dailyDrawdown.toFixed(2)}% exceeds limit ${RISK_CONFIG.MAX_DAILY_DRAWDOWN_PERCENT}%`,
      });
    }

    // Check daily volume
    if (this.state.dailyVolume > RISK_CONFIG.MAX_DAILY_VOLUME_DAI) {
      violations.push({
        type: "DAILY_VOLUME",
        value: this.state.dailyVolume,
        limit: RISK_CONFIG.MAX_DAILY_VOLUME_DAI,
        message: `Daily volume ${this.state.dailyVolume.toFixed(2)} DAI exceeds limit`,
      });
    }

    // Check VaR
    const var95 = this._calculateVaR();
    if (var95 > RISK_CONFIG.MAX_VAR_PERCENT) {
      violations.push({
        type: "VAR_EXCEEDED",
        value: var95,
        limit: RISK_CONFIG.MAX_VAR_PERCENT,
        message: `VaR ${var95.toFixed(2)}% exceeds limit ${RISK_CONFIG.MAX_VAR_PERCENT}%`,
      });
    }

    // Check for anomalies
    const anomaly = this._detectAnomaly();
    if (anomaly) {
      violations.push({
        type: "ANOMALY_DETECTED",
        ...anomaly,
      });
    }

    // Handle violations
    if (violations.length > 0) {
      this._handleViolations(violations);
    }

    return violations;
  }

  _calculateDailyDrawdown() {
    const today = new Date().toDateString();
    const todayPnL = this.dailyPnL.find((d) => d.date === today);

    if (!todayPnL || todayPnL.pnl >= 0) return 0;

    // Calculate as percentage of starting equity
    const startEquity = this.equityCurve[0] || 1;
    return Math.abs(todayPnL.pnl / startEquity) * 100;
  }

  _calculateVaR() {
    const returns = this._getReturns();
    if (returns.length < 10) return 0;

    return stats.historicalVaR(returns, RISK_CONFIG.VAR_CONFIDENCE_LEVEL) * 100;
  }

  _getReturns() {
    if (this.equityCurve.length < 2) return [];

    const returns = [];
    for (let i = 1; i < this.equityCurve.length; i++) {
      const prev = this.equityCurve[i - 1] || 1;
      const curr = this.equityCurve[i];
      returns.push((curr - prev) / Math.abs(prev || 1));
    }
    return returns;
  }

  _detectAnomaly() {
    const recentTrades = this.trades.slice(-RISK_CONFIG.MIN_SAMPLES_FOR_ANOMALY);
    if (recentTrades.length < RISK_CONFIG.MIN_SAMPLES_FOR_ANOMALY) return null;

    const profits = recentTrades.map((t) => t.netProfitDai);
    const mean = stats.mean(profits);
    const stdDev = stats.stdDev(profits);

    // Check last trade for anomaly
    const lastTrade = recentTrades[recentTrades.length - 1];
    const zScore = stats.zScore(lastTrade.netProfitDai, mean, stdDev);

    if (Math.abs(zScore) > RISK_CONFIG.ANOMALY_ZSCORE_THRESHOLD) {
      return {
        type: lastTrade.netProfitDai < 0 ? "LARGE_LOSS" : "LARGE_WIN",
        zScore: zScore.toFixed(2),
        value: lastTrade.netProfitDai,
        mean: mean.toFixed(4),
        stdDev: stdDev.toFixed(4),
        message: `Anomalous trade detected: Z-score ${zScore.toFixed(2)}`,
      };
    }

    return null;
  }

  _handleViolations(violations) {
    for (const violation of violations) {
      logger.warn(`[RiskManager] VIOLATION: ${violation.message}`);

      this.alerts.push({
        timestamp: Date.now(),
        ...violation,
      });

      this.emit("violation", violation);
    }

    // Auto-pause if configured
    if (RISK_CONFIG.AUTO_PAUSE_ON_ANOMALY) {
      const shouldPause = violations.some((v) =>
        ["DAILY_DRAWDOWN", "VAR_EXCEEDED", "ANOMALY_DETECTED"].includes(v.type)
      );

      if (shouldPause && !this.state.isPaused) {
        this.pause(violations[0].message);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pre-Trade Validation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Validate a trade before execution
   */
  validateTrade(params) {
    const { volumeDai, expectedProfitDai, route } = params;
    const errors = [];

    // Check if paused
    if (this.state.isPaused) {
      errors.push(`Trading paused: ${this.state.pauseReason}`);
      return { valid: false, errors };
    }

    // Check single trade limit
    if (volumeDai > RISK_CONFIG.MAX_SINGLE_TRADE_DAI) {
      errors.push(
        `Trade volume ${volumeDai} DAI exceeds single trade limit ${RISK_CONFIG.MAX_SINGLE_TRADE_DAI} DAI`
      );
    }

    // Check daily volume limit
    if (this.state.dailyVolume + volumeDai > RISK_CONFIG.MAX_DAILY_VOLUME_DAI) {
      errors.push(
        `Trade would exceed daily volume limit of ${RISK_CONFIG.MAX_DAILY_VOLUME_DAI} DAI`
      );
    }

    // Check open positions
    if (this.state.openPositions >= RISK_CONFIG.MAX_OPEN_POSITIONS) {
      errors.push(`Maximum open positions (${RISK_CONFIG.MAX_OPEN_POSITIONS}) reached`);
    }

    // Risk-adjusted validation
    const currentDrawdown = this._calculateDailyDrawdown();
    const remainingRisk = RISK_CONFIG.MAX_DAILY_DRAWDOWN_PERCENT - currentDrawdown;

    if (remainingRisk <= 0) {
      errors.push("Daily drawdown limit already reached");
    }

    return {
      valid: errors.length === 0,
      errors,
      riskMetrics: {
        currentDrawdown,
        remainingRisk,
        dailyVolume: this.state.dailyVolume,
        openPositions: this.state.openPositions,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pause/Resume
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Pause trading
   */
  pause(reason) {
    if (this.state.isPaused) return;

    this.state.isPaused = true;
    this.state.pauseReason = reason;
    this.state.pausedAt = Date.now();

    logger.warn(`[RiskManager] Trading PAUSED: ${reason}`);
    this.emit("paused", { reason, timestamp: Date.now() });
  }

  /**
   * Resume trading
   */
  resume() {
    if (!this.state.isPaused) return;

    // Check cooldown
    const elapsed = Date.now() - this.state.pausedAt;
    const cooldownMs = RISK_CONFIG.PAUSE_COOLDOWN_MINUTES * 60 * 1000;

    if (elapsed < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
      logger.warn(`[RiskManager] Cannot resume: ${remaining} minutes cooldown remaining`);
      return false;
    }

    this.state.isPaused = false;
    this.state.pauseReason = null;
    this.state.pausedAt = null;

    logger.info("[RiskManager] Trading RESUMED");
    this.emit("resumed", { timestamp: Date.now() });
    return true;
  }

  /**
   * Force resume (bypass cooldown)
   */
  forceResume() {
    this.state.isPaused = false;
    this.state.pauseReason = null;
    this.state.pausedAt = null;

    logger.info("[RiskManager] Trading FORCE RESUMED");
    this.emit("resumed", { timestamp: Date.now(), forced: true });
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Performance Metrics
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get comprehensive performance report
   */
  getPerformanceReport() {
    const returns = this._getReturns();
    const profits = this.trades.map((t) => t.netProfitDai);

    return {
      // Basic stats
      totalTrades: this.metrics.totalTrades,
      winningTrades: this.metrics.winningTrades,
      losingTrades: this.metrics.losingTrades,
      winRate:
        this.metrics.totalTrades > 0
          ? ((this.metrics.winningTrades / this.metrics.totalTrades) * 100).toFixed(2) + "%"
          : "N/A",

      // PnL
      totalProfit: this.metrics.totalProfit.toFixed(4),
      totalLoss: this.metrics.totalLoss.toFixed(4),
      netPnL: (this.metrics.totalProfit - this.metrics.totalLoss).toFixed(4),
      largestWin: this.metrics.largestWin.toFixed(4),
      largestLoss: this.metrics.largestLoss.toFixed(4),

      // Risk metrics
      sharpeRatio: stats.sharpeRatio(returns).toFixed(4),
      maxDrawdown: (stats.maxDrawdown(this.equityCurve) * 100).toFixed(2) + "%",
      var95: this._calculateVaR().toFixed(2) + "%",
      currentDrawdown: this._calculateDailyDrawdown().toFixed(2) + "%",

      // Statistical
      avgProfit: profits.length > 0 ? stats.mean(profits).toFixed(4) : "N/A",
      stdDevProfit: profits.length > 1 ? stats.stdDev(profits).toFixed(4) : "N/A",
      profitFactor:
        this.metrics.totalLoss > 0
          ? (this.metrics.totalProfit / this.metrics.totalLoss).toFixed(4)
          : "Infinity",

      // State
      isPaused: this.state.isPaused,
      pauseReason: this.state.pauseReason,
      dailyVolume: this.state.dailyVolume.toFixed(2),
      currentEquity: this.state.currentEquity.toFixed(4),
    };
  }

  /**
   * Reset daily counters (call at start of day)
   */
  resetDaily() {
    this.state.dailyVolume = 0;
    logger.info("[RiskManager] Daily counters reset");
  }

  /**
   * Get recent alerts
   */
  getAlerts(limit = 50) {
    return this.alerts.slice(-limit);
  }

  /**
   * Clear alerts
   */
  clearAlerts() {
    this.alerts = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ─────────────────────────────────────────────────────────────────────────────

const riskManager = new RiskManager();

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Classes
  RiskManager,

  // Singleton
  riskManager,

  // Statistical utilities
  stats,

  // Convenience methods
  recordTrade: (trade) => riskManager.recordTrade(trade),
  validateTrade: (params) => riskManager.validateTrade(params),
  getPerformanceReport: () => riskManager.getPerformanceReport(),
  pause: (reason) => riskManager.pause(reason),
  resume: () => riskManager.resume(),
  forceResume: () => riskManager.forceResume(),
  getAlerts: (limit) => riskManager.getAlerts(limit),

  // Config
  RISK_CONFIG,
};
