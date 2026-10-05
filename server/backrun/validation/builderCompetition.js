// Gate 4: builder competition / profit haircut. How much of each measured
// opportunity can be bid away before the trade stops being rational, and does
// the production decision refuse bids that would leave less than the minimum.
const { bn } = require("../../bot/units");
const { productionDecision } = require("./decisionHarness");

const BUILDER_SHARES_BPS = [0, 1000, 2500, 5000, 7500, 9000, 9500];

function haircutRow(row, { minimumWei, sharesBps = BUILDER_SHARES_BPS }) {
  const minimum = bn(minimumWei);
  const baseGasCost = row.gasUsed.mul(row.baseFeePerGas);
  // Surplus available to split with the builder: after flash fee and base gas.
  const surplus = row.grossBeforeFundingFee.sub(row.flashloanFee).sub(baseGasCost);
  const scenarios = sharesBps.map(share => {
    const builderPayment = surplus.gt(0) ? surplus.mul(share).div(10000) : bn(0);
    const retained = surplus.sub(builderPayment);
    return { builderShareBps: share, builderPayment: builderPayment.toString(), retainedProfit: retained.toString(),
      stillProfitable: retained.gte(minimum) };
  });
  const maxCompetitiveShareBps = surplus.gt(minimum) ? surplus.sub(minimum).mul(10000).div(surplus).toNumber() : 0;
  return { triggerHash: row.triggerHash, blockNumber: row.blockNumber, fundingMode: row.fundingMode, amountIn: row.amountIn.toString(),
    grossOpportunity: row.grossBeforeFundingFee.toString(), flashloanFee: row.flashloanFee.toString(),
    gasCost: baseGasCost.toString(), surplus: surplus.toString(), scenarios, maxCompetitiveShareBps };
}

// Production invariant: with any configured builder share, prepare() either
// rejects or leaves retained net >= minimum.
async function bidInvariant(row, { minimumWei, profile, sharesBps = BUILDER_SHARES_BPS, decide = productionDecision }) {
  const checks = [];
  for (const share of sharesBps.filter(s => s <= 5000)) { // profile validation caps the configured share at 5000
    const decision = await decide({ grossProfitWei: row.grossBeforeFundingFee, fundingCostWei: row.flashloanFee,
      estimatedGas: row.gasUsed, baseFeePerGas: row.baseFeePerGas, minimumWei,
      maxBuilderShareBps: share, gasCeilingGwei: profile.gasCeilingGwei, maxGasUnits: profile.maxGasUnits });
    const retained = decision.accepted ? bn(decision.economics.expectedNetProfit) : null;
    checks.push({ builderShareBps: share, accepted: decision.accepted, reason: decision.reason,
      expectedRetained: retained?.toString() ?? null, violates: decision.accepted && retained.lt(minimumWei) });
  }
  return { checks, passed: checks.every(c => !c.violates) };
}

async function builderCompetition(rows, options) {
  const results = [];
  for (const row of rows.filter(r => r.netAfterGasNative.gt(0)))
    results.push({ ...haircutRow(row, options), invariant: await bidInvariant(row, options) });
  return { kind: "BUILDER_COMPETITION", sharesBps: options.sharesBps || BUILDER_SHARES_BPS, results,
    passed: results.length > 0 && results.every(r => r.invariant.passed), reason: results.length ? null : "no_profitable_measured_rows" };
}

module.exports = { builderCompetition, haircutRow, bidInvariant, BUILDER_SHARES_BPS };
