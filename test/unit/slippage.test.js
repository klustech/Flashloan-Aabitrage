const { expect } = require("chai");
// Mock the dependency resolved by botLogic, including isolated server installs.
const axios = require(require.resolve("axios", {
  paths: [require("path").resolve(__dirname, "../../server")],
}));

describe("getDynamicSlippage", function () {
  const defaultBips = parseInt(process.env.SLIPPAGE_DEFAULT_BIPS || "50", 10);
  let origGet;
  let origDefaultGet;
  let originalEnvValue;
  const requiredEnv = {
    PRIVATE_KEY:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    CONTRACT_ADDRESS: "0x0000000000000000000000000000000000000001",
    AAVE_LENDING_POOL_ADDRESS_PROVIDER:
      "0x0000000000000000000000000000000000000002",
    MAINNET_RPC_URL: "http://localhost:8545",
    TOKENS_DAI: "0x0000000000000000000000000000000000000003",
    TOKENS_WETH: "0x0000000000000000000000000000000000000004",
    UNISWAP_ROUTER_ADDRESS: "0x0000000000000000000000000000000000000005",
    SUSHISWAP_ROUTER_ADDRESS: "0x0000000000000000000000000000000000000006",
  };
  let originalRequiredEnv;

  function setAxiosGet(fn) {
    axios.get = fn;
    if (axios.default) {
      axios.default.get = fn;
    }
  }

  beforeEach(() => {
    delete require.cache[require.resolve("../../server/botLogic")];
    origGet = axios.get;
    origDefaultGet = axios.default?.get;
    originalEnvValue = process.env.SLIPPAGE_DEFAULT_BIPS;
    originalRequiredEnv = {};
    Object.entries(requiredEnv).forEach(([key, value]) => {
      originalRequiredEnv[key] = process.env[key];
      process.env[key] = value;
    });
  });

  afterEach(() => {
    axios.get = origGet;
    if (origDefaultGet) {
      axios.default.get = origDefaultGet;
    }
    if (typeof originalEnvValue === "undefined") {
      delete process.env.SLIPPAGE_DEFAULT_BIPS;
    } else {
      process.env.SLIPPAGE_DEFAULT_BIPS = originalEnvValue;
    }
    Object.entries(requiredEnv).forEach(([key]) => {
      const original = originalRequiredEnv[key];
      if (typeof original === "undefined") {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    });
  });

  it("calculates slippage from volatility", async function () {
    const { getDynamicSlippage, __cache } = require("../../server/botLogic");
    __cache.coinGecko["ethereum-usd"] = {
      data: { ethereum: { usd_24h_change: 3 } },
      timestamp: Date.now(),
    };
    const val = await getDynamicSlippage();
    expect(val).to.equal(Math.min(defaultBips + Math.round(3 * 10), 200));
  });

  it("falls back to default on fetch error", async function () {
    setAxiosGet(async () => {
      throw new Error("fail");
    });
    const { getDynamicSlippage } = require("../../server/botLogic");
    const val = await getDynamicSlippage();
    expect(val).to.equal(defaultBips);
  });

  it("honours env override for default slippage", async function () {
    process.env.SLIPPAGE_DEFAULT_BIPS = "75";
    delete require.cache[require.resolve("../../server/botLogic")];
    setAxiosGet(async () => {
      throw new Error("fail");
    });
    const { getDynamicSlippage } = require("../../server/botLogic");
    const val = await getDynamicSlippage();
    expect(val).to.equal(75);
  });

  it("keeps trading mode unchanged while fetching display market data", async function () {
    const { tradingState } = require("../../server/bot/stateMachine");
    const previous = tradingState.snapshot();
    tradingState.paper();
    tradingState.arm({ ready: true });
    tradingState.live();
    const revision = tradingState.revision;
    setAxiosGet(async () => ({ data: { ethereum: { usd_24h_change: 1 } } }));
    try {
      await require("../../server/botLogic").getDynamicSlippage();
      expect(tradingState.canSign(revision)).to.equal(true);
    } finally {
      tradingState.set(previous.state, previous.reason);
    }
  });
});
