// Local validation acceptance matrix (blueprint §33-36). Each gate is one
// evidence file bound to the current manifest; the report is only as strong
// as its weakest required gate.
//
// "Local validation passed": every required gate passed on evidence produced
// by this exact commit, executor build, compiler and profile, within maxAge.
// "Ready for PAPER": local validation passed on a clean, pinned build AND the
// profile names the deployed executor's runtime code hash, so PAPER readiness
// checks compare the live contract against an explicit expectation. The PAPER
// preflight (RPC, WebSocket, database, executor roles) still runs separately.
const { readEvidence, writeEvidence, manifestProblems } = require("./validationEvidence");
const { EXECUTOR_VERSION } = require("../../config/executorVersion");

const DAY = 86400000;
const ACCEPTANCE = [
  { id: "compiler", evidence: "step-compiler", title: "Pinned solc 0.8.20, forced compile" },
  { id: "core-tests", evidence: "step-core-tests", title: "Node unit and service tests (test:core)" },
  { id: "contract-tests", evidence: "step-contract-tests", title: "Hardhat contract, security and adversarial executor tests" },
  { id: "static-analysis", evidence: "step-static-analysis", title: "Slither --fail-high and dependency audit gate" },
  { id: "fork-tests", evidence: "step-fork-tests", title: "Anvil local-fork backrun and MEV-Share state tests" },
  { id: "canonical-replay", evidence: "canonical-replay", title: "Canonical same-block replay with executor v4" },
  { id: "size-sweep", evidence: "size-sweep", title: "Engine size selection within 95% of measured optimum" },
  { id: "gas-stress", evidence: "gas-stress", title: "No accepted trade below minimum under gas price/usage stress" },
  { id: "builder-competition", evidence: "builder-competition", title: "Builder bid never pushes accepted net below minimum" },
  { id: "liquidity-stress", evidence: "liquidity-stress", title: "Net profit degrades monotonically with output haircuts" },
  { id: "funding-parity", evidence: "funding-parity", title: "CAPITAL and FLASH_LOAN differ only by fee and gas" },
  { id: "failure-injection", evidence: "failure-injection", title: "Every injected dependency failure is fail-closed" },
  { id: "restart-recovery", evidence: "restart-recovery", title: "Crash-point journals recover without resubmission" },
  { id: "fresh-clone", evidence: "step-fresh-clone", title: "Fresh clone builds identical executor bytecode and passes core gates" },
  { id: "latency", evidence: "latency", title: "Measured decision-latency baseline (p50/p95/p99); bounded concurrent queue" },
].map(g => ({ required: true, ...g }));

function evaluateAcceptance({ manifest, profile, env = process.env, now = Date.now, maxAgeMs = 7 * DAY } = {}) {
  const gates = ACCEPTANCE.map(gate => {
    const { ok, reason, record } = readEvidence(gate.evidence, { manifest, maxAgeMs, env, now });
    const passed = ok && record?.passed === true;
    return { id: gate.id, title: gate.title, required: gate.required, passed,
      reason: !ok ? reason : passed ? null : record?.reason || (record?.failed || [])[0] || "gate failed",
      unsafe: record?.unsafe || [], recordedAt: record?.recordedAt || null };
  });
  const problems = manifestProblems(manifest);
  const failedRequired = gates.filter(g => g.required && !g.passed).map(g => g.id);
  const localValidationPassed = failedRequired.length === 0;
  const deployedHashConfigured = Boolean(profile?.expectedContractCodeHash);
  const tradingKey = Boolean(String(env.PRIVATE_KEY || "").trim());
  const readyForPaper = localValidationPassed && problems.length === 0 && deployedHashConfigured && !tradingKey;
  const blockers = [...failedRequired.map(id => `gate ${id} not passed`), ...problems,
    ...(deployedHashConfigured ? [] : ["EXPECTED_CONTRACT_CODE_HASH not configured"]),
    ...(tradingKey ? ["PRIVATE_KEY present in the PAPER environment"] : [])];
  return { gates, failedRequired, manifestProblems: problems, localValidationPassed, readyForPaper, blockers };
}

const REPORT = "local-validation-report";

function writeValidationReport({ manifest, profile, env = process.env, now = Date.now, maxAgeMs } = {}) {
  const acceptance = evaluateAcceptance({ manifest, profile, env, now, maxAgeMs });
  const report = { kind: "BACKRUN_LOCAL_VALIDATION", executorVersion: manifest.executorVersion, gitCommit: manifest.gitCommit,
    profileFingerprint: manifest.profileFingerprint, createdAt: now(), ...acceptance, passed: acceptance.localValidationPassed };
  writeEvidence(REPORT, report, manifest, { env, now });
  return report;
}

// PAPER preflight: a passing local validation report for this exact code,
// executor build and profile, recent enough to still describe them.
// Deployment needs local validation only (the deployed code hash cannot exist
// yet); PAPER additionally needs readyForPaper.
function localValidationStatus({ manifest, env = process.env, now = Date.now, maxAgeMs = 7 * DAY, requirePaperReady = true } = {}) {
  const { ok, reason, record } = readEvidence(REPORT, { manifest, maxAgeMs, env, now });
  if (!ok) return { ok: false, reason };
  if (record.kind !== "BACKRUN_LOCAL_VALIDATION" || record.executorVersion !== EXECUTOR_VERSION)
    return { ok: false, reason: `local validation report is not for executor v${EXECUTOR_VERSION}` };
  if (!record.localValidationPassed) return { ok: false, reason: `local validation failed: ${(record.blockers || []).join("; ")}` };
  if (requirePaperReady && !record.readyForPaper) return { ok: false, reason: `not ready for PAPER: ${(record.blockers || []).join("; ")}` };
  return { ok: true, reason: null, report: record };
}

module.exports = { ACCEPTANCE, evaluateAcceptance, writeValidationReport, localValidationStatus, REPORT, DAY };
