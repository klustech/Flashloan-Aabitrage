// Gate 9: restart recovery from crash-point journals, run in an isolated
// child process. Writes runtime/backrun/validation/restart-recovery.json.
const path = require("path");
const { cli } = require("./lib/validationGate");
const { runIsolated } = require("./lib/isolatedHarness");
const run = ({ env }) => runIsolated(path.join(__dirname, "../server/backrun/validation/recoveryValidation.js"), "runRecoveryValidation", { env });
if (require.main === module) cli("restart-recovery", run);
module.exports = { run };
