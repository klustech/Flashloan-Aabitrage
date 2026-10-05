// Shared entry point for validation gates that need no measured inputs:
// refuse a funded key, bind the result to the evidence manifest, write
// runtime/backrun/validation/<name>.json and exit non-zero on failure.
const { productionProfile } = require("../../server/config/productionProfile");
const { loadEnvironment } = require("../paper-preflight");
const { buildManifest, writeEvidence, writeManifest } = require("../../server/backrun/validation/validationEvidence");

async function runGate(name, run, { env = process.env, log = console.log } = {}) {
  loadEnvironment(env);
  if (env.PRIVATE_KEY) throw new Error("Validation refuses PRIVATE_KEY");
  const profile = productionProfile(env), manifest = buildManifest(profile, { env });
  writeManifest(manifest, { env });
  const result = await run({ profile, env });
  writeEvidence(name, result, manifest, { env });
  log(JSON.stringify({ gate: name, manifestId: manifest.manifestId, passed: result.passed,
    failed: result.failed || [], unsafe: result.unsafe || [] }, null, 2));
  return result;
}

function cli(name, run) {
  runGate(name, run).then(r => { process.exitCode = r.passed ? 0 : 1; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { runGate, cli };
