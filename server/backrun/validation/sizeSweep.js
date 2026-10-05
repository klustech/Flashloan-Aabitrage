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

// Larger sizes the sweep evaluated and rejected as unprofitable before gas
// (quote below funding cost) are the falling side of the curve even though
// they were never executed.
function rejectedAbove(rejectedAmounts, amount) {
  return (rejectedAmounts || []).map(bn).filter(a => a.gt(amount)).sort((a, b) => (a.lt(b) ? -1 : 1))[0] || null;
}

// The engine's chosen size need not be a grid point. Between two measured
// neighbours, linear interpolation is a lower bound on a concave net curve.
function selectedNet(points, amount) {
  const exact = points.find(p => p.amountIn.eq(amount));
  if (exact) return { net: exact.netAfterGasNative, method: "measured" };
  const upper = points.findIndex(p => p.amountIn.gt(amount));
  if (upper <= 0) return null;
  const a = points[upper - 1], b = points[upper];
  const net = a.netAfterGasNative.add(b.netAfterGasNative.sub(a.netAfterGasNative).mul(bn(amount).sub(a.amountIn)).div(b.amountIn.sub(a.amountIn)));
  return { net, method: "interpolated", between: [a.amountIn.toString(), b.amountIn.toString()] };
}

function analyzeSizeCurve(rows, { fundingMode, priorityFeeBps = 10000, selectedAmount, toleranceBps = DEFAULT_TOLERANCE_BPS, rejectedAmounts = [] } = {}) {
  const points = sizeCurve(rows, { fundingMode, priorityFeeBps });
  if (!points.length) return { fundingMode, priorityFeeBps, points: 0, passed: false, reason: "no_measured_sizes" };
  let best = 0;
  points.forEach((p, i) => { if (p.netAfterGasNative.gt(points[best].netAfterGasNative)) best = i; });
  const optimal = points[best], next = points[best + 1];
  const profitable = points.filter(p => p.netAfterGasNative.gt(0));
  const firstUnprofitable = points.slice(best + 1).find(p => p.netAfterGasNative.lte(0)) || null;
  const rejectedBeyond = best === points.length - 1 ? rejectedAbove(rejectedAmounts, optimal.amountIn) : null;
  const result = {
    fundingMode, priorityFeeBps, points: points.length,
    curve: points.map(p => ({ amountIn: p.amountIn.toString(), amountWeth: eth(p.amountIn), netAfterGasNative: p.netAfterGasNative.toString(),
      netEth: eth(p.netAfterGasNative), gasUsed: p.gasUsed.toString() })),
    optimalAmount: optimal.amountIn.toString(), optimalNetProfit: optimal.netAfterGasNative.toString(),
    marginalProfitAtNextSize: next ? next.netAfterGasNative.sub(optimal.netAfterGasNative).toString() : null,
    maximumProfitableAmount: profitable.length ? profitable.at(-1).amountIn.toString() : null,
    firstUnprofitableAmount: firstUnprofitable ? firstUnprofitable.amountIn.toString() : rejectedBeyond ? rejectedBeyond.toString() : null,
    // A grid whose best point is its largest evaluated size never showed the
    // falling side of the curve; the optimum may lie beyond it.
    optimumAtGridEdge: best === points.length - 1 && !rejectedBeyond,
    bestIsProfitable: optimal.netAfterGasNative.gt(0),
  };
  // Where no size is profitable at this fee, the engine trades nothing and
  // there is no size choice to judge.
  if (!result.bestIsProfitable) return { ...result, selection: null, applicable: false, passed: true, reason: "no_profitable_size_at_fee" };
  if (selectedAmount === undefined || selectedAmount === null)
    return { ...result, selection: null, applicable: true, passed: false, reason: "engine_selected_amount_not_recorded" };
  const estimate = selectedNet(points, selectedAmount);
  if (!estimate) return { ...result, applicable: true, selection: { selectedAmount: bn(selectedAmount).toString() }, passed: false,
    reason: "engine_selected_amount_outside_measured_curve" };
  const bestNet = optimal.netAfterGasNative, selNet = estimate.net;
  const withinTolerance = selNet.mul(10000).gte(bestNet.mul(toleranceBps));
  return { ...result, applicable: true, selection: { selectedAmount: bn(selectedAmount).toString(), selectedNetProfit: selNet.toString(),
    estimate: estimate.method, between: estimate.between, ratioBps: selNet.mul(10000).div(bestNet).toNumber(), toleranceBps, withinTolerance },
    passed: withinTolerance && !result.optimumAtGridEdge,
    reason: !withinTolerance ? "selected_size_below_tolerance" : result.optimumAtGridEdge ? "optimum_at_grid_edge_extend_grid" : null };
}

module.exports = { sizeCurve, analyzeSizeCurve, DEFAULT_TOLERANCE_BPS };
