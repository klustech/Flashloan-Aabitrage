const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const ethersModule = require(path.resolve(
  __dirname,
  "../../server/node_modules/ethers"
));
const ethersLib = ethersModule.ethers;

const curveUtilsPath = path.resolve(
  __dirname,
  "../../server/scripts/curveUtils.js"
);

let originalDescriptor;

test("curve utils quoting", { concurrency: false }, async (t) => {
  t.beforeEach(() => {
    originalDescriptor = Object.getOwnPropertyDescriptor(
      ethersLib,
      "Contract"
    );
    delete require.cache[curveUtilsPath];
  });

    t.afterEach(() => {
      if (originalDescriptor) {
        Object.defineProperty(ethersLib, "Contract", originalDescriptor);
      }
      delete require.cache[curveUtilsPath];
      originalDescriptor = undefined;
    });

  await t.test("returns BigNumber quotes using get_dy", async () => {
    const expectedQuote = ethersLib.BigNumber.from("2000");
    const captured = {};

    Object.defineProperty(ethersLib, "Contract", {
      value: function MockContract(address, abi, provider) {
        captured.address = address;
        captured.abi = abi;
        captured.provider = provider;

        return {
          async get_dy(i, j, amount) {
            captured.indices = { i, j };
            captured.amount = amount;
            return expectedQuote;
          },
        };
      },
      configurable: true,
      writable: true,
    });

    const { getCurveQuote, CURVE_POOL_ABI } = require(curveUtilsPath);
    const mockProvider = { call: async () => "0x" };
    const amountIn = ethersLib.BigNumber.from("1000");

    const result = await getCurveQuote(
      mockProvider,
      "0xPool",
      1,
      2,
      amountIn
    );

    assert.equal(result.eq(expectedQuote), true);
    assert.equal(captured.address, "0xPool");
    assert.equal(captured.provider, mockProvider);
    assert.ok(Array.isArray(CURVE_POOL_ABI));
    assert.ok(
      CURVE_POOL_ABI.some((entry) => entry.includes("get_dy(") && entry.includes("returns"))
    );
    assert.deepEqual(captured.indices, { i: 1, j: 2 });
    assert.equal(captured.amount, amountIn);
  });

  await t.test("uses underlying quotes when requested", async () => {
    Object.defineProperty(ethersLib, "Contract", {
      value: function MockContract() {
        return {
          async get_dy_underlying(i, j, amount) {
            assert.equal(i, 3);
            assert.equal(j, 1);
            assert.equal(amount.toString(), "500");
            return amount.mul(2);
          },
        };
      },
      configurable: true,
      writable: true,
    });

    const { getCurveQuote } = require(curveUtilsPath);
    const quote = await getCurveQuote(
      { call: async () => "0x" },
      "0xMetaPool",
      3,
      1,
      ethersLib.BigNumber.from("500"),
      { useUnderlying: true }
    );

    assert.equal(quote.toString(), "1000");
  });

  await t.test("wraps contract reverts with actionable error", async () => {
    const revert = new Error("invalid index");
    revert.code = "CALL_EXCEPTION";
    revert.reason = "Curve: index out of range";

    Object.defineProperty(ethersLib, "Contract", {
      value: function MockContract() {
        return {
          async get_dy() {
            throw revert;
          },
        };
      },
      configurable: true,
      writable: true,
    });

    const { getCurveQuote } = require(curveUtilsPath);

    await assert.rejects(
      () =>
        getCurveQuote(
          { call: async () => "0x" },
          "0xBadPool",
          9,
          0,
          ethersLib.BigNumber.from(1)
        ),
      (error) => {
        assert.match(
          error.message,
          /Curve pool quote failed for 0xBadPool using get_dy\(9, 0\)/
        );
        assert.match(error.message, /Curve: index out of range/);
        assert.equal(error.cause, revert);
        return true;
      }
    );
  });
});
