const { utils } = require("ethers");
const { bn } = require("../bot/units");
const DEFAULT_AMOUNTS = ["0.01", "0.03", "0.06", "0.1", "0.2", "0.5", "1"];
function sweepOptions(profile, fixtureAmount, env = process.env) {
  const cap = utils.parseEther(profile.backrun.maxAmountBySymbol.WETH || "1");
  if (cap.lte(0)) throw new Error("Positive WETH sweep cap required");
  const custom = env.BACKRUN_SWEEP_AMOUNTS_WETH;
  const values = custom ? custom.split(",").map(value => value.trim()) : DEFAULT_AMOUNTS;
  if (!values.length || values.length > 12) throw new Error("Sweep requires 1..12 WETH sizes");
  const points = new Map();
  for (const value of values) {
    if (value.length > 40 || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid WETH sweep amount");
    const amount = utils.parseEther(value);
    if (amount.lte(0)) throw new Error("Sweep amounts must be positive");
    if (amount.gt(cap)) { if (custom) throw new Error("Sweep amount exceeds BACKRUN_MAX_AMOUNT_WETH"); else continue; }
    points.set(amount.toString(), amount);
  }
  if (!custom && bn(fixtureAmount).lte(cap)) points.set(bn(fixtureAmount).toString(), bn(fixtureAmount));
  if (!points.size) throw new Error("No sweep sizes within the configured WETH cap");
  const priorities = [...new Set((env.BACKRUN_SWEEP_PRIORITY_BPS || "0,2500,5000,10000").split(",").map(value => {
    if (!/^\d+$/.test(value.trim())) throw new Error("Invalid sweep priority multiplier");
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || number > 20000) throw new Error("Sweep priority multiplier outside 0..20000 bps");
    return number;
  }))].sort((a, b) => a - b);
  if (!priorities.length || priorities.length > 4 || !priorities.includes(10000))
    throw new Error("Sweep requires 1..4 priority multipliers including 10000 (historical fee)");
  return { amounts: [...points.values()].sort((a, b) => a.lt(b) ? -1 : 1), priorities, cap };
}
function summarizeSweep(rows) {
  const measured = rows.filter(row => row.status === "MEASURED" && row.executionSucceeded && row.canonicalReceiptsVerified && row.sameBlock);
  const best = filter => {
    const result = {};
    for (const row of measured.filter(filter)) {
      if (!result[row.fundingMode] || bn(row.netAfterGasNative).gt(result[row.fundingMode].netAfterGasNative))
        result[row.fundingMode] = row;
    }
    return result;
  };
  return { measuredExecutions: measured.length, quoteRejected: rows.filter(row => row.status === "QUOTE_REJECTED").length,
    technicalErrors: rows.filter(row => row.status === "ERROR").length,
    profitableAtHistoricalFee: measured.filter(row => row.priorityFeeBps === 10000 && row.netPositive).length,
    bestAtHistoricalFee: best(row => row.priorityFeeBps === 10000), bestAcrossTestedFees: best(() => true),
    resultsAreMutuallyExclusive: true, profitsMustNotBeSummed: true,
    lowerBidsDoNotProveInclusion: true };
}
module.exports = { sweepOptions, summarizeSweep };
