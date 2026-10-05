// Gate 9: restart recovery from crash-point journals. Writes
// runtime/backrun/validation/restart-recovery.json.
const { runRecoveryValidation } = require("../server/backrun/validation/recoveryValidation");
const { cli } = require("./lib/validationGate");
if (require.main === module) cli("restart-recovery", () => runRecoveryValidation());
