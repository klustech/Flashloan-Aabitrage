// Gate 3: gas stress. For each measured profitable execution, re-price gas at
// hostile multiples and inflated usage, and check two things:
//  1. economics: which scenarios stay PROFITABLE / MARGINAL / REJECT;
//  2. production safety: BackrunTransactionBuilder.prepare never accepts a
//     scenario whose realised net (at the stressed price and usage) is below
//     the configured minimum.
const { bn } = require("../../bot/units");
const { productionDecision } = require("./decisionHarness");

const PRICE_MULTIPLIERS_BPS = [5000, 10000, 15000, 20000, 30000, 50000, 100000];
const USAGE_MULTIPLIERS_BPS = [10000, 11000, 12000, 15000];

function classify(net, minimum) { return net.gte(minimum) ? "PROFITABLE" : net.gt(0) ? "MARGINAL" : "REJECT"; }

async function stressRow(row, { minimumWei, profile, priceBps = PRICE_MULTIPLIERS_BPS, usageBps = USAGE_MULTIPLIERS_BPS, decide = productionDecision }) {
  const minimum = bn(minimumWei), scenarios = [];
  // Pre-gas surplus actually withdrawn (already net of any flash fee).
  const preGas = row.profitWithdrawn;
  for (const p of priceBps) for (const u of usageBps) {
    const baseFee = row.baseFeePerGas.mul(p).div(10000);
    // prepare() sees the measured estimate and the stressed base fee; the
    // transaction then actually uses usage-multiplied gas (estimation error).
    const decision = await decide({ grossProfitWei: row.grossBeforeFundingFee, fundingCostWei: row.flashloanFee,
      estimatedGas: row.gasUsed, baseFeePerGas: baseFee, minimumWei: minimum,
      maxBuilderShareBps: profile.maxBuilderShareBps, gasCeilingGwei: profile.gasCeilingGwei, maxGasUnits: profile.maxGasUnits });
    const actualGas = row.gasUsed.mul(u).add(9999).div(10000);
    let realisedNet = null, outOfGas = false, unsafe = false;
    if (decision.accepted) {
      const tx = decision.transaction, priority = bn(tx.maxPriorityFeePerGas);
      const price = baseFee.add(priority).lt(tx.maxFeePerGas) ? baseFee.add(priority) : bn(tx.maxFeePerGas);
      outOfGas = actualGas.gt(tx.gasLimit); // reverts; canRevert:false keeps it out of the block
      realisedNet = preGas.sub(actualGas.mul(price));
      unsafe = !outOfGas && realisedNet.lt(minimum);
    } else {
      realisedNet = preGas.sub(actualGas.mul(baseFee.add(row.priorityFeePerGas.mul(p).div(10000))));
    }
    scenarios.push({ priceMultiplierBps: p, usageMultiplierBps: u, actualGas: actualGas.toString(),
      baseFeePerGas: baseFee.toString(), realisedNet: realisedNet.toString(), classification: classify(realisedNet, minimum),
      productionAccepted: decision.accepted, productionReason: decision.reason, outOfGasRevert: outOfGas, unsafe });
  }
  return { triggerHash: row.triggerHash, blockNumber: row.blockNumber, fundingMode: row.fundingMode, amountIn: row.amountIn.toString(),
    scenarios, unsafeScenarios: scenarios.filter(s => s.unsafe).length,
    // The safety property: every accepted scenario realises at least minimum.
    passed: scenarios.every(s => !s.unsafe) };
}

async function gasStress(rows, options) {
  const results = [];
  for (const row of rows.filter(r => r.netAfterGasNative.gt(0))) results.push(await stressRow(row, options));
  return { kind: "GAS_STRESS", rowsStressed: results.length, priceMultipliersBps: options.priceBps || PRICE_MULTIPLIERS_BPS,
    usageMultipliersBps: options.usageBps || USAGE_MULTIPLIERS_BPS, results,
    unsafeScenarios: results.reduce((s, r) => s + r.unsafeScenarios, 0),
    passed: results.length > 0 && results.every(r => r.passed), reason: results.length ? null : "no_profitable_measured_rows" };
}

module.exports = { gasStress, stressRow, classify, PRICE_MULTIPLIERS_BPS, USAGE_MULTIPLIERS_BPS };
