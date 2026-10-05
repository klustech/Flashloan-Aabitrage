// Gate 2: loan-size optimisation. Proves the selected size maximises measured
// net profit rather than assuming a bigger borrow earns proportionally more.
const { bn } = require("../../bot/units");
const { eth } = require("./economics");

const DEFAULT_TOLERANCE_BPS = 9500; // selected net >= 95% of best measured net

function sizeCurve(rows, { fundingMode, priorityFeeBps = 10000 } = {}) {
  const byAmount = new Map();
  for (const row of rows) {
    if (row.fundingMode !== fundingMode || (row.priorityFeeBps ?? 10000) !== priorityFeeBps) continue;
    const key = row.amountIn.toString();
    if (!byAmount.has(key) || row.netAfterGasNative.gt(byAmount.get(key).netAfterGasNative)) byAmount.set(key, row);
  }
  return [...byAmount.values()].sort((a, b) => (a.amountIn.lt(b.amountIn) ? -1 : 1));
}

function analyzeSizeCurve(rows, { fundingMode, priorityFeeBps = 10000, selectedAmount, toleranceBps = DEFAULT_TOLERANCE_BPS } = {}) {
  const points = sizeCurve(rows, { fundingMode, priorityFeeBps });
  if (!points.length) return { fundingMode, points: 0, passed: false, reason: "no_measured_sizes" };
  let best = 0;
  points.forEach((p, i) => { if (p.netAfterGasNative.gt(points[best].netAfterGasNative)) best = i; });
  const optimal = points[best], next = points[best + 1];
  const profitable = points.filter(p => p.netAfterGasNative.gt(0));
  const firstUnprofitable = points.slice(best + 1).find(p => p.netAfterGasNative.lte(0)) || null;
  const result = {
    fundingMode, priorityFeeBps, points: points.length,
    curve: points.map(p => ({ amountIn: p.amountIn.toString(), amountWeth: eth(p.amountIn), netAfterGasNative: p.netAfterGasNative.toString(),
      netEth: eth(p.netAfterGasNative), gasUsed: p.gasUsed.toString() })),
    optimalAmount: optimal.amountIn.toString(), optimalNetProfit: optimal.netAfterGasNative.toString(),
    marginalProfitAtNextSize: next ? next.netAfterGasNative.sub(optimal.netAfterGasNative).toString() : null,
    maximumProfitableAmount: profitable.length ? profitable.at(-1).amountIn.toString() : null,
    firstUnprofitableAmount: firstUnprofitable ? firstUnprofitable.amountIn.toString() : null,
    // A grid whose best point is the largest size never showed the falling
    // side of the curve; the optimum may lie beyond it.
    optimumAtGridEdge: best === points.length - 1,
    bestIsProfitable: optimal.netAfterGasNative.gt(0),
  };
  if (selectedAmount === undefined || selectedAmount === null) {
    return { ...result, selection: null, passed: false, reason: "engine_selected_amount_not_recorded" };
  }
  const selected = points.find(p => p.amountIn.eq(selectedAmount));
  if (!selected) return { ...result, selection: { selectedAmount: bn(selectedAmount).toString() }, passed: false,
    reason: "engine_selected_amount_not_in_measured_grid" };
  const bestNet = optimal.netAfterGasNative, selNet = selected.netAfterGasNative;
  const withinTolerance = bestNet.lte(0) ? selNet.gte(bestNet) : selNet.mul(10000).gte(bestNet.mul(toleranceBps));
  return { ...result, selection: { selectedAmount: selected.amountIn.toString(), selectedNetProfit: selNet.toString(),
    ratioBps: bestNet.gt(0) ? selNet.mul(10000).div(bestNet).toNumber() : null, toleranceBps, withinTolerance },
    passed: withinTolerance && !result.optimumAtGridEdge,
    reason: !withinTolerance ? "selected_size_below_tolerance" : result.optimumAtGridEdge ? "optimum_at_grid_edge_extend_grid" : null };
}

module.exports = { sizeCurve, analyzeSizeCurve, DEFAULT_TOLERANCE_BPS };
