/**
 * test/server/newEndpoints.api.test.js
 *
 * End-to-end tests for new API endpoints:
 * - Connext cross-chain integration
 * - Timelock governance
 * - ML statistics
 * - Arbitrage simulation
 * - Settings persistence
 */

const { expect } = require("chai");
const request = require("supertest");
const fs = require("fs");
const path = require("path");
const { register } = require("../../server/metricsRegistry");

const REQUIRED_ENV_VARS = {
  MAINNET_RPC_URL: "http://localhost:8545",
  UNISWAP_ROUTER_ADDRESS: "0x0000000000000000000000000000000000000001",
  SUSHISWAP_ROUTER_ADDRESS: "0x0000000000000000000000000000000000000002",
  TOKENS_DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  TOKENS_WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
};

describe("New API Endpoints", function () {
  let app;
  const settingsFilePath = path.join(__dirname, "../../server/.settings.json");

  before(() => {
    process.env.NODE_ENV = "test";
    process.env.API_KEY = "test-api-key";
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

  afterEach(() => {
    // Clean up settings file after each test
    if (fs.existsSync(settingsFilePath)) {
      try {
        fs.unlinkSync(settingsFilePath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Connext Cross-Chain API Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Connext API", () => {
    describe("GET /api/connext/status", () => {
      it("returns Connext status even when not initialized", async () => {
        const res = await request(app).get("/api/connext/status").set("x-api-key", "test-api-key");

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property("initialized");
        // In test mode, Connext should not be initialized
        expect(res.body.initialized).to.equal(false);
      });

      it("accepts optional token query parameter", async () => {
        const res = await request(app).get("/api/connext/status").set("x-api-key", "test-api-key")
          .query({ token: "0x6B175474E89094C44Da98b954EedeAC495271d0F" });

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property("initialized");
      });
    });

    describe("POST /api/connext/forward", () => {
      it("requires token address", async () => {
        const res = await request(app).post("/api/connext/forward").set("x-api-key", "test-api-key").send({});

        expect(res.status).to.equal(400);
        expect(res.body.error).to.include("token");
      });

      it("returns error when Connext not initialized", async () => {
        const res = await request(app).post("/api/connext/forward").set("x-api-key", "test-api-key")
          .send({ token: "0x6B175474E89094C44Da98b954EedeAC495271d0F" });

        expect(res.status).to.be.oneOf([200, 500]);
        // In test mode, this should fail gracefully
      });
    });

    describe("GET /api/connext/transfers", () => {
      it("returns transfer history", async () => {
        const res = await request(app).get("/api/connext/transfers").set("x-api-key", "test-api-key");

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property("transfers");
        expect(res.body.transfers).to.be.an("array");
      });

      it("accepts limit query parameter", async () => {
        const res = await request(app).get("/api/connext/transfers").set("x-api-key", "test-api-key")
          .query({ limit: 5 });

        expect(res.status).to.equal(200);
        expect(res.body.transfers.length).to.be.at.most(5);
      });
    });

    describe("GET /api/connext/transfers/pending", () => {
      it("returns pending transfers", async () => {
        const res = await request(app).get("/api/connext/transfers/pending").set("x-api-key", "test-api-key");

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property("transfers");
        expect(res.body).to.have.property("count");
      });
    });

    describe("GET /api/connext/transfers/:transferId", () => {
      it("returns transfer status for valid ID", async () => {
        const res = await request(app).get(
          "/api/connext/transfers/0x123456789"
        ).set("x-api-key", "test-api-key");

        expect(res.status).to.equal(200);
        // Should return status even if transfer not found
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Timelock Governance API Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Timelock API", () => {
    describe("GET /api/timelock/status", () => {
      it("returns timelock status", async () => {
        const res = await request(app).get("/api/timelock/status").set("x-api-key", "test-api-key");

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property("initialized");
        // In test mode without TIMELOCK_ADDRESS, should not be initialized
        expect(res.body.initialized).to.equal(false);
      });
    });

    describe("GET /api/timelock/operations/:operationId", () => {
      it("returns error when timelock not configured", async () => {
        const res = await request(app).get("/api/timelock/operations/0x123").set("x-api-key", "test-api-key");

        expect(res.status).to.equal(400);
        expect(res.body.error).to.include("not configured");
      });
    });

    describe("POST /api/timelock/schedule", () => {
      it("returns error when timelock not configured", async () => {
        const res = await request(app).post("/api/timelock/schedule").set("x-api-key", "test-api-key")
          .send({ operation: "setMaxLossBps", params: { newMaxLossBps: 100 } });

        expect(res.status).to.equal(400);
        expect(res.body.error).to.include("not configured");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // ML Statistics API Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe("ML Statistics API", () => {
    describe("GET /api/ml-stats", () => {
      it("returns ML model statistics", async () => {
        const res = await request(app).get("/api/ml-stats").set("x-api-key", "test-api-key");

        expect(res.status).to.equal(200);
        // Should have either available=true with stats or available=false
        if (res.body.available) {
          expect(res.body).to.have.property("modelVersion");
        } else {
          expect(res.body).to.have.property("message");
        }
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Arbitrage Simulation API Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Arbitrage Simulation API", () => {
    describe("POST /api/simulate-arbitrage", () => {
      it("returns simulation results for valid request", async () => {
        const res = await request(app).post("/api/simulate-arbitrage").set("x-api-key", "test-api-key")
          .send({
            borrowAmount: 1000,
            borrowToken: "DAI",
            route: [
              { tokenIn: "DAI", tokenOut: "WETH", dex: "uniswap_v2" },
              { tokenIn: "WETH", tokenOut: "DAI", dex: "sushiswap" },
            ],
            slippageBps: 50,
            gasPrice: 30,
          });

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property("simulation");
        expect(res.body.simulation).to.have.property("hops");
        expect(res.body.simulation).to.have.property("grossProfit");
        expect(res.body.simulation).to.have.property("gasCost");
        expect(res.body.simulation).to.have.property("netProfit");
      });

      it("rejects invalid simulation parameters", async () => {
        const res = await request(app).post("/api/simulate-arbitrage").set("x-api-key", "test-api-key")
          .send({ borrowAmount: 1000 }); // Missing route

        expect(res.status).to.equal(400);
        expect(res.body.error).to.include("Invalid");
      });

      it("handles multi-hop routes", async () => {
        const res = await request(app).post("/api/simulate-arbitrage").set("x-api-key", "test-api-key")
          .send({
            borrowAmount: 5000,
            borrowToken: "DAI",
            route: [
              { tokenIn: "DAI", tokenOut: "WETH", dex: "uniswap_v2" },
              { tokenIn: "WETH", tokenOut: "USDC", dex: "uniswap_v3" },
              { tokenIn: "USDC", tokenOut: "DAI", dex: "curve" },
            ],
            slippageBps: 100,
            gasPrice: 50,
          });

        expect(res.status).to.equal(200);
        expect(res.body.simulation.hops).to.have.length(3);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Settings Persistence Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Settings Persistence", () => {
    describe("GET /api/settings", () => {
      it("includes persistence status", async () => {
        const res = await request(app).get("/api/settings").set("x-api-key", "test-api-key");

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property("_persisted");
        expect(res.body).to.have.property("_settingsFile");
      });
    });

    describe("POST /api/settings/reset", () => {
      it("resets settings to defaults", async () => {
        // First update a setting
        await request(app).post("/api/settings").set("x-api-key", "test-api-key").send({ pollingInterval: 999 });

        // Then reset
        const res = await request(app).post("/api/settings/reset").set("x-api-key", "test-api-key");

        expect(res.status).to.equal(200);
        expect(res.body.status).to.equal("ok");
        expect(res.body.message).to.include("reset");

        // Verify settings are back to defaults
        const getRes = await request(app).get("/api/settings").set("x-api-key", "test-api-key");
        expect(getRes.body.pollingInterval).to.not.equal(999);
      });
    });

    describe("POST /api/settings persistence", () => {
      it("indicates settings were persisted", async () => {
        const res = await request(app).post("/api/settings").set("x-api-key", "test-api-key")
          .send({ pollingInterval: 42 });

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property("persisted", true);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Bot Status API Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Bot Status API", () => {
    describe("GET /api/bot-status", () => {
      it("returns comprehensive bot status", async () => {
        const res = await request(app).get("/api/bot-status").set("x-api-key", "test-api-key");

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property("circuitBreaker");
        expect(res.body).to.have.property("services");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Circuit Breaker API Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Circuit Breaker API", () => {
    describe("GET /api/circuit-breaker", () => {
      it("returns circuit breaker state", async () => {
        const res = await request(app).get("/api/circuit-breaker").set("x-api-key", "test-api-key");

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property("state");
      });
    });

    describe("POST /api/circuit-breaker/reset", () => {
      it("resets circuit breaker", async () => {
        const res = await request(app).post("/api/circuit-breaker/reset").set("x-api-key", "test-api-key");

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property("state");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Opportunities API Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Opportunities API", () => {
    describe("GET /api/opportunities", () => {
      it("returns opportunities list", async () => {
        const res = await request(app).get("/api/opportunities").set("x-api-key", "test-api-key");

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property("opportunities");
        expect(res.body.opportunities).to.be.an("array");
        expect(res.body).to.have.property("count");
      });
    });
  });
});

