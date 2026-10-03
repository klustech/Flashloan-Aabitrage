const { expect } = require("chai");
const request = require("supertest");
const { createApiRateLimits } = require("../../server/utils/apiRateLimits");
const express = require("express");
describe("PAPER commissioning API safeguards", function () {
  let app, oldFlag;
  before(() => {
    process.env.NODE_ENV = "test";
    process.env.API_KEY = "test-api-key";
    process.env.MAINNET_RPC_URL ||= "http://localhost:8545";
    process.env.UNISWAP_ROUTER_ADDRESS ||=
      "0x0000000000000000000000000000000000000001";
    process.env.SUSHISWAP_ROUTER_ADDRESS ||=
      "0x0000000000000000000000000000000000000002";
    process.env.TOKENS_DAI ||= "0x0000000000000000000000000000000000000003";
    process.env.TOKENS_WETH ||= "0x0000000000000000000000000000000000000004";
    process.env.CONTRACT_ADDRESS ||=
      "0x0000000000000000000000000000000000000005";
    ({ app } = require("../../server/scripts/server"));
    oldFlag = process.env.PAPER_ONLY;
    process.env.PAPER_ONLY = "true";
  });
  after(() => {
    if (oldFlag === undefined) delete process.env.PAPER_ONLY;
    else process.env.PAPER_ONLY = oldFlag;
  });
  it("allows 50 authenticated trading reads without 429", async () => {
    for (let i = 0; i < 50; i++) {
      const res = await request(app)
        .get("/api/trading")
        .set("x-api-key", "test-api-key");
      expect(res.status).to.equal(200);
      expect(res.body.trading.paperOnly).to.equal(true);
    }
  });
  it("rejects arm/live in PAPER_ONLY, throttles repeated control attempts and keeps pause usable", async () => {
    for (const route of ["arm", "live"]) {
      const res = await request(app)
        .post(`/api/trading/${route}`)
        .set("x-api-key", "test-api-key");
      expect(res.status).to.equal(409);
      expect(res.body.error).to.include("PAPER_ONLY");
    }
    let limited = false;
    for (let i = 0; i < 31; i++) {
      const res = await request(app)
        .post("/api/trading/arm")
        .set("x-api-key", "test-api-key");
      if (res.status === 429) limited = true;
    }
    expect(limited).to.equal(true);
    expect(
      (
        await request(app)
          .post("/api/trading/pause")
          .set("x-api-key", "test-api-key")
      ).status
    ).to.equal(200);
    expect(
      (await request(app).get("/api/trading").set("x-api-key", "test-api-key"))
        .status
    ).to.equal(200);
  });
  it("auth failures remain independent of mutation exhaustion and health stays available", async () => {
    expect((await request(app).get("/api/trading")).status).to.equal(401);
    expect(
      (await request(app).post("/api/trading/arm").set("x-api-key", "wrong"))
        .status
    ).to.equal(401);
    const key = process.env.API_KEY;
    delete process.env.API_KEY;
    try {
      expect((await request(app).get("/api/trading")).status).to.equal(503);
    } finally {
      process.env.API_KEY = key;
    }
    expect((await request(app).get("/healthz")).status).not.to.equal(429);
  });
  it("settings and ordinary mutations have independent budgets from reads and trading", async () => {
    const api = express();
    api.use(createApiRateLimits({ reads: 50, mutations: 2 }));
    api.all("/{*path}", (_req, res) => res.sendStatus(200));
    expect((await request(api).post("/api/settings")).status).to.equal(200);
    expect((await request(api).post("/api/settings")).status).to.equal(200);
    expect((await request(api).post("/api/settings")).status).to.equal(429);
    expect((await request(api).post("/api/other")).status).to.equal(200);
    expect((await request(api).get("/api/settings")).status).to.equal(200);
  });
});
