const fs = require("fs");
const { utils } = require("ethers");
const { serialize } = require("../bot/units");
function evidenceFingerprint(profile) {
  const { fingerprint, paperOnly, ...config } = serialize(profile);
  return utils.keccak256(utils.toUtf8Bytes(JSON.stringify(config)));
}
function commissioningChecks(profile, env = process.env) {
  const errors = []; let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(profile.backrun.commissioningPath, "utf8"));
    if(!evidence.passed||!evidence.createdAt||Date.now()-evidence.createdAt>7*86400000)throw new Error("Passing recent commissioning report required");
    if (evidence.profileFingerprint !== evidenceFingerprint(profile)) throw new Error("Backrun evidence configuration mismatch");
    if (!evidence.replay?.passed || !evidence.replay?.intraBlock || !evidence.replay?.canonicalReceiptsVerified)
      throw new Error("Exact historical intra-block proof missing");
    if (!evidence.benchmark?.passed || evidence.benchmark.durationMs < 7 * 86400000 ||
        evidence.benchmark.distinctProfitableTriggers < 2 || !evidence.benchmark.fullExecutorSimulations||
        !evidence.benchmark.coverageComplete||!evidence.benchmark.sameBlockBundleVerified)
      throw new Error("Seven-day full-execution historical economics missing");
    if (!evidence.paper?.passed || evidence.paper.continuousMs < 7 * 86400000 ||
        !evidence.paper.profitable || evidence.paper.signatures || evidence.paper.submissions ||
        !evidence.paper.lastHeartbeat || Date.now() - evidence.paper.lastHeartbeat > 7*86400000)
      throw new Error("Completed recent backrun PAPER evidence missing");
    if (!evidence.capitalForkProof?.passed || !evidence.flashForkProof?.passed)
      throw new Error("Both executor funding paths require mainnet-fork proof");
    for(const proof of [evidence.replay,evidence.benchmark,evidence.paper,evidence.capitalForkProof,evidence.flashForkProof])
      if(proof.profileFingerprint!==evidenceFingerprint(profile))throw new Error("Individual backrun evidence configuration mismatch");
    if (!evidence.economicAcceptance?.passed || !evidence.economicAcceptance?.riskReview)
      throw new Error("Economic frequency, latency, capital and risk acceptance missing");
  } catch (e) { errors.push(e.message); }
  if (!env.PRIVATE_KEY) errors.push("LIVE signer required");
  return { ready: errors.length === 0, errors, evidence };
}
async function runtimeChecks(service) {
  const errors = [];
  if (!service || service.closed || !service.source?.status().connected) errors.push("Order-flow source disconnected");
  if (service?.circuitReason) errors.push(service.circuitReason);
  try { await service?.backend.verify(); } catch (_) { errors.push("Post-trigger backend unavailable"); }
  return errors;
}
module.exports = { commissioningChecks, evidenceFingerprint, runtimeChecks };
