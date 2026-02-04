/**
 * Enhanced Prometheus Metrics Registry
 * Comprehensive metrics for arbitrage bot monitoring
 */

const promClient = require("prom-client");

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// ─── Database Metrics ───────────────────────────────────────────────────────

const dbEnabled = new promClient.Gauge({
  name: "db_enabled",
  help: "Flag indicating if PostgreSQL persistence is enabled (1) or disabled (0)",
  registers: [register],
});

const dbInsertFailures = new promClient.Counter({
  name: "db_insert_failures_total",
  help: "Number of trade inserts skipped or failed because the database was unavailable",
  registers: [register],
});

// ─── Arbitrage Execution Metrics ────────────────────────────────────────────

const arbAttempts = new promClient.Counter({
  name: "arb_attempts_total",
  help: "Total number of arbitrage attempts",
  registers: [register],
});

const arbSuccess = new promClient.Counter({
  name: "arb_success_total",
  help: "Total number of successful arbitrage trades",
  registers: [register],
});

const arbFailure = new promClient.Counter({
  name: "arb_failure_total",
  help: "Total number of failed arbitrage trades",
  labelNames: ["reason"],
  registers: [register],
});

const arbProfit = new promClient.Counter({
  name: "arb_profit_dai_total",
  help: "Cumulative profit in DAI from successful trades",
  registers: [register],
});

const arbLoss = new promClient.Counter({
  name: "arb_loss_dai_total",
  help: "Cumulative losses in DAI from failed trades",
  registers: [register],
});

// ─── Performance Metrics ────────────────────────────────────────────────────

const avgLatency = new promClient.Gauge({
  name: "avg_latency_ms",
  help: "Average latency in route simulation",
  registers: [register],
});

const avgProfit = new promClient.Gauge({
  name: "avg_profit_dai",
  help: "Average profit in DAI",
  registers: [register],
});

const simulationHistogram = new promClient.Histogram({
  name: "simulation_time_seconds",
  help: "Time taken to simulate a route",
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

const executionDuration = new promClient.Histogram({
  name: "arb_execution_duration_seconds",
  help: "Time from opportunity detection to trade completion",
  buckets: [1, 2, 5, 10, 30, 60, 120],
  registers: [register],
});

// ─── Route Discovery Metrics ────────────────────────────────────────────────

const routesDiscovered = new promClient.Gauge({
  name: "routes_discovered_total",
  help: "Number of arbitrage routes discovered in last scan",
  registers: [register],
});

const profitableRoutes = new promClient.Gauge({
  name: "routes_profitable_total",
  help: "Number of profitable routes in last scan",
  registers: [register],
});

const routesByDex = new promClient.Gauge({
  name: "routes_by_dex",
  help: "Number of routes discovered per DEX",
  labelNames: ["dex"],
  registers: [register],
});

// ─── Cycle Detection Metrics ────────────────────────────────────────────────

const cycleDetectionMode = new promClient.Gauge({
  name: "cycle_detection_mode",
  help: "Current cycle detection mode (1=Bellman-Ford, 0=DFS triangular)",
  registers: [register],
});

const negativeCyclesFound = new promClient.Gauge({
  name: "negative_cycles_found",
  help: "Number of negative cycles found by Bellman-Ford in last scan",
  registers: [register],
});

const cycleDetectionDuration = new promClient.Histogram({
  name: "cycle_detection_duration_ms",
  help: "Duration of cycle detection algorithm in milliseconds",
  labelNames: ["algorithm"],
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [register],
});

const poolsAnalyzed = new promClient.Gauge({
  name: "pools_analyzed_total",
  help: "Number of pools analyzed for route discovery",
  registers: [register],
});

const graphEdges = new promClient.Gauge({
  name: "graph_edges_total",
  help: "Number of edges in the route discovery graph",
  registers: [register],
});

// ─── Gas and Cost Metrics ───────────────────────────────────────────────────

const gasPrice = new promClient.Gauge({
  name: "gas_price_gwei",
  help: "Current gas price in Gwei",
  registers: [register],
});

const gasCostDai = new promClient.Gauge({
  name: "gas_cost_dai",
  help: "Estimated gas cost in DAI for typical trade",
  registers: [register],
});

const gasUsedHistogram = new promClient.Histogram({
  name: "gas_used_histogram",
  help: "Gas used per trade",
  buckets: [100000, 200000, 300000, 500000, 750000, 1000000, 1500000],
  registers: [register],
});

// ─── Slippage Metrics ───────────────────────────────────────────────────────

const slippageActual = new promClient.Histogram({
  name: "slippage_actual_bps",
  help: "Actual slippage experienced in basis points",
  buckets: [10, 25, 50, 100, 200, 500, 1000],
  registers: [register],
});

const slippageConfig = new promClient.Gauge({
  name: "slippage_config_bps",
  help: "Configured slippage tolerance in basis points",
  registers: [register],
});

// ─── ML Scoring Metrics ─────────────────────────────────────────────────────

const mlScoreHistogram = new promClient.Histogram({
  name: "ml_prediction_score",
  help: "ML model prediction scores distribution",
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [register],
});

const mlServiceLatency = new promClient.Histogram({
  name: "ml_service_latency_ms",
  help: "Latency of ML scoring service calls",
  buckets: [10, 25, 50, 100, 250, 500, 1000],
  registers: [register],
});

const mlServiceErrors = new promClient.Counter({
  name: "ml_service_errors_total",
  help: "Number of ML service errors",
  registers: [register],
});

const mlServiceAvailable = new promClient.Gauge({
  name: "ml_service_available",
  help: "ML service availability (1=up, 0=down)",
  registers: [register],
});

// ─── RL Agent Metrics ───────────────────────────────────────────────────────

const rlEpsilon = new promClient.Gauge({
  name: "rl_epsilon",
  help: "Current epsilon for slippage RL agent",
  registers: [register],
});

const rlAction = new promClient.Gauge({
  name: "rl_last_action",
  help: "Last slippage action selected by RL agent",
  registers: [register],
});

const rlReward = new promClient.Gauge({
  name: "rl_last_reward",
  help: "Last reward received by RL agent",
  registers: [register],
});

// ─── Flashbots Metrics ──────────────────────────────────────────────────────

const flashbotsSubmissions = new promClient.Counter({
  name: "flashbots_submissions_total",
  help: "Number of Flashbots bundle submissions",
  registers: [register],
});

const flashbotsInclusions = new promClient.Counter({
  name: "flashbots_inclusions_total",
  help: "Number of successful Flashbots bundle inclusions",
  registers: [register],
});

const flashbotsRetries = new promClient.Counter({
  name: "flashbots_retries_total",
  help: "Number of Flashbots retry attempts",
  registers: [register],
});

// ─── Circuit Breaker Metrics ────────────────────────────────────────────────

const circuitBreakerTriggered = new promClient.Counter({
  name: "circuit_breaker_triggered_total",
  help: "Number of times circuit breaker was triggered",
  registers: [register],
});

const consecutiveFailures = new promClient.Gauge({
  name: "consecutive_failures",
  help: "Current count of consecutive negative PnL cycles",
  registers: [register],
});

const botActive = new promClient.Gauge({
  name: "bot_active",
  help: "Bot active status (1=active, 0=paused)",
  registers: [register],
});

// ─── Redis Metrics ──────────────────────────────────────────────────────────

const redisAvailable = new promClient.Gauge({
  name: "redis_available",
  help: "Redis availability (1=connected, 0=disconnected)",
  registers: [register],
});

const redisIsLeader = new promClient.Gauge({
  name: "redis_is_leader",
  help: "This instance is the leader (1=yes, 0=no)",
  registers: [register],
});

// ─── Pool/Liquidity Metrics ─────────────────────────────────────────────────

const poolsMonitored = new promClient.Gauge({
  name: "pools_monitored_total",
  help: "Number of liquidity pools being monitored",
  registers: [register],
});

const poolUpdatesPerMinute = new promClient.Gauge({
  name: "pool_updates_per_minute",
  help: "Rate of pool reserve updates per minute",
  registers: [register],
});

// ─── Daily Statistics ───────────────────────────────────────────────────────

const dailyPnL = new promClient.Gauge({
  name: "daily_pnl_dai",
  help: "Today's profit/loss in DAI",
  registers: [register],
});

const dailyTradeCount = new promClient.Gauge({
  name: "daily_trade_count",
  help: "Number of trades executed today",
  registers: [register],
});

const dailyGasSpent = new promClient.Gauge({
  name: "daily_gas_spent_eth",
  help: "Total gas spent today in ETH",
  registers: [register],
});

// ─── Health Check Metrics ───────────────────────────────────────────────────

const lastSuccessfulArb = new promClient.Gauge({
  name: "last_successful_arb_timestamp",
  help: "Unix timestamp of last successful arbitrage",
  registers: [register],
});

const lastArbAttempt = new promClient.Gauge({
  name: "last_arb_attempt_timestamp",
  help: "Unix timestamp of last arbitrage attempt",
  registers: [register],
});

const healthCheckStatus = new promClient.Gauge({
  name: "health_check_status",
  help: "Overall health check status (1=healthy, 0=unhealthy)",
  registers: [register],
});

module.exports = {
  register,

  // Database
  dbEnabled,
  dbInsertFailures,

  // Arbitrage execution
  arbAttempts,
  arbSuccess,
  arbFailure,
  arbProfit,
  arbLoss,

  // Performance
  avgLatency,
  avgProfit,
  simulationHistogram,
  executionDuration,

  // Route discovery
  routesDiscovered,
  profitableRoutes,
  routesByDex,

  // Cycle detection
  cycleDetectionMode,
  negativeCyclesFound,
  cycleDetectionDuration,
  poolsAnalyzed,
  graphEdges,

  // Gas and costs
  gasPrice,
  gasCostDai,
  gasUsedHistogram,

  // Slippage
  slippageActual,
  slippageConfig,

  // ML scoring
  mlScoreHistogram,
  mlServiceLatency,
  mlServiceErrors,
  mlServiceAvailable,

  // RL agent
  rlEpsilon,
  rlAction,
  rlReward,

  // Flashbots
  flashbotsSubmissions,
  flashbotsInclusions,
  flashbotsRetries,

  // Circuit breaker
  circuitBreakerTriggered,
  consecutiveFailures,
  botActive,

  // Redis
  redisAvailable,
  redisIsLeader,

  // Pools
  poolsMonitored,
  poolUpdatesPerMinute,

  // Daily stats
  dailyPnL,
  dailyTradeCount,
  dailyGasSpent,

  // Health
  lastSuccessfulArb,
  lastArbAttempt,
  healthCheckStatus,
};
