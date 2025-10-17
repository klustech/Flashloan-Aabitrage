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
  const stubRegister = {
    contentType: "text/plain",
    _metrics: [],
    addMetric(metric) {
      this._metrics.push(metric);
    },
    async metrics() {
      if (!this._metrics.length) {
        return "";
      }

      return this._metrics
        .map((metric) => metric.toPrometheus())
        .filter(Boolean)
        .join("\n\n");
    },
    async getMetricsAsJSON() {
      return this._metrics.map((metric) => metric.toJSON());
    },
  };

  class StubMetric {
    constructor(config = {}, type) {
      this.name = config.name || "unnamed_metric";
      this.help = config.help || "";
      this.type = type;
      this.labelNames = Array.isArray(config.labelNames)
        ? config.labelNames
        : [];
      this.entries = new Map();
      stubRegister.addMetric(this);

      if (this.labelNames.length === 0) {
        this._getEntry({});
      }
    }

    _normalizeLabels(labels = {}) {
      const normalized = {};

      this.labelNames.forEach((label) => {
        normalized[label] = Object.prototype.hasOwnProperty.call(labels, label)
          ? labels[label]
          : "";
      });

      Object.keys(labels || {}).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(normalized, key)) {
          normalized[key] = labels[key];
        }
      });

      return normalized;
    }

    _getEntry(labels = {}, initializer) {
      const normalized = this._normalizeLabels(labels);
      const key = JSON.stringify(normalized);

      if (!this.entries.has(key)) {
        const entry = initializer
          ? initializer(normalized)
          : { labels: normalized, value: 0 };

        if (typeof entry.value !== "number") {
          entry.value = 0;
        }

        this.entries.set(key, entry);
      }

      return this.entries.get(key);
    }

    _labelsFromArgs(args) {
      if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
        return this._normalizeLabels(args[0]);
      }

      const labels = {};
      this.labelNames.forEach((label, idx) => {
        labels[label] = args[idx];
      });

      return this._normalizeLabels(labels);
    }

    labels(...args) {
      const labels = this._labelsFromArgs(args);

      return {
        inc: (value) => {
          if (typeof this.inc === "function") {
            this.inc(labels, value);
          }
          return this;
        },
        dec: (value) => {
          if (typeof this.dec === "function") {
            this.dec(labels, value);
          }
          return this;
        },
        set: (value) => {
          if (typeof this.set === "function") {
            this.set(labels, value);
          }
          return this;
        },
        observe: (value) => {
          if (typeof this.observe === "function") {
            this.observe(labels, value);
          }
          return this;
        },
      };
    }

    _escapeLabelValue(value) {
      return String(value).replace(/"/g, '\\"');
    }

    _formatLabels(labels) {
      const pairs = Object.entries(labels || {}).filter(
        ([, value]) => value !== undefined && value !== ""
      );

      if (!pairs.length) {
        return "";
      }

      const labelString = pairs
        .map(([key, value]) => `${key}="${this._escapeLabelValue(value)}"`)
        .join(",");

      return `{${labelString}}`;
    }

    toJSON() {
      return {
        name: this.name,
        help: this.help,
        type: this.type,
        values: Array.from(this.entries.values()).map((entry) => ({
          labels: entry.labels,
          value: entry.value.toString(),
        })),
        aggregator: "sum",
      };
    }

    toPrometheus() {
      const header = [
        `# HELP ${this.name} ${this.help}`.trim(),
        `# TYPE ${this.name} ${this.type}`,
      ];

      const lines = Array.from(this.entries.values()).map(
        (entry) => `${this.name}${this._formatLabels(entry.labels)} ${entry.value}`
      );

      return [...header, ...lines].join("\n");
    }
  }

  class StubCounter extends StubMetric {
    constructor(config = {}) {
      super(config, "counter");
    }

    inc(arg1, arg2) {
      let labels = {};
      let value = arg1;

      if (typeof arg1 === "object" && arg1 !== null) {
        labels = arg1;
        value = arg2;
      }

      const numeric = Number(value ?? 1);

      if (!Number.isFinite(numeric)) {
        return;
      }

      const entry = this._getEntry(labels);
      entry.value += numeric;
    }
  }

  class StubGauge extends StubMetric {
    constructor(config = {}) {
      super(config, "gauge");
    }

    set(arg1, arg2) {
      let labels = {};
      let value = arg1;

      if (typeof arg1 === "object" && arg1 !== null) {
        labels = arg1;
        value = arg2;
      }

      const numeric = Number(value ?? 0);

      if (!Number.isFinite(numeric)) {
        return;
      }

      const entry = this._getEntry(labels);
      entry.value = numeric;
    }

    _change(arg1, arg2, direction) {
      let labels = {};
      let value = arg1;

      if (typeof arg1 === "object" && arg1 !== null) {
        labels = arg1;
        value = arg2;
      }

      const numeric = Number(value ?? 1);

      if (!Number.isFinite(numeric)) {
        return;
      }

      const entry = this._getEntry(labels);
      entry.value += numeric * direction;
    }

    inc(arg1, arg2) {
      this._change(arg1, arg2, 1);
    }

    dec(arg1, arg2) {
      this._change(arg1, arg2, -1);
    }
  }

  class StubHistogram extends StubMetric {
    constructor(config = {}) {
      super(config, "histogram");
      this.buckets = Array.isArray(config.buckets)
        ? [...config.buckets].sort((a, b) => a - b)
        : [];
    }

    _getEntry(labels = {}) {
      return super._getEntry(labels, (normalized) => ({
        labels: normalized,
        bucketCounts: this.buckets.map(() => 0),
        count: 0,
        sum: 0,
        value: 0,
      }));
    }

    observe(arg1, arg2) {
      let labels = {};
      let value = arg1;

      if (typeof arg1 === "object" && arg1 !== null) {
        labels = arg1;
        value = arg2;
      }

      const numeric = Number(value);

      if (!Number.isFinite(numeric)) {
        return;
      }

      const entry = this._getEntry(labels);
      entry.count += 1;
      entry.sum += numeric;
      entry.value = entry.count;

      this.buckets.forEach((bucket, idx) => {
        if (numeric <= bucket) {
          entry.bucketCounts[idx] += 1;
        }
      });
    }

    toJSON() {
      const entries = Array.from(this.entries.values());
      const values = [];
      let totalSum = 0;
      let totalCount = 0;

      entries.forEach((entry) => {
        let cumulative = 0;
        this.buckets.forEach((bucket, idx) => {
          cumulative += entry.bucketCounts[idx];
          values.push({
            labels: { ...entry.labels, le: String(bucket) },
            value: cumulative.toString(),
          });
        });

        values.push({
          labels: { ...entry.labels, le: "+Inf" },
          value: entry.count.toString(),
        });

        values.push({
          labels: { ...entry.labels },
          value: entry.count.toString(),
        });

        totalSum += entry.sum;
        totalCount += entry.count;
      });

      return {
        name: this.name,
        help: this.help,
        type: this.type,
        values,
        sum: totalSum,
        count: totalCount,
        buckets: this.buckets,
        aggregator: "sum",
      };
    }

    toPrometheus() {
      const header = [
        `# HELP ${this.name} ${this.help}`.trim(),
        `# TYPE ${this.name} histogram`,
      ];

      const lines = [];

      this.entries.forEach((entry) => {
        let cumulative = 0;
        this.buckets.forEach((bucket, idx) => {
          cumulative += entry.bucketCounts[idx];
          lines.push(
            `${this.name}_bucket${this._formatLabels({
              ...entry.labels,
              le: bucket,
            })} ${cumulative}`
          );
        });

        lines.push(
          `${this.name}_bucket${this._formatLabels({
            ...entry.labels,
            le: "+Inf",
          })} ${entry.count}`
        );

        lines.push(
          `${this.name}_sum${this._formatLabels(entry.labels)} ${entry.sum}`
        );

        lines.push(
          `${this.name}_count${this._formatLabels(entry.labels)} ${entry.count}`
        );
      });

      return [...header, ...lines].join("\n");
    }
  }

  CounterCtor = StubCounter;
  GaugeCtor = StubGauge;
  HistogramCtor = StubHistogram;

  register = stubRegister;

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
