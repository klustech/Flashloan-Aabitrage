// PAPER economic analysis (blueprint §25-26). Not "paper profit × 365":
// observed hypothetical economics pass through explicit capture, inclusion,
// builder-competition and gas assumptions, then infrastructure cost, and are
// annualized last. The assumptions are operator inputs reviewed in the risk
// review; only the observed figures are measurements.
const { utils } = require("ethers");
const { bn } = require("../bot/units");

const DAY = 86400000;
const SCENARIOS = Object.freeze({
  // lower capture, more builder competition, higher gas, lower inclusion
  conservative: { capture: 0.25, inclusionRate: 0.10, builderHaircutBps: 5000, gasMultiplier: 1.5 },
  // observed PAPER economics, moderate inclusion
  base: { capture: 0.5, inclusionRate: 0.30, builderHaircutBps: 2500, gasMultiplier: 1.0 },
  // strong inclusion, little builder competition
  optimistic: { capture: 0.8, inclusionRate: 0.60, builderHaircutBps: 1000, gasMultiplier: 1.0 },
});

const ether = wei => Number(utils.formatEther(bn(wei || 0)));
const round = (x, digits = 6) => Number.isFinite(x) ? Number(x.toFixed(digits)) : null;

// MONTHLY_INFRASTRUCTURE_COST_USD covers archive RPC, WebSocket RPC, server,
// database, monitoring, relay infrastructure and the backup provider.
function infrastructure({ monthlyUsd, ethUsd, riskMarginBps = 2000 }) {
  if (!(monthlyUsd >= 0)) throw new Error("MONTHLY_INFRASTRUCTURE_COST_USD required");
  if (!(ethUsd > 0)) throw new Error("ETH_USD_PRICE required to convert infrastructure cost");
  const dailyUsd = monthlyUsd * 12 / 365, minimumRequiredDailyNetUsd = dailyUsd * (1 + riskMarginBps / 10000);
  return { monthlyUsd, ethUsd, riskMarginBps, dailyUsd: round(dailyUsd, 2), dailyNative: round(dailyUsd / ethUsd),
    minimumRequiredDailyNetUsd: round(minimumRequiredDailyNetUsd, 2), minimumRequiredDailyNetNative: round(minimumRequiredDailyNetUsd / ethUsd) };
}

// observed: { durationMs, opportunities, totalNetNative, totalGasNative } (wei strings)
function project(observed, infra, scenarios = SCENARIOS) {
  const days = observed.durationMs / DAY, n = observed.opportunities;
  if (!(days > 0)) throw new Error("Observation window required");
  const perDay = n / days, avgNet = n ? ether(observed.totalNetNative) / n : 0, avgGas = n ? ether(observed.totalGasNative) / n : 0;
  const out = {};
  for (const [name, a] of Object.entries(scenarios)) {
    const perTrade = avgNet * (1 - a.builderHaircutBps / 10000) - avgGas * (a.gasMultiplier - 1);
    const includedPerDay = perDay * a.capture * a.inclusionRate;
    const tradingNative = includedPerDay * perTrade, retainedNative = tradingNative - infra.dailyNative;
    out[name] = { assumptions: a, opportunitiesPerDay: round(perDay, 3), includedTradesPerDay: round(includedPerDay, 3),
      retainedPerTradeNative: round(perTrade), tradingNetPerDayNative: round(tradingNative), infrastructurePerDayNative: infra.dailyNative,
      retainedPerDayNative: round(retainedNative), retainedPerDayUsd: round(retainedNative * infra.ethUsd, 2),
      annualizedRetainedNative: round(retainedNative * 365, 4), annualizedRetainedUsd: round(retainedNative * infra.ethUsd * 365, 0),
      // §26: expected retained net must exceed infrastructure plus risk margin.
      economicallyViable: tradingNative >= infra.minimumRequiredDailyNetNative };
  }
  return { observed: { days: round(days, 3), opportunities: n, opportunitiesPerDay: round(perDay, 3),
    averageNetNative: round(avgNet), averageGasNative: round(avgGas) }, infrastructure: infra, scenarios: out,
    economicallyReady: out.base?.economicallyViable === true && out.conservative?.tradingNetPerDayNative > 0 };
}

module.exports = { SCENARIOS, infrastructure, project };
