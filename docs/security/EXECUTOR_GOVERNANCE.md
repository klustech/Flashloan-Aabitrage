# Executor governance (ArbitrageFlashloan v4)

`executorVersion = 4` splits authority so that a stolen bot key cannot take
funds or change where funds go.

| Role | Holder | Can |
|---|---|---|
| Executor (`executors[addr]`) | Hot bot key (`OPERATOR_ADDRESS`, signs with `PRIVATE_KEY`) | `initiateFlashLoan`, `executeCapitalArbitrage` (profit-or-revert, approved routers only), `pause` |
| Admin (`admin`) | `ArbitrageTimelock`, whose only proposer/executor is the governance multisig | `setExecutor`, `setRouter`, `transferAdmin`, `rescueToken`, `unpause`, schedule/execute a recipient change (extra 24h on-chain delay) |
| Profit recipient | Cold address (`PROFIT_RECIPIENT`) | Receives realized profit and rescued tokens |

The contract enforces:

- The admin can never hold the executor role (`setExecutor`, `transferAdmin` and
  `acceptAdmin` all refuse it).
- Admin handover is two-step (`transferAdmin` then `acceptAdmin`).
- Every swap step's `router` must be in `approvedRouters`, so even a direct call
  with the executor key cannot route funds through an arbitrary contract. Initial
  routers are set in the constructor; later changes go through the timelock.
- There is no `owner`, `setTimelock`, `setProfitRecipientViaTimelock` or
  `transferOwnership`. The v3 path that let the hot owner make itself the
  timelock and redirect the recipient is gone.

## Deployment

`npm run deploy:production` (`scripts/deploy-production.js`) requires
`GOVERNANCE_ADDRESS` (a multisig contract), `OPERATOR_ADDRESS` and
`PROFIT_RECIPIENT`, all different, and a deployment key that is neither the
operator nor governance. It deploys a self-administered `ArbitrageTimelock`
(admin = zero address, proposer/executor = governance) and the executor with the
profile's routers pre-approved. The deployment key keeps no role.

Copy `EXPECTED_ADMIN` (the timelock), `OPERATOR_ADDRESS`,
`EXPECTED_PROFIT_RECIPIENT` and `EXPECTED_CONTRACT_CODE_HASH` from
`runtime/deployment.json` into the environment.

## Readiness

LIVE readiness fails unless:

- `OPERATOR_ADDRESS` holds the executor role;
- `admin()` equals `EXPECTED_ADMIN`, is not the operator, and is a contract;
- the profit recipient matches `EXPECTED_PROFIT_RECIPIENT` and is not the operator;
- every router in the production profile is approved on-chain.

## Operations

- **Emergency stop:** the bot (executor) or governance can call `pause()`.
- **Resume, rotate the bot key, add a router, rescue tokens, change recipient:**
  propose from the multisig to the timelock, wait the delay, execute. The bot's
  API exposes timelock status and roles read-only; its schedule/execute/cancel
  endpoints return 403 because the bot never holds a governance key.
- **Key rotation:** governance calls `setExecutor(new, true)` then
  `setExecutor(old, false)`.

Redeploying invalidates the configuration fingerprint and fork proofs, so do it
before collecting commissioning evidence.
