// Single source of truth for the executor version this code base operates.
// Must equal `executorVersion` in contracts/ArbitrageFlashloan.sol; readiness,
// fork proofs, benchmarks and the commissioning report all compare against it,
// so evidence produced with an older executor can never satisfy commissioning.
const EXECUTOR_VERSION = 4;
module.exports = { EXECUTOR_VERSION };
