let client;
let register;
let CounterCtor;
let GaugeCtor;
let HistogramCtor;
let isRealClient = false;

try {
  client = require("prom-client");
  register = new client.Registry();
  isRealClient = true;
  CounterCtor = client.Counter;
  GaugeCtor = client.Gauge;
  HistogramCtor = client.Histogram;
} catch (err) {
  // Fallback stub if prom-client is unavailable
  class NoopCounter {
    constructor() {}
    inc() {}
    labels() {
      return this;
    }
  }

  class NoopGauge {
    constructor() {}
    set() {}
    inc() {}
    dec() {}
  }

  class NoopHistogram {
    constructor() {}
    observe() {}
  }

  CounterCtor = NoopCounter;
  GaugeCtor = NoopGauge;
  HistogramCtor = NoopHistogram;

  register = {
    async metrics() {
      return "";
    },
    async getMetricsAsJSON() {
      return [];
    },
    contentType: "text/plain",
  };

  client = {
    collectDefaultMetrics: () => {},
    Counter: CounterCtor,
    Gauge: GaugeCtor,
    Histogram: HistogramCtor,
  };
}

const createCounter = (config) =>
  new CounterCtor(
    isRealClient ? { ...config, registers: [register] } : config
  );

const createGauge = (config) =>
  new GaugeCtor(isRealClient ? { ...config, registers: [register] } : config);

const createHistogram = (config) =>
  new HistogramCtor(
    isRealClient ? { ...config, registers: [register] } : config
  );

client.collectDefaultMetrics(
  isRealClient ? { register } : undefined
);

const arbAttempts = createCounter({
  name: "arb_attempts_total",
  help: "Total number of arbitrage attempts",
});

const arbSuccess = createCounter({
  name: "arb_success_total",
  help: "Total number of successful arbitrage trades",
});

const arbFailure = createCounter({
  name: "arb_failure_total",
  help: "Total number of failed arbitrage trades",
  labelNames: ["reason"],
});

const avgLatency = createGauge({
  name: "avg_latency_ms",
  help: "Average latency in route simulation",
});

const avgProfit = createGauge({
  name: "avg_profit_dai",
  help: "Average profit in DAI",
});

const simulationHistogram = createHistogram({
  name: "simulation_time_seconds",
  help: "Time taken to simulate a route",
  buckets: [0.1, 0.5, 1, 2, 5],
});

const rlEpsilon = createGauge({
  name: "rl_epsilon",
  help: "Current epsilon for slippage RL agent",
});

const rlAction = createGauge({
  name: "rl_last_action",
  help: "Last slippage action selected by RL agent",
});

module.exports = {
  client,
  register,
  arbAttempts,
  arbSuccess,
  arbFailure,
  avgLatency,
  avgProfit,
  simulationHistogram,
  rlEpsilon,
  rlAction,
};
