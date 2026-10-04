const { randomUUID } = require("crypto");
const { bn, serialize } = require("../bot/units");
const { evidenceFingerprint } = require("./readiness");
const { percentile } = require("./service");
function quantiles(values) {
  const sorted = values.map(bn).sort((a,b) => a.lt(b)?-1:a.gt(b)?1:0);
  return Object.fromEntries([25,50,75,95].map(p => ["p"+p, sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p/100)-1)].toString():null]));
}
class HistoricalBenchmark {
  constructor(profile) {
    this.profile = profile; this.rows = []; this.blocks = new Set(); this.triggers = new Set();
    this.stats = { transactionsExamined: 0, decodedTriggers: 0, affectedPools: 0, candidateRoutes: 0, rejected: {}, gasNative: bn(0),
      builderNative: bn(0), capital: 0, flashloan: 0, fullExecutorSimulations: 0 };
  }
  reject(reason) { this.stats.rejected[reason] = (this.stats.rejected[reason] || 0) + 1; }
  record(row) {
    if (!row.orderedSimulation || !row.canonicalReplayVerified) throw new Error("Benchmark requires canonical ordered execution evidence");
    this.rows.push(serialize(row)); this.triggers.add(row.triggerHash); this.stats.fullExecutorSimulations++;
    if (row.capitalViable) this.stats.capital++;
    if (row.flashViable) this.stats.flashloan++;
    this.stats.gasNative = this.stats.gasNative.add(row.gasNative);
    this.stats.builderNative = this.stats.builderNative.add(row.builderNative);
  }
  report({ startBlock, endBlock, startedTimestamp, endedTimestamp, complete, evaluatedTriggers, totalTrackedTriggers }) {
    const durationMs = (endedTimestamp - startedTimestamp) * 1000;
    const byToken = {}, dexPairs = {}, byHops = {}, profitable = this.rows.filter(r => bn(r.netNative).gt(0));
    const distinct = new Set(profitable.map(r => r.triggerHash)).size;
    for (const row of this.rows) {
      const t = byToken[row.symbol] || (byToken[row.symbol] = { count: 0, gross: bn(0), capitalNet: bn(0), flashNet: bn(0) });
      t.count++; t.gross = t.gross.add(row.grossProfit); t.capitalNet = t.capitalNet.add(row.capitalNet); t.flashNet = t.flashNet.add(row.flashNet);
      dexPairs[row.dexPair] = (dexPairs[row.dexPair] || 0) + 1; byHops[row.hops] = (byHops[row.hops] || 0) + 1;
    }
    // Select at most one simulated opportunity per trigger. Do not sum
    // mutually exclusive routes/sizes or opportunities consuming same capital.
    const capture = new Map();
    for (const row of profitable) if (!capture.has(row.triggerHash) || bn(row.netNative).gt(capture.get(row.triggerHash).netNative)) capture.set(row.triggerHash, row);
    const netNative = [...capture.values()].reduce((s,r)=>s.add(r.netNative),bn(0));
    const coverageComplete = complete && evaluatedTriggers === totalTrackedTriggers && this.blocks.size === endBlock-startBlock+1;
    return serialize({ id: randomUUID(), profileFingerprint: evidenceFingerprint(this.profile), kind: "CANONICAL_PREFIX_EXECUTOR_BENCHMARK",
      startBlock, endBlock, durationMs, blocksExamined: this.blocks.size, ...this.stats, byToken, dexPairs, byHops,
      evaluatedTriggers, totalTrackedTriggers, coverageComplete, distinctProfitableTriggers: distinct,
      netNative, netIsUpperBound: true, captureAssumption: "one opportunity per trigger; concurrent capital/competition not modelled",
      opportunityFrequencyPerDay: durationMs > 0 ? distinct * 86400000 / durationMs : 0,
      netProfitQuantilesNative: quantiles([...capture.values()].map(r=>r.netNative)),
      capitalRequiredByToken: Object.fromEntries(Object.keys(byToken).map(s=>[s,quantiles(profitable.filter(r=>r.symbol===s&&r.fundingMode==="CAPITAL").map(r=>r.amount))])),
      latency: { medianMs: percentile(this.rows.map(r=>r.latencyMs),.5), p95Ms: percentile(this.rows.map(r=>r.latencyMs),.95) },
      measuredInfrastructureLatency: true, passed: coverageComplete && durationMs >= 7 * 86400000 && distinct >= 2 &&
        this.stats.fullExecutorSimulations > 0 && netNative.gt(0), recordedAt: Date.now() });
  }
}
module.exports = { HistoricalBenchmark, quantiles };
