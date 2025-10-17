let client;
try {
  client = require("prom-client");
} catch (err) {
  // Fallback stub if prom-client is unavailable
  const metrics = [];

  class StubMetric {
    constructor({ name, help, type }) {
      this.name = name;
      this.help = help;
      this.type = type;
      metrics.push(this);
    }

    toJSON() {
      return {
        name: this.name,
        help: this.help,
        type: this.type,
        values: this.get().values || [],
      };
    }
  }

  class Counter extends StubMetric {
    constructor(config) {
      super({ ...config, type: "counter" });
      this.value = 0;
    }
    inc() {
      this.value += 1;
    }
    get() {
      return { values: [{ value: this.value }] };
    }
    reset() {
      this.value = 0;
    }
  }

  class Gauge extends StubMetric {
    constructor(config) {
      super({ ...config, type: "gauge" });
      this.value = undefined;
    }
    set(v) {
      this.value = v;
    }
    inc(v = 1) {
      const next = typeof this.value === "number" ? this.value + v : v;
      this.value = next;
    }
    get() {
      return {
        values:
          this.value === undefined ? [] : [{ value: this.value, labels: {} }],
      };
    }
    reset() {
      this.value = undefined;
    }
  }

  class Histogram extends StubMetric {
    constructor(config) {
      super({ ...config, type: "histogram" });
      this.values = [];
    }
    observe(v) {
      this.values.push(v);
    }
    get() {
      return { values: this.values.map((value) => ({ value })) };
    }
  }

  client = {
    collectDefaultMetrics: () => {},
    Counter,
    Gauge,
    Histogram,
    register: {
      contentType: "text/plain",
      metrics: async () => "",
      getMetricsAsJSON: async () => metrics.map((metric) => metric.toJSON()),
    },
  };
}

module.exports = client;
