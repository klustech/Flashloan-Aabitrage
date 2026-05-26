// Unit tests for server/scripts/ammMath.js (pure math — no network/solc needed).
// Run: node --test test/unit/ammMath.node.test.js
const test = require("node:test");
const assert = require("node:assert");
const { ethers } = require("ethers");
const {
  getAmountOutV2,
  quoteRouteFromReserves,
  netProfit,
  findOptimalInput,
  v3VirtualReserves,
} = require("../../server/scripts/ammMath");

const U = (n) => ethers.utils.parseUnits(String(n), 18);

test("getAmountOutV2 matches the exact Uniswap V2 0.3% formula", () => {
  // amountIn=10, reserves 1000/1000, 0.3% fee:
  //   out = 10*9970*1000 / (1000*10000 + 10*9970) = 99,700,000 / 10,099,700 = 9
  assert.strictEqual(getAmountOutV2(10, 1000, 1000, 30).toNumber(), 9);
  // Zero / degenerate inputs return 0.
  assert.strictEqual(getAmountOutV2(0, 1000, 1000, 30).toNumber(), 0);
  assert.strictEqual(getAmountOutV2(10, 0, 1000, 30).toNumber(), 0);
});

test("deeper reserves => less price impact (more output per unit in)", () => {
  const shallow = getAmountOutV2(U(100), U(1000), U(1000), 30);
  const deep = getAmountOutV2(U(100), U(1000000), U(1000000), 30);
  // Same 1:1 price, but the deep pool returns closer to the fee-only bound.
  assert.ok(
    deep.gt(shallow),
    "deep pool should return more for the same input"
  );
  assert.ok(deep.lt(U(100)), "output must be below input (fee)");
});

test("a balanced (no-spread) 2-hop cycle is never profitable", () => {
  // Two identical 1:1 pools: round trip loses to fees regardless of size.
  const hops = [
    { reserveIn: U(1_000_000), reserveOut: U(1_000_000), feeBps: 30 },
    { reserveIn: U(1_000_000), reserveOut: U(1_000_000), feeBps: 30 },
  ];
  for (const size of [U(1), U(1000), U(100000)]) {
    assert.ok(
      netProfit(hops, size, 9, 0).lte(0),
      `phantom cycle should not profit at size ${size}`
    );
  }
});

test("a real cross-pool spread is profitable at an optimal size", () => {
  // Pool A prices WETH at ~2000 DAI; Pool B at ~2200 DAI (≈10% spread).
  // Borrow DAI: A: DAI->WETH (cheap), B: WETH->DAI (dear).
  const hops = [
    { reserveIn: U(2_000_000), reserveOut: U(1000), feeBps: 30 }, // DAI->WETH on A
    { reserveIn: U(1000), reserveOut: U(2_200_000), feeBps: 30 }, // WETH->DAI on B
  ];
  const maxInput = U(500_000);
  const { input, output, profit } = findOptimalInput({
    hops,
    maxInput,
    premiumBps: 9,
  });

  assert.ok(profit.gt(0), "expected positive profit on a real 10% spread");
  assert.ok(output.gt(input), "output must exceed input on a profitable arb");
  // The optimum should be an interior point, not pinned at the bounds.
  assert.ok(
    input.gt(U(1)) && input.lt(maxInput),
    "optimal input should be interior"
  );

  // Optimality: profit at the chosen size beats clearly smaller / larger sizes.
  const quarter = input.div(4);
  const quadruple = input.mul(4).gt(maxInput) ? maxInput : input.mul(4);
  assert.ok(
    profit.gte(netProfit(hops, quarter, 9, 0)),
    "optimal should beat a much smaller size"
  );
  assert.ok(
    profit.gte(netProfit(hops, quadruple, 9, 0)),
    "optimal should beat a much larger size (impact dominates)"
  );
});

test("over-borrowing past the optimum reduces profit (price impact)", () => {
  const hops = [
    { reserveIn: U(2_000_000), reserveOut: U(1000), feeBps: 30 },
    { reserveIn: U(1000), reserveOut: U(2_200_000), feeBps: 30 },
  ];
  const { input, profit } = findOptimalInput({
    hops,
    maxInput: U(500_000),
    premiumBps: 9,
  });
  const tooBig = input.mul(10).gt(U(500_000)) ? U(500_000) : input.mul(10);
  assert.ok(
    netProfit(hops, tooBig, 9, 0).lt(profit),
    "10x size should profit less"
  );
});

test("v3VirtualReserves encode price = (sqrtP/2^96)^2", () => {
  // sqrtPriceX96 for price 1.0 is exactly 2^96 -> reserve0 == reserve1.
  const Q96 = ethers.BigNumber.from(2).pow(96);
  const { reserve0, reserve1 } = v3VirtualReserves(Q96, U(1000));
  assert.ok(reserve0.eq(reserve1), "price 1.0 => equal virtual reserves");
  // Degenerate inputs return zero reserves.
  const z = v3VirtualReserves(0, U(1000));
  assert.ok(z.reserve0.eq(0) && z.reserve1.eq(0));
});
