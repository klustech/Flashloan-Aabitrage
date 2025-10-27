const promClient = require("prom-client");

const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

const reserveIngestionFailures = new promClient.Counter({
  name: "reserve_ingestion_failures_total",
  help: "Number of failures encountered while maintaining reserve ingestion",
  labelNames: ["type"],
  registers: [register],
});

const reserveIngestionReconnects = new promClient.Counter({
  name: "reserve_ingestion_reconnects_total",
  help: "Total number of reserve ingestion provider reconnect events",
  labelNames: ["provider_type"],
  registers: [register],
});

const reserveIngestionConnectionState = new promClient.Gauge({
  name: "reserve_ingestion_connection_state",
  help: "Connection state of the reserve ingestion provider (0=offline, 1=online)",
  labelNames: ["provider_type"],
  registers: [register],
});

const reserveIngestionEnabled = new promClient.Gauge({
  name: "reserve_ingestion_enabled",
  help: "Flag indicating whether live reserve ingestion is enabled (1) or disabled (0)",
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
  buckets: [0.1, 0.5, 1, 2, 5],
  registers: [register],
});

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

module.exports = {
  register,
  arbAttempts,
  arbSuccess,
  arbFailure,
  avgLatency,
  avgProfit,
  simulationHistogram,
  rlEpsilon,
  rlAction,
  reserveIngestionFailures,
  reserveIngestionReconnects,
  reserveIngestionConnectionState,
  reserveIngestionEnabled,
  dbEnabled,
  dbInsertFailures,
};
