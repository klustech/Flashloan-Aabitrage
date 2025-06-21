let client;
try {
  client = require("prom-client");
} catch (err) {
  // Fallback stub if prom-client is unavailable
  client = {
    collectDefaultMetrics: () => {},
    Counter: class {
      constructor() {}
      inc() {}
    },
    Gauge: class {
      constructor() {}
      set() {}
      inc() {}
    },
    Histogram: class {
      constructor() {}
      observe() {}
    },
  };
}

module.exports = client;
