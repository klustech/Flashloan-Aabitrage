/**
 * test/unit/priceIngestion.node.test.js
 *
 * Unit tests for the priceIngestion module
 */

const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const priceIngestionPath = path.resolve(__dirname, "../../server/scripts/priceIngestion.js");

// Mock ethers module components
const ethersModule = require(path.resolve(__dirname, "../../server/node_modules/ethers"));
const { ethers: ethersLib } = ethersModule;

let originalContract;
let originalProvider;

function setupMocks() {
  // Clear module cache
  delete require.cache[priceIngestionPath];

  // Store original values
  originalContract = ethersLib.Contract;
  originalProvider = ethersLib.providers;

  // Mock environment variables
  process.env.MAINNET_RPC_URL = "http://localhost:8545";
}

function cleanupMocks() {
  delete require.cache[priceIngestionPath];

  // Restore originals
  if (originalContract) {
    ethersLib.Contract = originalContract;
  }
  if (originalProvider) {
    ethersLib.providers = originalProvider;
  }
}

test("priceIngestion reserveCache", { concurrency: false }, async (t) => {
  t.beforeEach(() => {
    setupMocks();
  });

  t.afterEach(() => {
    cleanupMocks();
  });

  await t.test("reserveCache is a Map instance", () => {
    const { reserveCache } = require(priceIngestionPath);
    assert.ok(reserveCache instanceof Map, "reserveCache should be a Map");
  });

  await t.test("can store and retrieve reserves", () => {
    const { reserveCache } = require(priceIngestionPath);

    const poolAddress = "0xTestPool123";
    const mockReserves = {
      reserve0: "1000000000000000000",
      reserve1: "2000000000000000000",
      timestamp: Date.now(),
    };

    reserveCache.set(poolAddress, mockReserves);

    const retrieved = reserveCache.get(poolAddress);
    assert.deepEqual(retrieved, mockReserves, "Should retrieve stored reserves");
  });

  await t.test("returns undefined for non-existent pool", () => {
    const { reserveCache } = require(priceIngestionPath);

    const result = reserveCache.get("0xNonExistent");
    assert.equal(result, undefined, "Should return undefined for missing pool");
  });
});

test("priceIngestion v3PriceCache", { concurrency: false }, async (t) => {
  t.beforeEach(() => {
    setupMocks();
  });

  t.afterEach(() => {
    cleanupMocks();
  });

  await t.test("v3PriceCache is a Map instance", () => {
    const { v3PriceCache } = require(priceIngestionPath);
    assert.ok(v3PriceCache instanceof Map, "v3PriceCache should be a Map");
  });

  await t.test("can store sqrtPriceX96 data", () => {
    const { v3PriceCache } = require(priceIngestionPath);

    const poolAddress = "0xV3Pool123";
    const mockV3Data = {
      sqrtPriceX96: "79228162514264337593543950336", // 1:1 price
      liquidity: "1000000000000000000",
      tick: 0,
      lastSwap: null,
      timestamp: Date.now(),
    };

    v3PriceCache.set(poolAddress, mockV3Data);

    const retrieved = v3PriceCache.get(poolAddress);
    assert.deepEqual(retrieved, mockV3Data, "Should retrieve stored V3 data");
    assert.equal(retrieved.sqrtPriceX96, mockV3Data.sqrtPriceX96, "sqrtPriceX96 should match");
  });
});

test("priceIngestion balancerCache", { concurrency: false }, async (t) => {
  t.beforeEach(() => {
    setupMocks();
  });

  t.afterEach(() => {
    cleanupMocks();
  });

  await t.test("balancerCache is a Map instance", () => {
    const { balancerCache } = require(priceIngestionPath);
    assert.ok(balancerCache instanceof Map, "balancerCache should be a Map");
  });

  await t.test("can store Balancer pool data", () => {
    const { balancerCache } = require(priceIngestionPath);

    const poolId = "0xPoolIdBytes32";
    const mockBalancerData = {
      tokens: ["0xToken1", "0xToken2"],
      balances: ["1000000000000000000", "2000000000000000000"],
      lastSwap: null,
      timestamp: Date.now(),
    };

    balancerCache.set(poolId, mockBalancerData);

    const retrieved = balancerCache.get(poolId);
    assert.deepEqual(retrieved, mockBalancerData, "Should retrieve stored Balancer data");
  });
});

test("priceIngestion curveCache", { concurrency: false }, async (t) => {
  t.beforeEach(() => {
    setupMocks();
  });

  t.afterEach(() => {
    cleanupMocks();
  });

  await t.test("curveCache is a Map instance", () => {
    const { curveCache } = require(priceIngestionPath);
    assert.ok(curveCache instanceof Map, "curveCache should be a Map");
  });

  await t.test("can store Curve pool data", () => {
    const { curveCache } = require(priceIngestionPath);

    const poolAddress = "0xCurvePool";
    const mockCurveData = {
      balances: ["1000000000000000000", "2000000000000000000"],
      lastExchange: null,
      timestamp: Date.now(),
    };

    curveCache.set(poolAddress, mockCurveData);

    const retrieved = curveCache.get(poolAddress);
    assert.deepEqual(retrieved, mockCurveData, "Should retrieve stored Curve data");
  });
});

test("priceIngestion getters", { concurrency: false }, async (t) => {
  t.beforeEach(() => {
    setupMocks();
  });

  t.afterEach(() => {
    cleanupMocks();
  });

  await t.test("getV3Price returns cached data", () => {
    const { v3PriceCache, getV3Price } = require(priceIngestionPath);

    const poolAddress = "0xV3Pool";
    const mockData = {
      sqrtPriceX96: "79228162514264337593543950336",
      liquidity: "1000000",
      tick: 100,
      timestamp: Date.now(),
    };

    v3PriceCache.set(poolAddress, mockData);

    const result = getV3Price(poolAddress);
    assert.deepEqual(result, mockData, "getV3Price should return cached data");
  });

  await t.test("getV3Price returns null for missing pool", () => {
    const { getV3Price } = require(priceIngestionPath);

    const result = getV3Price("0xNonExistent");
    assert.equal(result, null, "getV3Price should return null for missing pool");
  });

  await t.test("getBalancerPoolData returns cached data", () => {
    const { balancerCache, getBalancerPoolData } = require(priceIngestionPath);

    const poolId = "0xBalancerPoolId";
    const mockData = {
      tokens: ["0xA", "0xB"],
      balances: ["100", "200"],
      timestamp: Date.now(),
    };

    balancerCache.set(poolId, mockData);

    const result = getBalancerPoolData(poolId);
    assert.deepEqual(result, mockData, "getBalancerPoolData should return cached data");
  });

  await t.test("getBalancerPoolData returns null for missing pool", () => {
    const { getBalancerPoolData } = require(priceIngestionPath);

    const result = getBalancerPoolData("0xNonExistent");
    assert.equal(result, null, "getBalancerPoolData should return null for missing pool");
  });

  await t.test("getCurvePoolData returns cached data", () => {
    const { curveCache, getCurvePoolData } = require(priceIngestionPath);

    const poolAddress = "0xCurvePool";
    const mockData = {
      balances: ["100", "200"],
      timestamp: Date.now(),
    };

    curveCache.set(poolAddress, mockData);

    const result = getCurvePoolData(poolAddress);
    assert.deepEqual(result, mockData, "getCurvePoolData should return cached data");
  });
});

test("priceIngestion ABI exports", { concurrency: false }, async (t) => {
  t.beforeEach(() => {
    setupMocks();
  });

  t.afterEach(() => {
    cleanupMocks();
  });

  await t.test("exports PAIR_ABI for V2 pools", () => {
    const { PAIR_ABI } = require(priceIngestionPath);

    assert.ok(Array.isArray(PAIR_ABI), "PAIR_ABI should be an array");
    assert.ok(
      PAIR_ABI.some((entry) => entry.includes("Sync")),
      "PAIR_ABI should include Sync event"
    );
    assert.ok(
      PAIR_ABI.some((entry) => entry.includes("getReserves")),
      "PAIR_ABI should include getReserves function"
    );
  });

  await t.test("exports V3_POOL_ABI for V3 pools", () => {
    const { V3_POOL_ABI } = require(priceIngestionPath);

    assert.ok(Array.isArray(V3_POOL_ABI), "V3_POOL_ABI should be an array");
    assert.ok(
      V3_POOL_ABI.some((entry) => entry.includes("Swap")),
      "V3_POOL_ABI should include Swap event"
    );
    assert.ok(
      V3_POOL_ABI.some((entry) => entry.includes("slot0")),
      "V3_POOL_ABI should include slot0 function"
    );
    assert.ok(
      V3_POOL_ABI.some((entry) => entry.includes("sqrtPriceX96")),
      "V3_POOL_ABI should include sqrtPriceX96"
    );
  });

  await t.test("exports BALANCER_VAULT_ABI", () => {
    const { BALANCER_VAULT_ABI } = require(priceIngestionPath);

    assert.ok(Array.isArray(BALANCER_VAULT_ABI), "BALANCER_VAULT_ABI should be an array");
    assert.ok(
      BALANCER_VAULT_ABI.some((entry) => entry.includes("Swap")),
      "BALANCER_VAULT_ABI should include Swap event"
    );
    assert.ok(
      BALANCER_VAULT_ABI.some((entry) => entry.includes("getPoolTokens")),
      "BALANCER_VAULT_ABI should include getPoolTokens function"
    );
  });

  await t.test("exports CURVE_POOL_ABI", () => {
    const { CURVE_POOL_ABI } = require(priceIngestionPath);

    assert.ok(Array.isArray(CURVE_POOL_ABI), "CURVE_POOL_ABI should be an array");
    assert.ok(
      CURVE_POOL_ABI.some((entry) => entry.includes("TokenExchange")),
      "CURVE_POOL_ABI should include TokenExchange event"
    );
    assert.ok(
      CURVE_POOL_ABI.some((entry) => entry.includes("get_dy")),
      "CURVE_POOL_ABI should include get_dy function"
    );
  });
});

test("priceIngestion clearAllSubscriptions", { concurrency: false }, async (t) => {
  t.beforeEach(() => {
    setupMocks();
  });

  t.afterEach(() => {
    cleanupMocks();
  });

  await t.test("clearAllSubscriptions clears all caches", () => {
    const {
      reserveCache,
      v3PriceCache,
      balancerCache,
      curveCache,
      clearAllSubscriptions,
    } = require(priceIngestionPath);

    // Populate caches
    reserveCache.set("0xPool1", { reserve0: "100", reserve1: "200" });
    v3PriceCache.set("0xPool2", { sqrtPriceX96: "100" });
    balancerCache.set("0xPool3", { tokens: [], balances: [] });
    curveCache.set("0xPool4", { balances: [] });

    // Clear all
    clearAllSubscriptions();

    // Verify cleared
    assert.equal(reserveCache.size, 0, "reserveCache should be empty");
    assert.equal(v3PriceCache.size, 0, "v3PriceCache should be empty");
    assert.equal(balancerCache.size, 0, "balancerCache should be empty");
    assert.equal(curveCache.size, 0, "curveCache should be empty");
  });
});

test("priceIngestion getSubscriptionStats", { concurrency: false }, async (t) => {
  t.beforeEach(() => {
    setupMocks();
  });

  t.afterEach(() => {
    cleanupMocks();
  });

  await t.test("getSubscriptionStats returns expected structure", () => {
    const { getSubscriptionStats } = require(priceIngestionPath);

    const stats = getSubscriptionStats();

    assert.ok(stats.v2, "Stats should have v2 property");
    assert.ok(typeof stats.v2.subscriptions === "number", "v2.subscriptions should be a number");
    assert.ok(typeof stats.v2.cached === "number", "v2.cached should be a number");

    assert.ok(stats.v3, "Stats should have v3 property");
    assert.ok(typeof stats.v3.subscriptions === "number", "v3.subscriptions should be a number");
    assert.ok(typeof stats.v3.cached === "number", "v3.cached should be a number");

    assert.ok(stats.balancer, "Stats should have balancer property");
    assert.ok(typeof stats.balancer.subscriptions === "number", "balancer.subscriptions should be a number");
    assert.ok(typeof stats.balancer.cached === "number", "balancer.cached should be a number");

    assert.ok(stats.curve, "Stats should have curve property");
    assert.ok(typeof stats.curve.subscriptions === "number", "curve.subscriptions should be a number");
    assert.ok(typeof stats.curve.cached === "number", "curve.cached should be a number");
  });

  await t.test("stats reflect cache population", () => {
    const {
      reserveCache,
      v3PriceCache,
      getSubscriptionStats,
    } = require(priceIngestionPath);

    // Add some entries
    reserveCache.set("0xPool1", { reserve0: "100", reserve1: "200", timestamp: Date.now() });
    reserveCache.set("0xPool2", { reserve0: "300", reserve1: "400", timestamp: Date.now() });
    v3PriceCache.set("0xV3Pool", { sqrtPriceX96: "100", timestamp: Date.now() });

    const stats = getSubscriptionStats();

    assert.equal(stats.v2.cached, 2, "Should report 2 cached V2 pools");
    assert.equal(stats.v3.cached, 1, "Should report 1 cached V3 pool");
  });
});

test("priceIngestion timestamp handling", { concurrency: false }, async (t) => {
  t.beforeEach(() => {
    setupMocks();
  });

  t.afterEach(() => {
    cleanupMocks();
  });

  await t.test("cache entries have timestamps", () => {
    const { reserveCache } = require(priceIngestionPath);

    const now = Date.now();
    reserveCache.set("0xPool", {
      reserve0: "100",
      reserve1: "200",
      timestamp: now,
    });

    const entry = reserveCache.get("0xPool");
    assert.ok(entry.timestamp, "Entry should have timestamp");
    assert.ok(entry.timestamp <= Date.now(), "Timestamp should be in the past or present");
    assert.ok(entry.timestamp >= now - 1000, "Timestamp should be recent");
  });

  await t.test("can determine cache freshness", () => {
    const { reserveCache } = require(priceIngestionPath);

    // Add fresh entry
    reserveCache.set("0xFreshPool", {
      reserve0: "100",
      reserve1: "200",
      timestamp: Date.now(),
    });

    // Add stale entry (30 seconds old)
    reserveCache.set("0xStalePool", {
      reserve0: "100",
      reserve1: "200",
      timestamp: Date.now() - 30000,
    });

    const freshEntry = reserveCache.get("0xFreshPool");
    const staleEntry = reserveCache.get("0xStalePool");
    const staleThreshold = 10000; // 10 seconds

    const isFreshEntryStale = Date.now() - freshEntry.timestamp > staleThreshold;
    const isStaleEntryStale = Date.now() - staleEntry.timestamp > staleThreshold;

    assert.equal(isFreshEntryStale, false, "Fresh entry should not be stale");
    assert.equal(isStaleEntryStale, true, "Old entry should be stale");
  });
});
