/**
 * ammMath.js — exact constant-product AMM math + optimal-input sizing.
 *
 * Detection/sizing must account for the bot's OWN price impact: a cycle that is
 * positive at the marginal (spot) rate is usually negative once you trade real
 * size. These helpers compute the true output of a route at a given input using
 * the exact Uniswap-V2 formula (which embeds price impact) and find the
 * profit-maximising input via ternary search (profit is unimodal in size for an
 * AMM arbitrage cycle).
 *
 * Uniswap V3 / Curve / Balancer outputs are approximated here via virtual
 * reserves; the bot still re-quotes the chosen route exactly on-chain
 * (QuoterV2 / get_dy / queryBatchSwap) before execution, and the on-chain
 * profit-or-revert guard is the final backstop.
 */
const { BigNumber } = require("ethers");

const ZERO = BigNumber.from(0);

/**
 * Exact Uniswap-V2 output for `amountIn` given oriented reserves and a fee.
 * @param {BigNumberish} amountIn
 * @param {BigNumberish} reserveIn  reserve of the input token
 * @param {BigNumberish} reserveOut reserve of the output token
 * @param {number} feeBps fee in basis points (30 = 0.30%)
 */
function getAmountOutV2(amountIn, reserveIn, reserveOut, feeBps = 30) {
  const aIn = BigNumber.from(amountIn);
  const rIn = BigNumber.from(reserveIn);
  const rOut = BigNumber.from(reserveOut);
  if (aIn.lte(0) || rIn.lte(0) || rOut.lte(0)) return ZERO;
  const feeMul = BigNumber.from(10000 - feeBps);
  const amountInWithFee = aIn.mul(feeMul);
  const numerator = amountInWithFee.mul(rOut);
  const denominator = rIn.mul(10000).add(amountInWithFee);
  return numerator.div(denominator);
}

/**
 * Output of a full route for a given input. Each hop is used once, so reserves
 * are the pre-trade reserves (price impact is captured per hop by getAmountOutV2).
 * @param {Array<{reserveIn,reserveOut,feeBps}>} hops oriented in swap direction
 * @param {BigNumberish} amountIn
 * @returns {BigNumber} final output amount (0 if any hop dies)
 */
function quoteRouteFromReserves(hops, amountIn) {
  let amt = BigNumber.from(amountIn);
  for (const hop of hops) {
    amt = getAmountOutV2(amt, hop.reserveIn, hop.reserveOut, hop.feeBps ?? 30);
    if (amt.lte(0)) return ZERO;
  }
  return amt;
}

/**
 * Net profit (signed) of borrowing `amountIn`, running the route, and repaying
 * principal + flash-loan premium + gas, all denominated in the borrow token.
 */
function netProfit(hops, amountIn, premiumBps = 9, gasCostWei = 0) {
  const aIn = BigNumber.from(amountIn);
  const out = quoteRouteFromReserves(hops, aIn);
  const debt = aIn.mul(10000 + premiumBps).div(10000);
  return out.sub(debt).sub(BigNumber.from(gasCostWei || 0));
}

/**
 * Find the profit-maximising input in (0, maxInput] via ternary search.
 * Profit(x) for an AMM arb cycle rises then falls (impact eventually dominates),
 * so ternary search converges to the optimum.
 * @returns {{input:BigNumber, output:BigNumber, profit:BigNumber}}
 */
function findOptimalInput({
  hops,
  maxInput,
  premiumBps = 9,
  gasCostWei = 0,
  epsilonWei = "1000000000000", // 1e12 wei (~1e-6 token) convergence band
}) {
  let lo = BigNumber.from(1);
  let hi = BigNumber.from(maxInput);
  const eps = BigNumber.from(epsilonWei);
  if (hi.lte(lo)) {
    return { input: ZERO, output: ZERO, profit: ZERO };
  }
  // Cap iterations defensively; the epsilon band normally ends it sooner.
  for (let i = 0; i < 200 && hi.sub(lo).gt(eps); i++) {
    const third = hi.sub(lo).div(3);
    if (third.lte(0)) break;
    const m1 = lo.add(third);
    const m2 = hi.sub(third);
    const p1 = netProfit(hops, m1, premiumBps, gasCostWei);
    const p2 = netProfit(hops, m2, premiumBps, gasCostWei);
    if (p1.lt(p2)) {
      lo = m1;
    } else {
      hi = m2;
    }
  }
  const input = lo.add(hi).div(2);
  const output = quoteRouteFromReserves(hops, input);
  const profit = netProfit(hops, input, premiumBps, gasCostWei);
  return { input, output, profit };
}

/**
 * Uniswap-V3 virtual reserves from sqrtPriceX96 + liquidity (token0/token1 are
 * address-sorted). Lets V3 pools be approximated with the V2 formula for sizing.
 */
function v3VirtualReserves(sqrtPriceX96, liquidity) {
  const Q96 = BigNumber.from(2).pow(96);
  const sp = BigNumber.from(sqrtPriceX96);
  const L = BigNumber.from(liquidity);
  if (sp.lte(0) || L.lte(0)) return { reserve0: ZERO, reserve1: ZERO };
  return {
    reserve0: L.mul(Q96).div(sp), // token0 (lower address)
    reserve1: L.mul(sp).div(Q96), // token1 (higher address)
  };
}

module.exports = {
  getAmountOutV2,
  quoteRouteFromReserves,
  netProfit,
  findOptimalInput,
  v3VirtualReserves,
};
