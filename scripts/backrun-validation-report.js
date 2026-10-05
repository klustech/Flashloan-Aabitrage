// Collects every gate's evidence for the current manifest into
// runtime/backrun/validation/local-validation-report.json
// (kind BACKRUN_LOCAL_VALIDATION). Exit 0 only when local validation passed.
const { productionProfile } = require("../server/config/productionProfile");
const { loadEnvironment } = require("./paper-preflight");
const { buildManifest, writeManifest } = require("../server/backrun/validation/validationEvidence");
const { writeValidationReport } = require("../server/backrun/validation/acceptance");

function report(env = process.env) {
  const profile = productionProfile(env), manifest = buildManifest(profile, { env });
  writeManifest(manifest, { env });
  return writeValidationReport({ manifest, profile, env });
}

function print(r) {
  for (const g of r.gates) console.log(`${g.passed ? "✓" : "✗"} ${g.id.padEnd(20)} ${g.title}${g.reason ? `  — ${g.reason}` : ""}`);
  console.log(`\nLocal validation passed: ${r.localValidationPassed ? "YES" : "NO"}`);
  console.log(`Ready for PAPER:         ${r.readyForPaper ? "YES" : "NO"}`);
  for (const b of r.blockers) console.log(`  blocker: ${b}`);
}

if (require.main === module) {
  try { loadEnvironment(); const r = report(); print(r); process.exitCode = r.localValidationPassed ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { report, print };
