# Executor v4

`contracts/ArbitrageFlashloan.sol`, `executorVersion = 4`. The single source
of the expected version in code is `server/config/executorVersion.js`.
Readiness, fork proofs, sweep/batch reports, the evidence manifest, the
commissioning report, `/status` and the dashboard all use it. Evidence from
another version never satisfies v4 commissioning.

- **Constructor:** `(provider, profitRecipient, admin, executor, address[] routers)`.
- **Funding paths:**
  - `initiateFlashLoan` (Aave V2 flash loan, repaid in `executeOperation`);
  - `executeCapitalArbitrage` (pre-funded capital).
  - Both are profit-or-revert against the caller's minimum profit and route
    only through approved routers.
- **Roles:** see [EXECUTOR_GOVERNANCE.md](../security/EXECUTOR_GOVERNANCE.md).
  The admin can never be an executor.
- **Adversarial suite** (`test/security/executorAdversarial.test.js`, malicious
  router in `contracts/mocks/MaliciousRouter.sol`) covers:
  - unapproved routers;
  - re-entry into the capital and flash paths, even with the executor role granted;
  - nested flash loans;
  - rescue, admin and callback calls from a router;
  - under-delivery and over-pull;
  - stale-quote profit floor;
  - wrong initiator, and a callback after completion;
  - admin attempting to trade.
