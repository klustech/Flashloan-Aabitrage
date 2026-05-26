// Unit tests for server/scripts/onchainPools.js CREATE2 pair derivation.
// Pure computation — no RPC. Run: node --test test/unit/onchainPools.node.test.js
const test = require("node:test");
const assert = require("node:assert");
const { computeV2Pair } = require("../../server/scripts/onchainPools");

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const UNI_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const UNI_HASH =
  "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f";
const SUSHI_FACTORY = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac";
const SUSHI_HASH =
  "0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303";

test("computeV2Pair matches canonical Uniswap V2 pair addresses", () => {
  assert.strictEqual(
    computeV2Pair(UNI_FACTORY, DAI, WETH, UNI_HASH).toLowerCase(),
    "0xa478c2975ab1ea89e8196811f51a7b7ade33eb11"
  );
  assert.strictEqual(
    computeV2Pair(UNI_FACTORY, USDC, WETH, UNI_HASH).toLowerCase(),
    "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc"
  );
});

test("computeV2Pair matches canonical Sushiswap pair address", () => {
  assert.strictEqual(
    computeV2Pair(SUSHI_FACTORY, DAI, WETH, SUSHI_HASH).toLowerCase(),
    "0xc3d03e4f041fd4cd388c549ee2a29a9e5075882f"
  );
});

test("computeV2Pair is order-independent (token0 sorting)", () => {
  assert.strictEqual(
    computeV2Pair(UNI_FACTORY, DAI, WETH, UNI_HASH),
    computeV2Pair(UNI_FACTORY, WETH, DAI, UNI_HASH)
  );
});
