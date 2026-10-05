// Gate 6: CAPITAL vs FLASH_LOAN parity. The same route, amount and fee must
// produce the same swap output in both modes; the only differences allowed
// are the flash-loan fee and genuinely different gas.
//   capitalNet - flashNet == flashFee + (flashGas - capitalGas) * gasPrice
function pairKey(row) { return [row.triggerHash, row.blockNumber, row.amountIn.toString(), row.priorityFeeBps ?? 10000].join(":"); }

function fundingParity(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = pairKey(row);
    groups.set(key, { ...(groups.get(key) || {}), [row.fundingMode]: row });
  }
  const pairs = [];
  for (const [key, g] of groups) {
    if (!g.CAPITAL || !g.FLASH_LOAN) continue;
    const c = g.CAPITAL, f = g.FLASH_LOAN, problems = [];
    if (!c.grossBeforeFundingFee.eq(f.grossBeforeFundingFee)) problems.push("swap output differs between funding modes");
    if (!c.flashloanFee.isZero()) problems.push("CAPITAL charged a flash-loan fee");
    if (f.flashloanFee.lte(0)) problems.push("FLASH_LOAN recorded no flash-loan fee");
    if (!c.effectiveGasPrice.eq(f.effectiveGasPrice)) problems.push("different gas price; parity identity not applicable");
    if (!c.principalPreserved || !f.principalPreserved) problems.push("principal not preserved");
    const explained = f.flashloanFee.add(f.gasUsed.sub(c.gasUsed).mul(c.effectiveGasPrice));
    const difference = c.netAfterGasNative.sub(f.netAfterGasNative);
    if (!difference.eq(explained)) problems.push("net difference not explained by flash fee and gas");
    pairs.push({ key, triggerHash: c.triggerHash, blockNumber: c.blockNumber, amountIn: c.amountIn.toString(),
      capitalGas: c.gasUsed.toString(), flashGas: f.gasUsed.toString(), flashFee: f.flashloanFee.toString(),
      capitalNet: c.netAfterGasNative.toString(), flashNet: f.netAfterGasNative.toString(),
      difference: difference.toString(), explainedDifference: explained.toString(), problems, passed: problems.length === 0 });
  }
  return { kind: "FUNDING_PARITY", pairs, passed: pairs.length > 0 && pairs.every(p => p.passed),
    reason: pairs.length ? null : "no_same_state_capital_flash_pairs" };
}

module.exports = { fundingParity };
