# Acceptance criteria

Source of truth: `server/backrun/validation/acceptance.js`. Every one of the
15 gates is required and reads one evidence file bound to the current manifest, at most
7 days old.

| Gate | Evidence | Passes when |
|---|---|---|
| compiler | `step-compiler` | `hardhat compile --force` succeeds; manifest solc is 0.8.20 |
| core-tests | `step-core-tests` | `npm run test:core` exits 0 |
| contract-tests | `step-contract-tests` | `npx hardhat test` exits 0 (unit, security, executor v4 adversarial suite) |
| static-analysis | `step-static-analysis` | Slither has no High finding outside mocks; dependency audit has no unreviewed high/critical advisory |
| fork-tests | `step-fork-tests` | Anvil fork tests pass with zero skipped |
| canonical-replay | `canonical-replay` | Sweep/batch reports come from this executor version and artifact hash; ≥1 measured CAPITAL and ≥1 measured FLASH_LOAN execution; every successful execution receipt-verified, same-block, principal preserved; no unresolved technical replay errors |
| size-sweep | `size-sweep` | For each funding mode the engine's selected size is in the measured grid and nets ≥ 95% of the best measured size, and the optimum is not at the grid edge |
| gas-stress | `gas-stress` | Across base-fee ×0.5–×10 and gas usage ×1.0–×1.5, no production decision accepts a trade whose realised net is below the minimum (out-of-gas is a revert, not a loss of principal) |
| builder-competition | `builder-competition` | At every configured builder share ≤ 50%, no accepted decision nets below the minimum |
| liquidity-stress | `liquidity-stress` | Net output degrades monotonically under 10–250 bps output haircuts, and every row that falls below the floor is rejected or reverts |
| funding-parity | `funding-parity` | For each paired trigger/size: equal gross, CAPITAL fee 0, FLASH fee > 0, and `capitalNet − flashNet = flashFee + Δgas × price` |
| failure-injection | `failure-injection` | All 36 scenarios fail closed; no `UNSAFE_*` outcome |
| restart-recovery | `restart-recovery` | Pre-submission rows expire, LIVE intent is dropped, possibly-sent submissions stay pending and settle by reconciliation, torn writes are skipped |
| fresh-clone | `step-fresh-clone` | A clean clone of HEAD, installed from the lockfiles, builds identical executor runtime bytecode and passes `test:core`, failure injection and restart recovery |
| latency | `latency` | ≥ 20 measured decisions (service journal and/or historical-batch baseline) with p50/p95/p99 recorded; bursts of 1–16 triggers end terminal, never decide after expiry and keep the queue bounded. p95 ≤ `BACKRUN_LATENCY_BUDGET_MS` is enforced on live PAPER latency (or locally with `BACKRUN_LATENCY_ENFORCE_BUDGET=true`) |

## Local validation passed

Every required gate passed on evidence produced by this exact commit,
executor build, compiler and profile. It covers the blueprint's checklist: required tests green,
executor v4 confirmed, profitable historical case reproduced, no replay
mismatch, CAPITAL and FLASH_LOAN succeed, sensible sizing, negative gas,
builder and liquidity scenarios rejected, funding accounting consistent,
failure injection fail-closed, restart without duplicates, p95/p99 latency
recorded, fresh-clone reproduction and a consistent evidence fingerprint.

## Ready for PAPER

Local validation passed **and**:

- the working tree was clean and the compiler pinned (no manifest problems);
- `EXPECTED_CONTRACT_CODE_HASH` names the deployed executor;
- no `PRIVATE_KEY` is present.

`scripts/paper-preflight.js` refuses backrun PAPER without a passing, current
report for the running code and profile (`BACKRUN_VALIDATION_MAX_AGE_HOURS`,
default 168).

## Acceptance matrix

| Gate | Before PAPER | Before LIVE |
|---|:-:|:-:|
| Core / Hardhat tests | yes | yes |
| Slither / audit | yes | yes |
| v4 governance | yes | yes |
| Canonical replay (CAPITAL and FLASH_LOAN) | yes | yes |
| Size, gas, builder, liquidity, parity | yes | yes |
| Failure injection, recovery | yes | yes |
| Latency baseline | yes | yes |
| 7-day historical benchmark | recommended | yes |
| 7-day PAPER | — | yes |
| Relay inclusion | — | controlled LIVE |
| Realised live profit | — | post-LIVE evidence |
