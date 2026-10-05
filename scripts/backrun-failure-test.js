// Gate 8: failure injection over the real LIVE execution path (stub network,
// no funded key), run in an isolated child process. Writes
// runtime/backrun/validation/failure-injection.json.
const path = require("path");
const { cli } = require("./lib/validationGate");
const { runIsolated } = require("./lib/isolatedHarness");
const run = ({ env }) => runIsolated(path.join(__dirname, "../server/backrun/validation/failureInjection.js"), "runFailureInjection", { env });
if (require.main === module) cli("failure-injection", run);
module.exports = { run };
