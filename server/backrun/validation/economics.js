// Shared economics for the validation gates. Rows are measured local
// executions produced by executeLocalMode (sweep or historical batch reports).
const { utils } = require("ethers");
const { bn } = require("../../bot/units");

const NUMERIC = ["amountIn", "grossBeforeFundingFee", "flashloanFee", "profitWithdrawn", "gasUsed",
  "effectiveGasPrice", "gasCostNative", "netAfterGasNative", "priorityFeePerGas"];

function normalizeRow(row) {
  const out = { ...row };
  for (const key of NUMERIC) if (row[key] !== undefined && row[key] !== null) out[key] = bn(row[key]);
  if (out.effectiveGasPrice && out.priorityFeePerGas) out.baseFeePerGas = out.effectiveGasPrice.sub(out.priorityFeePerGas);
  return out;
}

function isMeasured(row) {
  return row && row.executionSucceeded === true && row.canonicalReceiptsVerified === true && row.sameBlock === true &&
    row.principalPreserved === true && row.gasUsed !== undefined && row.profitWithdrawn !== undefined;
}

// Accepts a size/fee sweep report ({results:[row]}) or a historical batch
// report ({results:[{executions:[row]}]}); returns normalized measured rows.
function measuredRows(report) {
  const rows = [];
  for (const item of report?.results || []) {
    if (Array.isArray(item.executions)) {
      for (const execution of item.executions)
        if (isMeasured(execution)) rows.push(normalizeRow({ blockNumber: item.blockNumber, transactionIndex: item.transactionIndex,
          triggerHash: item.triggerHash, ...execution }));
    } else if (isMeasured(item)) rows.push(normalizeRow({ blockNumber: report.blockNumber, triggerHash: report.triggerHash, ...item }));
  }
  return rows;
}

const eth = value => utils.formatEther(bn(value));
// Basis-point multiplier on a BigNumber, rounding up for costs.
const scaleUp = (value, bps) => bn(value).mul(bps).add(9999).div(10000);
const scaleDown = (value, bps) => bn(value).mul(bps).div(10000);

module.exports = { measuredRows, normalizeRow, isMeasured, eth, scaleUp, scaleDown };
