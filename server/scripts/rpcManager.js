/**
 * server/scripts/rpcManager.js
 *
 * Multi-RPC endpoint management with automatic failover,
 * latency monitoring, and health checking.
 */

const { ethers } = require("ethers");
const winston = require("winston");

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

const CONFIG = {
  // Health check interval (ms)
  HEALTH_CHECK_INTERVAL: parseInt(process.env.RPC_HEALTH_CHECK_INTERVAL || "30000", 10),

  // Maximum latency before marking unhealthy (ms)
  MAX_HEALTHY_LATENCY: parseInt(process.env.RPC_MAX_LATENCY || "2000", 10),

  // Number of failures before failover
  FAILURE_THRESHOLD: parseInt(process.env.RPC_FAILURE_THRESHOLD || "3", 10),

  // Cooldown before retrying failed endpoint (ms)
  FAILURE_COOLDOWN: parseInt(process.env.RPC_FAILURE_COOLDOWN || "60000", 10),

  // Request timeout (ms)
  REQUEST_TIMEOUT: parseInt(process.env.RPC_TIMEOUT || "10000", 10),

  // Latency history size
  LATENCY_HISTORY_SIZE: 100,
};

// ─────────────────────────────────────────────────────────────────────────────
// RPC Endpoint Class
// ─────────────────────────────────────────────────────────────────────────────

class RPCEndpoint {
  constructor(url, options = {}) {
    this.url = url;
    this.name = options.name || this._extractName(url);
    this.priority = options.priority || 1;
    this.type = options.type || "http"; // http or ws
    this.chainId = options.chainId || 1;

    // Provider instance
    this.provider = null;

    // Health metrics
    this.healthy = true;
    this.consecutiveFailures = 0;
    this.lastFailure = null;
    this.lastSuccess = null;
    this.latencyHistory = [];
    this.avgLatency = 0;

    // Stats
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalLatency: 0,
    };
  }

  _extractName(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.split(".").slice(-2, -1)[0] || "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * Initialize the provider
   */
  async initialize() {
    try {
      if (this.type === "ws") {
        this.provider = new ethers.providers.WebSocketProvider(this.url);
      } else {
        this.provider = new ethers.providers.JsonRpcProvider({
          url: this.url,
          timeout: CONFIG.REQUEST_TIMEOUT,
        });
      }

      // Test connection
      await this.healthCheck();
      logger.info(`[RPCManager] Initialized endpoint: ${this.name} (${this.url.slice(0, 30)}...)`);
      return true;
    } catch (error) {
      logger.error(`[RPCManager] Failed to initialize ${this.name}: ${error.message}`);
      this.healthy = false;
      return false;
    }
  }

  /**
   * Perform a health check
   */
  async healthCheck() {
    const start = Date.now();

    try {
      // Simple call to check connectivity
      const blockNumber = await Promise.race([
        this.provider.getBlockNumber(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), CONFIG.REQUEST_TIMEOUT)
        ),
      ]);

      const latency = Date.now() - start;
      this._recordLatency(latency);
      this._recordSuccess();

      // Check if latency is acceptable
      if (latency > CONFIG.MAX_HEALTHY_LATENCY) {
        logger.warn(`[RPCManager] ${this.name} high latency: ${latency}ms`);
      }

      return {
        healthy: true,
        latency,
        blockNumber,
      };
    } catch (error) {
      const latency = Date.now() - start;
      this._recordFailure(error.message);

      return {
        healthy: false,
        latency,
        error: error.message,
      };
    }
  }

  /**
   * Execute a request with latency tracking
   */
  async execute(method, ...args) {
    const start = Date.now();
    this.stats.totalRequests++;

    try {
      const result = await Promise.race([
        this.provider[method](...args),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Request timeout")), CONFIG.REQUEST_TIMEOUT)
        ),
      ]);

      const latency = Date.now() - start;
      this._recordLatency(latency);
      this._recordSuccess();

      return { success: true, result, latency };
    } catch (error) {
      const latency = Date.now() - start;
      this._recordFailure(error.message);

      return { success: false, error: error.message, latency };
    }
  }

  _recordLatency(latency) {
    this.latencyHistory.push(latency);
    if (this.latencyHistory.length > CONFIG.LATENCY_HISTORY_SIZE) {
      this.latencyHistory.shift();
    }

    // Update running average
    this.stats.totalLatency += latency;
    this.avgLatency =
      this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length;
  }

  _recordSuccess() {
    this.consecutiveFailures = 0;
    this.lastSuccess = Date.now();
    this.healthy = true;
    this.stats.successfulRequests++;
  }

  _recordFailure(reason) {
    this.consecutiveFailures++;
    this.lastFailure = { time: Date.now(), reason };
    this.stats.failedRequests++;

    if (this.consecutiveFailures >= CONFIG.FAILURE_THRESHOLD) {
      this.healthy = false;
      logger.warn(`[RPCManager] ${this.name} marked unhealthy after ${this.consecutiveFailures} failures`);
    }
  }

  /**
   * Check if endpoint should be retried after cooldown
   */
  shouldRetry() {
    if (this.healthy) return false;
    if (!this.lastFailure) return true;

    return Date.now() - this.lastFailure.time > CONFIG.FAILURE_COOLDOWN;
  }

  /**
   * Get endpoint stats
   */
  getStats() {
    return {
      name: this.name,
      url: this.url.slice(0, 40) + "...",
      type: this.type,
      priority: this.priority,
      healthy: this.healthy,
      avgLatency: Math.round(this.avgLatency),
      consecutiveFailures: this.consecutiveFailures,
      lastSuccess: this.lastSuccess ? new Date(this.lastSuccess).toISOString() : null,
      lastFailure: this.lastFailure,
      ...this.stats,
      successRate:
        this.stats.totalRequests > 0
          ? ((this.stats.successfulRequests / this.stats.totalRequests) * 100).toFixed(2) + "%"
          : "N/A",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RPC Manager Class
// ─────────────────────────────────────────────────────────────────────────────

class RPCManager {
  constructor() {
    this.endpoints = [];
    this.primaryIndex = 0;
    this.healthCheckInterval = null;
    this.isRunning = false;

    // Global stats
    this.stats = {
      totalFailovers: 0,
      lastFailover: null,
    };
  }

  /**
   * Add an RPC endpoint
   */
  addEndpoint(url, options = {}) {
    const endpoint = new RPCEndpoint(url, options);
    this.endpoints.push(endpoint);
    this.endpoints.sort((a, b) => a.priority - b.priority);
    return endpoint;
  }

  /**
   * Initialize from environment variables
   */
  async initializeFromEnv() {
    const rpcUrls = [];

    // Primary RPC
    if (process.env.MAINNET_RPC_URL) {
      rpcUrls.push({ url: process.env.MAINNET_RPC_URL, priority: 1, type: "http" });
    }

    // WebSocket
    if (process.env.MAINNET_WEBSOCKET) {
      rpcUrls.push({ url: process.env.MAINNET_WEBSOCKET, priority: 2, type: "ws" });
    }

    // Backup RPCs
    if (process.env.BACKUP_RPC_URL) {
      rpcUrls.push({ url: process.env.BACKUP_RPC_URL, priority: 3, type: "http" });
    }

    if (process.env.BACKUP_RPC_URL_2) {
      rpcUrls.push({ url: process.env.BACKUP_RPC_URL_2, priority: 4, type: "http" });
    }

    // Infura fallback
    if (process.env.INFURA_API_KEY) {
      rpcUrls.push({
        url: `https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
        priority: 5,
        type: "http",
        name: "infura",
      });
    }

    // Alchemy fallback
    if (process.env.ALCHEMY_API_KEY) {
      rpcUrls.push({
        url: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
        priority: 6,
        type: "http",
        name: "alchemy",
      });
    }

    // Initialize all endpoints
    for (const rpc of rpcUrls) {
      const endpoint = this.addEndpoint(rpc.url, rpc);
      await endpoint.initialize();
    }

    logger.info(`[RPCManager] Initialized ${this.endpoints.length} RPC endpoints`);
    return this.endpoints.length;
  }

  /**
   * Start health monitoring
   */
  startHealthMonitoring() {
    if (this.isRunning) return;

    this.healthCheckInterval = setInterval(async () => {
      await this._performHealthChecks();
    }, CONFIG.HEALTH_CHECK_INTERVAL);

    this.isRunning = true;
    logger.info("[RPCManager] Health monitoring started");
  }

  /**
   * Stop health monitoring
   */
  stopHealthMonitoring() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.isRunning = false;
  }

  /**
   * Perform health checks on all endpoints
   */
  async _performHealthChecks() {
    const results = await Promise.allSettled(
      this.endpoints.map(async (endpoint) => {
        // Check cooldown for unhealthy endpoints
        if (!endpoint.healthy && endpoint.shouldRetry()) {
          logger.info(`[RPCManager] Retrying ${endpoint.name} after cooldown`);
        }

        return endpoint.healthCheck();
      })
    );

    // Log summary
    const healthy = this.endpoints.filter((e) => e.healthy).length;
    const total = this.endpoints.length;

    if (healthy < total) {
      logger.warn(`[RPCManager] Health check: ${healthy}/${total} endpoints healthy`);
    }

    // Update primary if needed
    this._updatePrimary();
  }

  /**
   * Update primary endpoint based on health and latency
   */
  _updatePrimary() {
    const healthyEndpoints = this.endpoints.filter((e) => e.healthy);

    if (healthyEndpoints.length === 0) {
      logger.error("[RPCManager] No healthy endpoints available!");
      return;
    }

    // Sort by priority and latency
    healthyEndpoints.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.avgLatency - b.avgLatency;
    });

    const newPrimaryIndex = this.endpoints.indexOf(healthyEndpoints[0]);

    if (newPrimaryIndex !== this.primaryIndex) {
      const oldPrimary = this.endpoints[this.primaryIndex];
      const newPrimary = this.endpoints[newPrimaryIndex];

      logger.info(
        `[RPCManager] Failover: ${oldPrimary?.name || "none"} -> ${newPrimary.name} ` +
        `(latency: ${newPrimary.avgLatency}ms)`
      );

      this.primaryIndex = newPrimaryIndex;
      this.stats.totalFailovers++;
      this.stats.lastFailover = Date.now();
    }
  }

  /**
   * Get the primary (best) provider
   */
  getPrimaryProvider() {
    const endpoint = this.endpoints[this.primaryIndex];
    return endpoint?.provider || null;
  }

  /**
   * Execute a request with automatic failover
   */
  async executeWithFailover(method, ...args) {
    // Try primary first
    const primary = this.endpoints[this.primaryIndex];
    if (primary?.healthy) {
      const result = await primary.execute(method, ...args);
      if (result.success) {
        return result;
      }
    }

    // Failover to other healthy endpoints
    for (let i = 0; i < this.endpoints.length; i++) {
      if (i === this.primaryIndex) continue;

      const endpoint = this.endpoints[i];
      if (!endpoint.healthy) continue;

      logger.info(`[RPCManager] Failing over to ${endpoint.name} for ${method}`);
      const result = await endpoint.execute(method, ...args);

      if (result.success) {
        // Update primary if this one is better
        this._updatePrimary();
        return result;
      }
    }

    // All endpoints failed
    throw new Error(`All RPC endpoints failed for ${method}`);
  }

  /**
   * Execute on all endpoints (for redundancy)
   */
  async executeOnAll(method, ...args) {
    const results = await Promise.allSettled(
      this.endpoints
        .filter((e) => e.healthy)
        .map((e) => e.execute(method, ...args))
    );

    return results.map((r, i) => ({
      endpoint: this.endpoints[i].name,
      ...r.value,
    }));
  }

  /**
   * Get fastest endpoint for time-critical operations
   */
  getFastestEndpoint() {
    const healthy = this.endpoints.filter((e) => e.healthy);
    if (healthy.length === 0) return null;

    healthy.sort((a, b) => a.avgLatency - b.avgLatency);
    return healthy[0];
  }

  /**
   * Get manager stats
   */
  getStats() {
    return {
      endpoints: this.endpoints.map((e) => e.getStats()),
      primary: this.endpoints[this.primaryIndex]?.name || "none",
      healthyCount: this.endpoints.filter((e) => e.healthy).length,
      totalEndpoints: this.endpoints.length,
      ...this.stats,
    };
  }

  /**
   * Get latency percentiles
   */
  getLatencyPercentiles() {
    const allLatencies = this.endpoints
      .flatMap((e) => e.latencyHistory)
      .sort((a, b) => a - b);

    if (allLatencies.length === 0) {
      return { p50: 0, p90: 0, p99: 0 };
    }

    return {
      p50: allLatencies[Math.floor(allLatencies.length * 0.5)],
      p90: allLatencies[Math.floor(allLatencies.length * 0.9)],
      p99: allLatencies[Math.floor(allLatencies.length * 0.99)],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ─────────────────────────────────────────────────────────────────────────────

const rpcManager = new RPCManager();

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Classes
  RPCManager,
  RPCEndpoint,

  // Singleton instance
  rpcManager,

  // Convenience methods
  initializeFromEnv: () => rpcManager.initializeFromEnv(),
  getPrimaryProvider: () => rpcManager.getPrimaryProvider(),
  executeWithFailover: (method, ...args) => rpcManager.executeWithFailover(method, ...args),
  getStats: () => rpcManager.getStats(),
  startHealthMonitoring: () => rpcManager.startHealthMonitoring(),
  stopHealthMonitoring: () => rpcManager.stopHealthMonitoring(),

  // Config
  CONFIG,
};
