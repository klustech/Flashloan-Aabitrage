// Gate 8: failure injection over the real LIVE execution path (no network,
// no funded key). Writes runtime/backrun/validation/failure-injection.json.
const { runFailureInjection } = require("../server/backrun/validation/failureInjection");
const { cli } = require("./lib/validationGate");
if (require.main === module) cli("failure-injection", () => runFailureInjection());
