const { expect } = require("chai");
const request = require("supertest");
const { register } = require("../../server/metricsRegistry");

const REQUIRED_ENV_VARS = {
  MAINNET_RPC_URL: "http://localhost:8545",
  UNISWAP_ROUTER_ADDRESS: "0x0000000000000000000000000000000000000001",
  SUSHISWAP_ROUTER_ADDRESS: "0x0000000000000000000000000000000000000002",
  TOKENS_DAI: "0x0000000000000000000000000000000000000003",
  TOKENS_WETH: "0x0000000000000000000000000000000000000004",
};

describe("POST /api/settings", () => {
  let app;

  before(() => {
    process.env.NODE_ENV = "test";
    Object.entries(REQUIRED_ENV_VARS).forEach(([key, value]) => {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    });
    ({ app } = require("../../server/scripts/server"));
  });

  beforeEach(() => {
    register.resetMetrics();
  });

  it("accepts valid settings and returns updated configuration", async () => {
    const res = await request(app).post("/api/settings").send({ pollingInterval: 42 });

    expect(res.status).to.equal(200);
    expect(res.body.status).to.equal("ok");
    expect(res.body.settings).to.have.property("pollingInterval", 42);

    const metrics = await register.getMetricsAsJSON();
    const failureMetric = metrics.find((metric) => metric.name === "arb_failure_total");
    if (failureMetric) {
      const validationSample = failureMetric.values.find(
        (sample) => sample.labels && sample.labels.reason === "settings_validation"
      );
      expect(validationSample?.value || 0).to.equal(0);
    }
  });

  it("rejects invalid settings and records metrics", async () => {
    const res = await request(app)
      .post("/api/settings")
      .send({ pollingInterval: -1 });

    expect(res.status).to.equal(400);
    expect(res.body.error).to.equal("Invalid settings");
    expect(res.body.details.fieldErrors).to.have.property("pollingInterval");

    const metrics = await register.getMetricsAsJSON();
    const failureMetric = metrics.find((metric) => metric.name === "arb_failure_total");
    const validationSample = failureMetric?.values?.find(
      (sample) => sample.labels && sample.labels.reason === "settings_validation"
    );
    expect(validationSample?.value).to.equal(1);
  });

  it("rejects empty payloads", async () => {
    const res = await request(app).post("/api/settings").send({});

    expect(res.status).to.equal(400);
    expect(res.body.error).to.equal("No settings provided");

    const metrics = await register.getMetricsAsJSON();
    const failureMetric = metrics.find((metric) => metric.name === "arb_failure_total");
    const validationSample = failureMetric?.values?.find(
      (sample) => sample.labels && sample.labels.reason === "settings_validation"
    );
    expect(validationSample?.value).to.equal(1);
  });
});
