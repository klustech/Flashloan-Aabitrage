// PAPER economic projection (blueprint §25-26): conservative, base and
// optimistic retained net per day after capture, inclusion, builder
// competition, gas and infrastructure, annualized last. Inputs:
//   PAPER window: runtime/backrun/burn-in.json (BACKRUN_BURN_IN_PATH)
//   MONTHLY_INFRASTRUCTURE_COST_USD  archive + WebSocket RPC, server, database,
//                                    monitoring, relay infrastructure, backup provider
//   ETH_USD_PRICE                    conversion for the infrastructure cost
//   BACKRUN_RISK_MARGIN_BPS          margin over infrastructure (default 2000)
//   BACKRUN_PROJECTION_ASSUMPTIONS   optional JSON file overriding scenario assumptions
// Writes runtime/backrun/economic-projection.json (BACKRUN_PROJECTION_PATH).
const fs = require("fs");
const { environment, save } = require("./backrun-context");
const { BackrunEvidence } = require("../server/backrun/evidence");
const { evidenceFingerprint } = require("../server/backrun/readiness");
const { SCENARIOS, infrastructure, project } = require("../server/backrun/economicProjection");

function buildProjection(profile, paper, env = process.env) {
  const infra = infrastructure({ monthlyUsd: Number(env.MONTHLY_INFRASTRUCTURE_COST_USD), ethUsd: Number(env.ETH_USD_PRICE),
    riskMarginBps: Number(env.BACKRUN_RISK_MARGIN_BPS || 2000) });
  let scenarios = SCENARIOS;
  if (env.BACKRUN_PROJECTION_ASSUMPTIONS) {
    const overrides = JSON.parse(fs.readFileSync(env.BACKRUN_PROJECTION_ASSUMPTIONS, "utf8"));
    scenarios = Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, { ...v, ...(overrides[k] || {}) }]));
  }
  const result = project({ durationMs: paper.continuousMs, opportunities: paper.profitable,
    totalNetNative: paper.totalHypotheticalNetNative, totalGasNative: paper.totalHypotheticalGasNative }, infra, scenarios);
  return { kind: "BACKRUN_ECONOMIC_PROJECTION", profileFingerprint: evidenceFingerprint(profile), source: "PAPER",
    paperPassed: paper.passed, createdAt: Date.now(), ...result,
    note: "Assumptions are operator inputs for the risk review; only the observed figures are measurements." };
}

async function main() {
  const { profile } = environment();
  const paper = new BackrunEvidence(profile, { file: process.env.BACKRUN_BURN_IN_PATH || "runtime/backrun/burn-in.json" }).report();
  const projection = buildProjection(profile, paper);
  save(process.env.BACKRUN_PROJECTION_PATH || "runtime/backrun/economic-projection.json", projection);
  console.log(JSON.stringify(projection, null, 2));
  if (!projection.economicallyReady) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildProjection };
