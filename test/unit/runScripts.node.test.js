const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const Module = require("module");

test("run-bot entry point", { concurrency: false }, async (t) => {
  const botLogicPath = path.resolve(__dirname, "../../server/botLogic.js");
  const runBotPath = path.resolve(__dirname, "../../scripts/run-bot.js");
  let originalBotLogic;
  let originalModuleLoad;

  t.beforeEach(() => {
    originalModuleLoad = Module._load;
    Module._load = function stubLoader(request, parent, isMain) {
      if (request === "coingecko-api") {
        return class CoinGeckoStub {};
      }
      return originalModuleLoad.call(this, request, parent, isMain);
    };
    originalBotLogic = require.cache[botLogicPath];
    require.cache[botLogicPath] = {
      id: botLogicPath,
      filename: botLogicPath,
      loaded: true,
      exports: {
        simulateAndExecuteArb: async () => ({
          executed: false,
          estimatedProfitInDai: ethers.BigNumber.from(0),
        }),
      },
    };
    delete require.cache[runBotPath];
  });

  t.afterEach(() => {
    delete require.cache[runBotPath];
    Module._load = originalModuleLoad;
    if (originalBotLogic) {
      require.cache[botLogicPath] = originalBotLogic;
    } else {
      delete require.cache[botLogicPath];
    }
  });

  await t.test("runs configured number of cycles and returns last result", async () => {
    const calls = [];
    const responses = [
      { executed: false, estimatedProfitInDai: ethers.BigNumber.from(0) },
      { executed: true, estimatedProfitInDai: ethers.BigNumber.from(42) },
    ];

    require.cache[botLogicPath].exports.simulateAndExecuteArb = async (
      useFlashbots
    ) => {
      calls.push(useFlashbots);
      return responses.shift();
    };

    const { runBot } = require(runBotPath);
    const result = await runBot({
      maxCycles: 2,
      pollIntervalMs: 0,
      useFlashbots: false,
    });

    assert.deepEqual(calls, [false, false]);
    assert.deepEqual(result, {
      executed: true,
      estimatedProfitInDai: ethers.BigNumber.from(42),
    });
    assert.equal(responses.length, 0);
  });
});

test("run-backtest entry point", { concurrency: false }, async (t) => {
  const botLogicPath = path.resolve(__dirname, "../../server/botLogic.js");
  const backtestPath = path.resolve(
    __dirname,
    "../../server/scripts/backtestArbitrage.js"
  );
  const runBacktestPath = path.resolve(
    __dirname,
    "../../scripts/run-backtest.js"
  );

  let originalBotLogic;
  let originalBacktest;

  t.beforeEach(() => {
    originalBotLogic = require.cache[botLogicPath];
    require.cache[botLogicPath] = {
      id: botLogicPath,
      filename: botLogicPath,
      loaded: true,
      exports: {
        getAllRoutes: async () => [],
        DEFAULT_CHAIN: "ethereum",
      },
    };

    originalBacktest = require.cache[backtestPath];
    require.cache[backtestPath] = {
      id: backtestPath,
      filename: backtestPath,
      loaded: true,
      exports: {
        backtestArbitrage: async () => ({
          tradeCount: 0,
          totalProfit: ethers.BigNumber.from(0),
        }),
      },
    };

    delete require.cache[runBacktestPath];
  });

  t.afterEach(() => {
    delete require.cache[runBacktestPath];
    if (originalBotLogic) {
      require.cache[botLogicPath] = originalBotLogic;
    } else {
      delete require.cache[botLogicPath];
    }
    if (originalBacktest) {
      require.cache[backtestPath] = originalBacktest;
    } else {
      delete require.cache[backtestPath];
    }
  });

  await t.test("fetches routes and invokes backtestArbitrage with resolved options", async () => {
    const routes = [{ id: "route-1" }];
    const summary = {
      tradeCount: 2,
      totalProfit: ethers.utils.parseEther("1.25"),
    };
    let received;

    require.cache[botLogicPath].exports.getAllRoutes = async (chain) => {
      assert.equal(chain, "ethereum");
      return routes;
    };

    require.cache[backtestPath].exports.backtestArbitrage = async (
      start,
      end,
      providedRoutes,
      options
    ) => {
      received = { start, end, providedRoutes, options };
      return summary;
    };

    const { runBacktest } = require(runBacktestPath);
    const result = await runBacktest({
      startBlock: 1,
      endBlock: 2,
      borrowAmount: ethers.utils.parseEther("5"),
      slippageBips: 25,
    });

    assert.deepEqual(received, {
      start: 1,
      end: 2,
      providedRoutes: routes,
      options: {
        borrowAmount: ethers.utils.parseEther("5"),
        slippageBips: 25,
      },
    });
    assert.deepEqual(result, summary);
  });

  await t.test("supports overriding routes directly", async () => {
    const routes = [{ id: "manual" }];
    let providedRoutes;

    require.cache[backtestPath].exports.backtestArbitrage = async (
      start,
      end,
      rts
    ) => {
      providedRoutes = rts;
      return { tradeCount: 0, totalProfit: ethers.BigNumber.from(0) };
    };

    const { runBacktest } = require(runBacktestPath);
    await runBacktest({
      routes,
      borrowAmount: ethers.BigNumber.from(1),
      slippageBips: 10,
    });

    assert.strictEqual(providedRoutes, routes);
  });
});
