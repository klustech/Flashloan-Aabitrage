const fs = require("fs");
const path = require("path");
const { evidenceFingerprint } = require("./readiness");
class BackrunEvidence {
  constructor(profile, { file = process.env.BACKRUN_BURN_IN_PATH || "runtime/backrun/burn-in.json", now = Date.now } = {}) {
    Object.assign(this, { profile, file, now });
    let old;
    try { old = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
    this.data = old?.profileFingerprint === evidenceFingerprint(profile) ? old : {
      profileFingerprint: evidenceFingerprint(profile), continuousSince: null, lastHeartbeat: null,
      continuousMs: 0, simulations: 0, profitable: 0, signatures: 0, submissions: 0,
      gaps: 0, recentTriggerHashes: [], observedAt: null };
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  heartbeat({ healthy, paper, signatures = 0, submissions = 0 }) {
    const now = this.now(), d = this.data;
    if(!paper&&this.report().passed)return;
    if (!healthy || !paper || signatures || submissions || (d.lastHeartbeat && now - d.lastHeartbeat > 30000)) {
      d.continuousSince = null; d.continuousMs = 0; d.simulations = 0; d.profitable = 0; d.recentTriggerHashes = [];
      d.gaps++;
    }
    if (healthy && paper && !signatures && !submissions) {
      d.continuousSince ??= now; d.continuousMs = now - d.continuousSince;
    }
    d.lastHeartbeat = now; d.signatures = signatures; d.submissions = submissions; d.observedAt = now; this.save();
  }
  record(row) {
    const d = this.data;
    if (d.continuousSince === null || row.mode !== "PAPER" || row.status !== "SIMULATED" ||
        !row.simulation?.ordered || row.simulation.signed || row.simulation.submitted ||
        d.recentTriggerHashes.includes(row.triggerHash)) return;
    d.simulations++; if (row.economics?.profitable) d.profitable++;
    d.recentTriggerHashes.push(row.triggerHash);
    d.recentTriggerHashes = d.recentTriggerHashes.slice(-10000); this.save();
  }
  report() { return { ...this.data, passed: this.data.continuousMs >= 7 * 86400000 &&
    this.data.profitable > 0 && this.data.signatures === 0 && this.data.submissions === 0 }; }
}
module.exports = { BackrunEvidence };
