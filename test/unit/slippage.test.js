const { expect } = require("chai");
const axios = require("axios");

describe("getDynamicSlippage", function () {
  const defaultBips = parseInt(process.env.SLIPPAGE_DEFAULT_BIPS || "50", 10);
  let origGet;

  beforeEach(() => {
    delete require.cache[require.resolve("../../server/botLogic")];
    origGet = axios.get;
  });

  afterEach(() => {
    axios.get = origGet;
  });

  it("calculates slippage from volatility", async function () {
    axios.get = async () => ({ data: { ethereum: { usd_24h_change: 3 } } });
    const { getDynamicSlippage } = require("../../server/botLogic");
    const val = await getDynamicSlippage();
    expect(val).to.equal(Math.min(defaultBips + Math.round(3 * 10), 200));
  });

  it("falls back to default on fetch error", async function () {
    axios.get = async () => {
      throw new Error("fail");
    };
    const { getDynamicSlippage } = require("../../server/botLogic");
    const val = await getDynamicSlippage();
    expect(val).to.equal(defaultBips);
  });
});
