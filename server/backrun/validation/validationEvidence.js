// Evidence chain for local validation (blueprint §29-32). Every validation file
// is stamped with one manifest identity: source commit, executor version and
// runtime code hash, profile fingerprint, compiler and Anvil versions. Readers
// refuse evidence whose identity differs from the current one, so results from
// other code, another executor or changed risk settings can never be combined.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { utils } = require("ethers");
const { EXECUTOR_VERSION } = require("../../config/executorVersion");
const { evidenceFingerprint } = require("../readiness");

const ROOT = path.resolve(__dirname, "../../..");
const REQUIRED_SOLC = "0.8.20";
const IDENTITY_KEYS = ["gitCommit", "gitDirty", "executorVersion", "executorCodeHash", "profileFingerprint", "solcVersion", "anvilVersion"];

function validationDir(env = process.env) {
  return path.resolve(ROOT, env.BACKRUN_VALIDATION_DIR || "runtime/backrun/validation");
}

function gitState(root = ROOT) {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    // Generated build output does not change the evidence identity.
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal", "--", ".",
      ":(exclude)artifacts", ":(exclude)cache"], { cwd: root, encoding: "utf8" }).trim().length > 0;
    return { gitCommit: commit, gitDirty: dirty };
  } catch (_) { return { gitCommit: null, gitDirty: null }; }
}

function executorCodeHash(root = ROOT) {
  const file = path.join(root, "artifacts/contracts/ArbitrageFlashloan.sol/ArbitrageFlashloan.json");
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!artifact.deployedBytecode || artifact.deployedBytecode === "0x") throw new Error("Compiled executor runtime bytecode missing");
  return utils.keccak256(artifact.deployedBytecode);
}

function solcVersion() {
  try { return require("solc").version().split("+")[0]; } catch (_) { return null; }
}

// Only the provider host is recorded; paths and query strings carry API keys.
function redactedHost(url) {
  try { return url ? new URL(url).hostname : null; } catch (_) { return "unparseable"; }
}

function manifestId(manifest) {
  return utils.keccak256(utils.toUtf8Bytes(JSON.stringify(IDENTITY_KEYS.map(key => [key, manifest[key] ?? null]))));
}

function buildManifest(profile, { env = process.env, root = ROOT, now = Date.now } = {}) {
  const manifest = {
    ...gitState(root), executorVersion: EXECUTOR_VERSION, executorCodeHash: executorCodeHash(root),
    deployedExecutorCodeHash: profile.expectedContractCodeHash || null,
    profileFingerprint: evidenceFingerprint(profile), nodeVersion: process.version, solcVersion: solcVersion(),
    anvilVersion: require("../../../scripts/backrun-anvil").VERSION,
    archiveProvider: redactedHost(env.MAINNET_RPC_URL), createdAt: now(),
  };
  return { ...manifest, manifestId: manifestId(manifest) };
}

function manifestProblems(manifest) {
  const problems = [];
  if (!manifest.gitCommit) problems.push("source commit unknown");
  if (manifest.gitDirty) problems.push("uncommitted source changes");
  if (manifest.solcVersion !== REQUIRED_SOLC) problems.push(`solc ${REQUIRED_SOLC} required (found ${manifest.solcVersion})`);
  if (manifest.executorVersion !== EXECUTOR_VERSION) problems.push(`executor version ${EXECUTOR_VERSION} required`);
  return problems;
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}

function writeManifest(manifest, { env = process.env } = {}) {
  const file = path.resolve(ROOT, env.BACKRUN_EVIDENCE_MANIFEST || "runtime/backrun/evidence-manifest.json");
  atomicWrite(file, manifest);
  return file;
}

function writeEvidence(name, payload, manifest, { env = process.env, now = Date.now } = {}) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid evidence name");
  const file = path.join(validationDir(env), name + ".json");
  const record = { ...payload, evidence: name, manifestId: manifest.manifestId,
    manifest: Object.fromEntries(IDENTITY_KEYS.map(key => [key, manifest[key] ?? null])), recordedAt: now() };
  atomicWrite(file, record);
  return { file, record };
}

function readEvidence(name, { manifest, maxAgeMs, env = process.env, now = Date.now } = {}) {
  const file = path.join(validationDir(env), name + ".json");
  let record;
  try { record = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (_) { return { ok: false, reason: `${name}: evidence missing`, record: null }; }
  if (manifest && record.manifestId !== manifest.manifestId)
    return { ok: false, reason: `${name}: produced by different code, executor or configuration`, record };
  if (maxAgeMs && (!record.recordedAt || now() - record.recordedAt > maxAgeMs))
    return { ok: false, reason: `${name}: evidence older than allowed`, record };
  return { ok: true, reason: null, record };
}

module.exports = { buildManifest, manifestId, manifestProblems, writeManifest, writeEvidence, readEvidence,
  validationDir, redactedHost, REQUIRED_SOLC, IDENTITY_KEYS, atomicWrite };
