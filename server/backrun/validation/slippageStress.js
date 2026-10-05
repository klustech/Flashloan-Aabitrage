// Gate 5: liquidity and slippage stress.
//  - outputHaircut: analytic — worsen each measured route's final output by N
//    bps and classify; profit floors must turn worsened routes into rejects.
//  - liquidityEffects: builds ForkStateWriter effects that thin each route pool
//    (V2 reserves / V3 liquidity scaled, price unchanged) so the CLI can
//    re-execute a stale quote on degraded state and prove the on-chain profit
//    floor reverts instead of settling a loss.
const { bn } = require("../../bot/units");

const OUTPUT_HAIRCUTS_BPS = [10, 25, 50, 100, 250];
const LIQUIDITY_LEVELS_BPS = [9500, 9000, 7500, 5000, 2500];

function outputHaircut(rows, { minimumWei, haircutsBps = OUTPUT_HAIRCUTS_BPS }) {
  const minimum = bn(minimumWei);
  return rows.filter(r => r.netAfterGasNative.gt(0)).map(row => {
    const finalOut = row.amountIn.add(row.grossBeforeFundingFee), gasCost = row.gasUsed.mul(row.effectiveGasPrice);
    return { triggerHash: row.triggerHash, fundingMode: row.fundingMode, amountIn: row.amountIn.toString(),
      scenarios: haircutsBps.map(h => {
        const worsened = finalOut.mul(10000 - h).div(10000);
        const net = worsened.sub(row.amountIn).sub(row.flashloanFee).sub(gasCost);
        // On chain the executor reverts unless withdrawn profit >= minProfit
        // (which includes the gas budget), so a negative outcome cannot settle.
        return { haircutBps: h, netAfterGas: net.toString(), stillProfitable: net.gte(minimum),
          expectedOutcome: net.gte(minimum) ? "EXECUTE" : "REJECT_OR_REVERT" };
      }) };
  });
}

function liquidityEffects(pools, levelBps) {
  if (!Number.isInteger(levelBps) || levelBps <= 0 || levelBps > 10000) throw new Error("Liquidity level must be 1..10000 bps");
  return pools.map(pool => pool.protocolVersion === 2
    ? { pool: pool.poolAddress, protocolVersion: 2, token0: pool.token0, token1: pool.token1,
        delta0: bn(0), delta1: bn(0), reserves: [bn(pool.reserve0).mul(levelBps).div(10000), bn(pool.reserve1).mul(levelBps).div(10000)] }
    : { pool: pool.poolAddress, protocolVersion: 3, token0: pool.token0, token1: pool.token1, delta0: bn(0), delta1: bn(0),
        sqrtPriceX96: bn(pool.sqrtPriceX96), tick: Number(pool.tick), liquidity: bn(pool.liquidity).mul(levelBps).div(10000) });
}

module.exports = { outputHaircut, liquidityEffects, OUTPUT_HAIRCUTS_BPS, LIQUIDITY_LEVELS_BPS };
