# Commissioning evidence chain

```text
SOURCE COMMIT → PROFILE FINGERPRINT → EXECUTOR CODE HASH → LOCAL VALIDATION
  → HISTORICAL BENCHMARK → PAPER BURN-IN → RISK REVIEW → COMMISSIONING REPORT → LIVE READINESS
```

Any important change invalidates everything downstream: contract code,
router set, operator, profit recipient, sizing, gas or relay logic, risk
limits, order-flow source and funding policy all feed the profile fingerprint
or the executor code hash.

## Manifest

`runtime/backrun/evidence-manifest.json` records:

- identity: git commit, dirty flag, executor version, executor artifact
  hash, profile fingerprint, solc and Anvil versions;
- context: the deployed executor code hash, Node version, archive provider
  host (never the URL), creation time and `manifestId`, a hash of the
  identity fields.

Every validation evidence file stores the `manifestId` it was produced under,
and readers refuse a mismatch.

## Files

| File | Producer | Consumer |
|---|---|---|
| `runtime/backrun/validation/*.json` | validation gates | `local-validation-report.json` |
| `runtime/backrun/validation/local-validation-report.json` | `backrun:validate:report` | PAPER preflight, production deploy, commissioning report |
| `runtime/backrun/local-executor-{sweep,batch}.json` | historical replay | economic and latency gates |
| replay proof, benchmark, capital/flash fork proofs | `backrun:replay`, `backrun:benchmark` | commissioning report |
| `runtime/backrun/burn-in.json` | PAPER service | projection, commissioning report |
| `runtime/backrun/economic-projection.json` | `backrun:projection` | commissioning report |
| `runtime/backrun/risk-review.json` | operator | commissioning report |
| commissioning report | `backrun:commission` | LIVE readiness |

The commissioning report requires matching fingerprints on every input, a
passing local validation report for the running code, PAPER passed, both fork
proofs from executor v4, the risk review, the latency budget, the frequency
and net floors, and a projection that covers infrastructure plus margin.
