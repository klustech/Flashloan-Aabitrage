# Local validation

Local validation is the first commissioning stage:

```text
LOCAL CORRECTNESS → LOCAL ECONOMICS → ADVERSARIAL / FAILURE → HISTORICAL BENCHMARK
  → PAPER PREFLIGHT → 7-DAY PAPER → COMMISSIONING REPORT → CONTROLLED LIVE
```

It runs the production decision code against local chains, historical
mainnet state and injected faults. It needs no funded key and sends nothing to
mainnet.

> **Passing local validation does not prove competitive live inclusion.**

## What it can prove

- The contracts compile with the pinned compiler and pass unit, security and
  adversarial tests.
- Executor v4 reproduces a canonical historical opportunity in the same block,
  for both CAPITAL and FLASH_LOAN, with verified receipts and principal intact.
- The engine picks a size close to the measured optimum.
- Gas, builder-cost and liquidity stress never produce an accepted trade below
  the minimum retained profit.
- Every injected dependency failure fails closed, and a restart never
  resubmits or loses a possibly-sent transaction.
- Decision latency is measured (p50/p95/p99), and the queue stays bounded under bursts.

## What it cannot prove

- That we beat competing searchers or win builder auctions.
- That relay reputation, private order-flow frequency or inclusion rates are
  good enough.
- Live P&L. PAPER measures frequency and current-state economics. Only
  controlled LIVE measures inclusion.

## Required environment

| Need | Why |
|---|---|
| Node 22, `npm ci` | toolchain |
| solc 0.8.20 (pinned devDependency) | compiler identity in the manifest |
| Anvil 1.8.4 (`npm run backrun:install-anvil`) | canonical replay and fork tests |
| Archive RPC (`MAINNET_RPC_URL`) serving historical state at any block | historical replay, sweep and batch inputs |
| Slither 0.11.6 (`pip install slither-analyzer==0.11.6`) | static analysis gate |
| Network access to the npm registry | dependency audit gate |
| **No** `PRIVATE_KEY` | every validation command refuses it |

## Sequence

```bash
# 1. Inputs that need the archive RPC (run once per code/profile change)
npm run backrun:executor-sweep      # size × priority-fee grid on the fixture block
npm run backrun:executor-batch      # independent historical triggers, both funding modes

# 2. Local fork for the fork tests (separate terminal)
node scripts/backrun-fork-node.js --anvil

# 3. Everything else, in order, then the report
LOCAL_BACKRUN_TEST_RPC=http://127.0.0.1:8548 npm run backrun:validate-local
```

`backrun:validate-local` runs, stopping at the first required failure
(`--keep-going` runs all; `--only=a,b` runs selected steps):

| Step | Command | Evidence |
|---|---|---|
| compiler | `npx hardhat compile --force` | `step-compiler.json` |
| core-tests | `npm run test:core` (isolated, fork tests excluded) | `step-core-tests.json` |
| contract-tests | `npm run test:contracts` (isolated `hardhat test`, includes the `test/security` adversarial suite) | `step-contract-tests.json` |
| static-analysis | Slither `--fail-high` + `scripts/audit-gate.js` | `step-static-analysis.json` |
| fork-tests | `npm run test:fork:local`: Anvil fork tests, serial, no skips | `step-fork-tests.json` |
| economic-gates | replay, size, gas, builder, liquidity, parity | `canonical-replay.json`, `size-sweep.json`, … |
| failure-injection | `npm run backrun:validate:failure` | `failure-injection.json` |
| restart-recovery | `npm run backrun:validate:recovery` | `restart-recovery.json` |
| fresh-clone | `npm run backrun:validate:fresh-clone` | `step-fresh-clone.json` |
| latency | `npm run backrun:validate:latency` | `latency.json` |
| report | `npm run backrun:validate:report` | `local-validation-report.json` |

Evidence lives in `runtime/backrun/validation/` (gitignored), next to
`runtime/backrun/evidence-manifest.json`.

## Test isolation

Tests never inherit the operator environment. `scripts/run-core-tests.js`
(behind `test:core`, `test:contracts` and `test:fork:local`) starts each suite
with an allow-listed environment (PATH, HOME, proxy and locale settings) and
pre-sets every key from your local `.env*` files to empty, so `PAPER_ONLY=true`,
PostgreSQL settings or a fork RPC in your shell or dotenv files cannot change
test outcomes. Fork tests run only through `test:fork:local`, serially, and fail
instead of skipping when `LOCAL_BACKRUN_TEST_RPC` is unset. Failure-injection and
restart-recovery harnesses (which drive the LIVE path against stubs) run in an
isolated child process for the same reason; the operator process keeps
`PAPER_ONLY=true`.

## Evidence identity

Every evidence file carries the manifest identity: git commit, dirty flag,
executor version, executor artifact hash, profile fingerprint, solc and Anvil
versions. The report only accepts evidence whose identity matches the current
one, so results from other code, another executor build or different risk
settings never combine. A dirty working tree is reported as a blocker. Commit,
then re-run.

## Acceptance thresholds

See [ACCEPTANCE_CRITERIA.md](ACCEPTANCE_CRITERIA.md) for the gate-by-gate
thresholds and the definitions of **Local validation passed** and **Ready for
PAPER**.

## Failure handling

- A failed gate is a finding, not a flake. Read its evidence file: each
  records `reason`, `failed` and, for safety gates, `unsafe`.
- Never edit evidence files. Fix the cause, commit, re-run.
- `UNSAFE_*` outcomes in failure injection, or `unsafe` rows in gas or builder
  stress, are release blockers.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `fork-tests: LOCAL_BACKRUN_TEST_RPC not set` | Start `node scripts/backrun-fork-node.js --anvil` and export the variable |
| `fork-tests: tests were skipped` | The fork was unreachable from the test process |
| `<gate>: produced by different code, executor or configuration` | Evidence is from another commit or profile: re-run that gate |
| `uncommitted source changes` | Commit before generating evidence |
| `canonical-replay: produced by a different executor build` | Sweep/batch reports predate the current contract: re-run them |
| `latency: insufficient_measured_samples` | Fewer than `BACKRUN_LATENCY_MIN_SAMPLES` (20) measured decisions: run `backrun:executor-batch` over more triggers (each evaluated trigger records its decision time) |
| `static-analysis: slither not found` | `pip install slither-analyzer==0.11.6`, or set `SLITHER_BIN` (for example a virtualenv's `bin/slither`) |
| `static-analysis: slither: killed by …` / `could not start …` | The process was killed or could not start; the evidence file records the tool version, signal and output tail |
| `fresh-clone: <stage>: …` | The named stage failed in a clean clone (install, compile, identical bytecode, tests); its output tail is in `step-fresh-clone.json` |
| `EXPECTED_CONTRACT_CODE_HASH not configured` | Run `npm run backrun:executor-code-hash` (read-only), add the printed line to the PAPER env file, then re-run validation: the value is part of the profile fingerprint |
