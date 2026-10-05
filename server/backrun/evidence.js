// PAPER burn-in evidence (blueprint §20-24, §43). One continuous window of
// unsigned PAPER operation under one configuration. The window resets on the
// deterministic continuity rules below; counters describe the current window
// only, while gaps, resets and configurationChanges persist across windows.
const fs = require("fs");
const path = require("path");
const { evidenceFingerprint } = require("./readiness");
const { rejectionCode } = require("./rejectionTaxonomy");
const { EXECUTOR_VERSION } = require("../config/executorVersion");
const { bn } = require("../bot/units");

const DAY = 86400000;
// Continuity policy (docs/commissioning/PAPER_PHASE.md). Every reset is
// recorded with its reason. Transient RPC errors are counted, not resets:
// each decision re-reads full canonical state, so nothing carries over.
const CONTINUITY = Object.freeze({
  requiredMs: 7 * DAY,
  heartbeatGapMs: 30000, // process stopped or stalled: no heartbeat for 30 s
  sourceOutageGraceMs: 60000, // order-flow source may reconnect within 60 s
  headStallMs: 60000, // chain heads must advance at least every 60 s
});
const WINDOW_LIMITS = { latencySamples: 5000, netSamples: 5000, opportunities: 200, triggerHashes: 10000, resets: 100 };

function emptyWindow() {
  return { continuousSince: null, continuousMs: 0, headsObserved: 0, triggersObserved: 0, triggersDecoded: 0, triggersEvaluated: 0,
    candidatesGenerated: 0, simulations: 0, profitable: 0, capitalPositive: 0, flashloanPositive: 0,
    totalHypotheticalNetNative: "0", totalHypotheticalGasNative: "0", bestHypotheticalNetNative: "0", netSamples: [], latencySamples: [], latencyOverBudget: 0,
    sourceDisconnects: 0, rpcErrors: 0, forkErrors: 0, relayErrors: 0, rejections: {}, opportunities: [], recentTriggerHashes: [],
    sourceDownSince: null };
}

function rank(values, p) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.ceil(v.length * p) - 1)];
}
function medianBn(values) {
  if (!values.length) return null;
  const v = values.map(bn).sort((a, b) => (a.lt(b) ? -1 : a.gt(b) ? 1 : 0));
  return v[Math.floor((v.length - 1) / 2)].toString();
}
const push = (list, value, limit) => { list.push(value); if (list.length > limit) list.splice(0, list.length - limit); };

// §22: what each PAPER candidate preserves. No raw transactions.
function opportunity(row, rejectReason = null) {
  return { timestamp: row.updatedAt || Date.now(), headNumber: row.parentBlock ?? null, headHash: row.parentHash ?? null,
    triggerHash: row.triggerHash, orderflowSource: row.triggerSource || null, affectedPools: row.affectedPools || [],
    candidateRoutes: row.candidateRoutes ?? null, selectedRoute: row.candidateId || null,
    dexPath: (row.route?.legs || []).map(l => l.dex).join(" → ") || null, borrowToken: row.token?.symbol || row.borrowToken || null,
    borrowAmount: row.inputAmount ?? null, fundingMode: row.fundingMode || null, grossProfit: row.grossProfit ?? null,
    flashloanFee: row.flashPremium ?? null, estimatedGas: row.gasEstimate ?? null,
    estimatedGasCost: row.economics?.estimatedGasCostBorrow ?? row.economics?.estimatedGasCostNative ?? null,
    builderBudget: row.builderAllowance ?? null, expectedRetainedProfit: row.economics?.expectedNetProfit ?? null,
    expectedRetainedNative: row.netNative ?? null, rejectReason, rejectCode: rejectReason ? rejectionCode(rejectReason) : null,
    pipelineLatencyMs: row.latencyMs ?? row.stageClock?.T7 ?? null };
}

class BackrunEvidence {
  constructor(profile, { file = process.env.BACKRUN_BURN_IN_PATH || "runtime/backrun/burn-in.json", now = Date.now } = {}) {
    Object.assign(this, { profile, file, now });
    const fingerprint = evidenceFingerprint(profile);
    let old;
    try { old = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
    if (old?.profileFingerprint === fingerprint && old.schema === 2) this.data = old;
    else {
      this.data = { schema: 2, profileFingerprint: fingerprint, executorVersion: EXECUTOR_VERSION, lastHeartbeat: null,
        signatures: 0, submissions: 0, gaps: 0, configurationChanges: old ? (old.configurationChanges || 0) + 1 : 0,
        resets: old ? [{ at: now(), reason: old.profileFingerprint === fingerprint ? "evidence_schema_upgraded" : "configuration_changed" }] : [],
        observedAt: null, ...emptyWindow() };
    }
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  reset(reason) {
    const d = this.data, now = this.now();
    if (d.continuousSince !== null) {
      push(d.resets, { at: now, reason, continuousMs: d.continuousMs }, WINDOW_LIMITS.resets);
      d.gaps++;
    }
    Object.assign(d, emptyWindow());
  }
  // Deterministic continuity rules, checked in this order on every heartbeat.
  continuityBreak(s, now) {
    const d = this.data;
    if (!s.paper) return "left_paper_mode";
    if (s.signatures) return "signing_occurred";
    if (s.submissions) return "submission_occurred";
    if (d.lastHeartbeat && now - d.lastHeartbeat > CONTINUITY.heartbeatGapMs) return "process_stopped";
    if (s.circuitReason) return `circuit_breaker:${s.circuitReason}`;
    if (s.running === false) return "observer_stopped";
    if (s.dbHealthy === false) return "database_unavailable";
    if (s.headAgeMs !== undefined && !(s.headAgeMs <= CONTINUITY.headStallMs)) return "chain_heads_stalled";
    if (s.sourceConnected === false && d.sourceDownSince !== null && now - d.sourceDownSince > CONTINUITY.sourceOutageGraceMs)
      return "orderflow_disconnected";
    if (s.healthy === false) return "unhealthy";
    return null;
  }
  heartbeat(status) {
    const now = this.now(), d = this.data, s = { signatures: 0, submissions: 0, ...status };
    // Once passed, LIVE operation no longer erases the completed PAPER window.
    if (!s.paper && this.report().passed) return;
    if (s.sourceConnected === false) { if (d.sourceDownSince === null) { d.sourceDownSince = now; d.sourceDisconnects++; } }
    else d.sourceDownSince = null;
    const reason = this.continuityBreak(s, now);
    if (reason) {
      const downSince = d.sourceDownSince; this.reset(reason);
      if (reason !== "orderflow_disconnected") d.sourceDownSince = downSince;
    } else {
      d.continuousSince ??= now; d.continuousMs = now - d.continuousSince;
    }
    d.lastHeartbeat = now; d.signatures = s.signatures; d.submissions = s.submissions; d.observedAt = now; this.save();
  }
  active() { return this.data.continuousSince !== null; }
  observeHead() { if (this.active()) this.data.headsObserved++; }
  observeTrigger({ decoded }) { if (!this.active()) return; this.data.triggersObserved++; if (decoded) this.data.triggersDecoded++; }
  evaluated({ candidates = 0, latencyMs, budgetMs } = {}) {
    if (!this.active()) return;
    const d = this.data; d.triggersEvaluated++; d.candidatesGenerated += candidates;
    if (Number.isFinite(latencyMs)) {
      push(d.latencySamples, latencyMs, WINDOW_LIMITS.latencySamples);
      if (budgetMs && latencyMs > budgetMs) d.latencyOverBudget++;
    }
  }
  record(row) {
    const d = this.data;
    if (!this.active() || row.mode !== "PAPER" || row.status !== "SIMULATED" ||
        !row.simulation?.ordered || row.simulation.signed || row.simulation.submitted ||
        d.recentTriggerHashes.includes(row.triggerHash)) return;
    d.simulations++;
    if (row.economics?.profitable) {
      d.profitable++;
      const comparisons = row.fundingComparisons || { [row.fundingMode]: { viable: true, expectedNetProfit: row.economics.expectedNetProfit } };
      if (comparisons.CAPITAL?.viable && bn(comparisons.CAPITAL.expectedNetProfit || 0).gt(0)) d.capitalPositive++;
      if (comparisons.FLASH_LOAN?.viable && bn(comparisons.FLASH_LOAN.expectedNetProfit || 0).gt(0)) d.flashloanPositive++;
      if (row.netNative !== undefined && row.netNative !== null) {
        d.totalHypotheticalNetNative = bn(d.totalHypotheticalNetNative).add(row.netNative).toString();
        if (bn(row.netNative).gt(d.bestHypotheticalNetNative)) d.bestHypotheticalNetNative = bn(row.netNative).toString();
        push(d.netSamples, bn(row.netNative).toString(), WINDOW_LIMITS.netSamples);
        if (row.economics?.estimatedGasCostNative !== undefined)
          d.totalHypotheticalGasNative = bn(d.totalHypotheticalGasNative).add(row.economics.estimatedGasCostNative).toString();
      }
    }
    push(d.recentTriggerHashes, row.triggerHash, WINDOW_LIMITS.triggerHashes);
    push(d.opportunities, opportunity(row), WINDOW_LIMITS.opportunities);
    this.save();
  }
  rejected(row, reason) {
    if (!this.active() || (row && row.mode && row.mode !== "PAPER")) return;
    const d = this.data, code = rejectionCode(reason);
    d.rejections[code] = (d.rejections[code] || 0) + 1;
    if (code === "RPC_UNHEALTHY") d.rpcErrors++;
    if (code === "STATE_MISMATCH" || /fork/i.test(String(reason))) d.forkErrors++;
    if (code === "RELAY_UNAVAILABLE") d.relayErrors++;
    if (row?.candidateId) push(d.opportunities, opportunity(row, reason), WINDOW_LIMITS.opportunities);
  }
  report() {
    const d = this.data, budgetMs = this.profile.backrun?.latencyBudgetMs;
    const latency = { p50Ms: rank(d.latencySamples, .5), p95Ms: rank(d.latencySamples, .95), p99Ms: rank(d.latencySamples, .99),
      samples: d.latencySamples.length, budgetMs: budgetMs ?? null };
    const checks = {
      continuous: d.continuousMs >= CONTINUITY.requiredMs,
      noSignatures: d.signatures === 0, noSubmissions: d.submissions === 0,
      profitableObserved: d.profitable > 0, capitalObserved: d.capitalPositive > 0,
      latencyWithinBudget: latency.p95Ms !== null && (!budgetMs || latency.p95Ms <= budgetMs),
      executorVersion: d.executorVersion === EXECUTOR_VERSION,
    };
    const { netSamples, latencySamples, recentTriggerHashes, sourceDownSince, ...rest } = d;
    return { ...rest, profitableCandidates: d.profitable, latency, medianHypotheticalNetNative: medianBn(d.netSamples),
      continuityDay: Math.min(7, Math.floor(d.continuousMs / DAY)), continuityPolicy: CONTINUITY,
      flashloanObserved: d.flashloanPositive > 0, checks, passed: Object.values(checks).every(Boolean) };
  }
}
module.exports = { BackrunEvidence, CONTINUITY, opportunity };
