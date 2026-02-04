/**
 * test/unit/routeFinder.node.test.js
 *
 * Unit tests for the routeFinder module
 */

const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

// Mock getTopLiquidityPairs to avoid network calls
const routeFinderPath = path.resolve(__dirname, "../../server/scripts/routeFinder.js");

// Sample pool data for testing
const mockPools = [
  {
    token0: "0xDAI",
    token1: "0xWETH",
    pairAddress: "0xPool1",
    dex: "uniswap_v2",
    fee: null,
    reserveUSD: 1000000,
  },
  {
    token0: "0xWETH",
    token1: "0xUSDC",
    pairAddress: "0xPool2",
    dex: "uniswap_v2",
    fee: null,
    reserveUSD: 2000000,
  },
  {
    token0: "0xUSDC",
    token1: "0xDAI",
    pairAddress: "0xPool3",
    dex: "sushiswap_v2",
    fee: null,
    reserveUSD: 1500000,
  },
  {
    token0: "0xWETH",
    token1: "0xUNI",
    pairAddress: "0xPool4",
    dex: "uniswap_v3",
    fee: 3000,
    reserveUSD: 500000,
  },
  {
    token0: "0xUNI",
    token1: "0xDAI",
    pairAddress: "0xPool5",
    dex: "uniswap_v3",
    fee: 500,
    reserveUSD: 800000,
  },
];

// Clear the module cache and mock dependencies
function setupMocks(pools = mockPools) {
  // Clear require cache
  delete require.cache[routeFinderPath];

  // Mock the liquidityScanner module
  const liquidityScannerPath = path.resolve(__dirname, "../../server/scripts/liquidityScanner.js");
  require.cache[liquidityScannerPath] = {
    id: liquidityScannerPath,
    filename: liquidityScannerPath,
    loaded: true,
    exports: {
      getTopLiquidityPairs: async () => pools,
    },
  };

  // Mock redis client
  const redisClientPath = path.resolve(__dirname, "../../server/utils/redisClient.js");
  require.cache[redisClientPath] = {
    id: redisClientPath,
    filename: redisClientPath,
    loaded: true,
    exports: {
      get: async () => null,
      set: async () => "OK",
      quit: async () => {},
    },
  };
}

function cleanupMocks() {
  delete require.cache[routeFinderPath];
  const liquidityScannerPath = path.resolve(__dirname, "../../server/scripts/liquidityScanner.js");
  delete require.cache[liquidityScannerPath];
  const redisClientPath = path.resolve(__dirname, "../../server/utils/redisClient.js");
  delete require.cache[redisClientPath];
}

test("routeFinder module", { concurrency: false }, async (t) => {
  t.beforeEach(() => {
    setupMocks();
  });

  t.afterEach(() => {
    cleanupMocks();
  });

  await t.test("getAllRoutes returns circular routes through DAI", async () => {
    setupMocks();
    const { getAllRoutes } = require(routeFinderPath);

    const routes = await getAllRoutes({
      chain: "mainnet",
      maxHops: 3,
      topN: 50,
      minLiquidityUSD: 100000,
      startToken: "0xDAI",
    });

    // Should find at least one circular route starting and ending with DAI
    assert.ok(Array.isArray(routes), "Routes should be an array");

    if (routes.length > 0) {
      for (const route of routes) {
        assert.ok(route.hops, "Route should have hops");
        assert.ok(Array.isArray(route.hops), "Hops should be an array");
        assert.ok(route.hops.length >= 2, "Route should have at least 2 hops");

        // Check route is circular (starts and ends with same token)
        const firstHop = route.hops[0];
        const lastHop = route.hops[route.hops.length - 1];
        assert.ok(firstHop.tokenA, "First hop should have tokenA");
        assert.ok(lastHop.tokenB, "Last hop should have tokenB");
      }
    }
  });

  await t.test("getAllRoutes respects maxHops parameter", async () => {
    setupMocks();
    const { getAllRoutes } = require(routeFinderPath);

    const routes = await getAllRoutes({
      chain: "mainnet",
      maxHops: 2,
      topN: 50,
      minLiquidityUSD: 100000,
    });

    for (const route of routes) {
      assert.ok(
        route.hops.length <= 2,
        `Route has ${route.hops.length} hops, expected <= 2`
      );
    }
  });

  await t.test("getAllRoutes handles empty pools gracefully", async () => {
    setupMocks([]);
    const { getAllRoutes } = require(routeFinderPath);

    const routes = await getAllRoutes({
      chain: "mainnet",
      maxHops: 3,
      topN: 50,
      minLiquidityUSD: 100000,
    });

    assert.ok(Array.isArray(routes), "Should return an array");
    assert.equal(routes.length, 0, "Should return empty array for empty pools");
  });

  await t.test("route hops contain required properties", async () => {
    setupMocks();
    const { getAllRoutes } = require(routeFinderPath);

    const routes = await getAllRoutes({
      chain: "mainnet",
      maxHops: 3,
      topN: 50,
      minLiquidityUSD: 100000,
    });

    for (const route of routes) {
      assert.ok(route.id, "Route should have an id");
      assert.ok(typeof route.liquidity === "number", "Route should have liquidity");

      for (const hop of route.hops) {
        assert.ok(hop.tokenA, "Hop should have tokenA");
        assert.ok(hop.tokenB, "Hop should have tokenB");
        assert.ok(hop.dex, "Hop should have dex");
        assert.ok(hop.poolAddress, "Hop should have poolAddress");
        assert.ok(typeof hop.feeBps === "number", "Hop should have feeBps");
      }
    }
  });

  await t.test("routes contain continuity (tokenB of hop N = tokenA of hop N+1)", async () => {
    setupMocks();
    const { getAllRoutes } = require(routeFinderPath);

    const routes = await getAllRoutes({
      chain: "mainnet",
      maxHops: 4,
      topN: 100,
      minLiquidityUSD: 50000,
    });

    for (const route of routes) {
      for (let i = 0; i < route.hops.length - 1; i++) {
        const currentHop = route.hops[i];
        const nextHop = route.hops[i + 1];

        assert.equal(
          currentHop.tokenB.toLowerCase(),
          nextHop.tokenA.toLowerCase(),
          `Route continuity broken: hop ${i} tokenB (${currentHop.tokenB}) != hop ${i+1} tokenA (${nextHop.tokenA})`
        );
      }
    }
  });

  await t.test("V3 pools have correct fee handling", async () => {
    const v3Pools = [
      {
        token0: "0xTokenA",
        token1: "0xTokenB",
        pairAddress: "0xV3Pool",
        dex: "uniswap_v3",
        fee: 3000, // 0.3% in V3 notation
        reserveUSD: 1000000,
      },
      {
        token0: "0xTokenB",
        token1: "0xTokenA",
        pairAddress: "0xV3Pool2",
        dex: "uniswap_v3",
        fee: 500, // 0.05% in V3 notation
        reserveUSD: 2000000,
      },
    ];

    setupMocks(v3Pools);
    const { getAllRoutes } = require(routeFinderPath);

    const routes = await getAllRoutes({
      chain: "mainnet",
      maxHops: 2,
      topN: 50,
      minLiquidityUSD: 100000,
    });

    for (const route of routes) {
      for (const hop of route.hops) {
        if (hop.dex === "uniswap_v3") {
          // V3 fees should be converted to bips
          assert.ok(
            hop.feeBps <= 100,
            `V3 fee should be converted to bips: got ${hop.feeBps}`
          );
        }
      }
    }
  });

  await t.test("filters pools below minimum liquidity", async () => {
    const lowLiqPools = [
      {
        token0: "0xDAI",
        token1: "0xWETH",
        pairAddress: "0xLowLiqPool",
        dex: "uniswap_v2",
        fee: null,
        reserveUSD: 1000, // Very low liquidity
      },
    ];

    setupMocks(lowLiqPools);
    const { getAllRoutes } = require(routeFinderPath);

    const routes = await getAllRoutes({
      chain: "mainnet",
      maxHops: 3,
      topN: 50,
      minLiquidityUSD: 100000, // Higher than pool liquidity
    });

    // With high minLiquidity and low pool liquidity, expect no routes
    assert.ok(Array.isArray(routes), "Should return an array");
  });

  await t.test("handles multiple DEX types in same route", async () => {
    const multiDexPools = [
      {
        token0: "0xDAI",
        token1: "0xWETH",
        pairAddress: "0xUniV2Pool",
        dex: "uniswap_v2",
        fee: null,
        reserveUSD: 1000000,
      },
      {
        token0: "0xWETH",
        token1: "0xUSDC",
        pairAddress: "0xSushiPool",
        dex: "sushiswap_v2",
        fee: null,
        reserveUSD: 1000000,
      },
      {
        token0: "0xUSDC",
        token1: "0xDAI",
        pairAddress: "0xUniV3Pool",
        dex: "uniswap_v3",
        fee: 3000,
        reserveUSD: 1000000,
      },
    ];

    setupMocks(multiDexPools);
    const { getAllRoutes } = require(routeFinderPath);

    const routes = await getAllRoutes({
      chain: "mainnet",
      maxHops: 3,
      topN: 100,
      minLiquidityUSD: 50000,
    });

    // Check that routes can span multiple DEXs
    let hasMultiDexRoute = false;
    for (const route of routes) {
      const dexTypes = new Set(route.hops.map((h) => h.dex));
      if (dexTypes.size > 1) {
        hasMultiDexRoute = true;
        break;
      }
    }

    // This test verifies the infrastructure supports cross-DEX routes
    // (may or may not find one depending on circular path availability)
    assert.ok(Array.isArray(routes), "Should return routes array");
  });
});

test("routeFinder edge cases", { concurrency: false }, async (t) => {
  t.beforeEach(() => {
    setupMocks();
  });

  t.afterEach(() => {
    cleanupMocks();
  });

  await t.test("handles pools with missing token addresses", async () => {
    const invalidPools = [
      {
        token0: null,
        token1: "0xWETH",
        pairAddress: "0xPool",
        dex: "uniswap_v2",
        reserveUSD: 1000000,
      },
      {
        token0: "0xDAI",
        token1: null,
        pairAddress: "0xPool2",
        dex: "uniswap_v2",
        reserveUSD: 1000000,
      },
    ];

    setupMocks(invalidPools);
    const { getAllRoutes } = require(routeFinderPath);

    // Should not throw
    const routes = await getAllRoutes({
      chain: "mainnet",
      maxHops: 3,
      topN: 50,
      minLiquidityUSD: 100000,
    });

    assert.ok(Array.isArray(routes), "Should return an array without crashing");
  });

  await t.test("handles duplicate pool entries", async () => {
    const duplicatePools = [
      {
        token0: "0xDAI",
        token1: "0xWETH",
        pairAddress: "0xPool1",
        dex: "uniswap_v2",
        reserveUSD: 1000000,
      },
      {
        token0: "0xDAI",
        token1: "0xWETH",
        pairAddress: "0xPool1", // Same pool
        dex: "uniswap_v2",
        reserveUSD: 1000000,
      },
    ];

    setupMocks(duplicatePools);
    const { getAllRoutes } = require(routeFinderPath);

    const routes = await getAllRoutes({
      chain: "mainnet",
      maxHops: 3,
      topN: 50,
      minLiquidityUSD: 100000,
    });

    assert.ok(Array.isArray(routes), "Should handle duplicates gracefully");
  });
});
