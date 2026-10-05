// One command for the whole local validation sequence (blueprint §37):
//   compiler → test:core → hardhat tests → slither + audit gate → Anvil fork
//   tests → canonical replay + economic gates → failure injection → restart
//   recovery → latency → report.
// Stops at the first failed required step (--keep-going runs everything);
// --only=a,b runs selected steps. The report is always written. Replay
// reports (backrun:executor-sweep / backrun:executor-batch) are inputs: they
// need an archive RPC and are produced beforehand.
const { productionProfile } = require("../server/config/productionProfile");
const { loadEnvironment } = require("./paper-preflight");
const { buildManifest } = require("../server/backrun/validation/validationEvidence");
const { runValidation } = require("../server/backrun/validation/validationRunner");
const { report, print } = require("./backrun-validation-report");

async function main(argv = process.argv.slice(2), env = process.env) {
  loadEnvironment();
  if (env.PRIVATE_KEY) throw new Error("Local validation refuses PRIVATE_KEY");
  const keepGoing = argv.includes("--keep-going");
  const only = argv.find(a => a.startsWith("--only="))?.slice(7).split(",");
  const run = await runValidation({ env, keepGoing, only, manifestFor: () => buildManifest(productionProfile(env), { env }) });
  console.log("");
  const r = report(env); print(r);
  return { run, report: r };
}

if (require.main === module) main().then(({ report: r }) => { process.exitCode = r.localValidationPassed ? 0 : 1; })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
