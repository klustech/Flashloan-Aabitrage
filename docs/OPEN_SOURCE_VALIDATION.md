# Open-source validation and performance notes

**Purpose:** disclose the evidence reviewed for this release honestly. This is not an audit, performance guarantee, or substitute for rerunning the checks on a clean clone.

## Evidence reviewed

The following observations came from the project's local validation and PAPER environment reviewed during October–November 2026. They are historical snapshots, not continuously maintained CI results.

### Historical replay studies

Two selected historical replay runs were reviewed:

| Run | Triggers | Positive CAPITAL candidates | Positive FLASH_LOAN candidates | Best FLASH_LOAN simulated result |
|---|---:|---:|---:|---:|
| 5 October 2026 | 42 evaluated | 3 | 2 | approximately +0.003045931 ETH |
| 24 October 2026 | 40 evaluated from 42 attempted | 3 | 2 | approximately +0.003047391 ETH |

The 24 October run also had two unresolved failures. These were selected historical studies, not an unbiased continuous benchmark. A positive simulated result is conditional on the replay inputs, transaction ordering, state, gas and fee assumptions used by that run. It is not a realised wallet profit and must not be projected as a live return.

For the distinction between discovery studies and a commissioning benchmark, see [HISTORICAL_REPLAY.md](validation/HISTORICAL_REPLAY.md).

### PAPER ledger

The reviewed local file `runtime/local-paper-executions.jsonl` contained 769,522 records, approximately 3.6 GB. All records were `DROPPED`:

- 706,223 records (approximately 91.78%) were rejected as `Not profitable after premium`.
- 63,299 records (approximately 8.22%) were rejected as `marginal_spread_below_premium`.

These are rejection/decision records, not completed executions. They show that the reviewed runtime rejected candidates under its configured premium and spread checks. They do not establish that the bot executed profitable PAPER trades or that every record represents a unique market opportunity.

### PAPER observation duration

The reviewed PAPER burn-in evidence covered six cycles over approximately 6.59 seconds. Four cycles were superseded or exceeded their budget; two produced no profitable simulated candidate. This is a short smoke/observation sample only. It is not a 24-hour run, a seven-day commissioning period, or proof of sustained uptime.

### Backrun status

In the reviewed runtime, the backrun trading endpoint reported disabled/not started, and `BACKRUN_ENABLED=false`. Do not claim that continuous backrun PAPER operation, relay submission or LIVE backrun execution was validated by that environment.

### Live trading

No funded-wallet live trading track record or realised live profitability was established by the evidence above. The project must not be advertised as profitable, production-proven, audited, or guaranteed to make money on the basis of these results.

## Reproducing and extending the evidence

Before publishing a new release or making stronger performance claims:

1. Check out the exact commit being evaluated.
2. Record the environment and configuration profile without exposing secrets.
3. Run the relevant unit, contract, local-fork and fresh-clone checks.
4. Preserve raw reports and logs, including failed, rejected and skipped cases.
5. For historical benchmarks, define the block range and pool universe before running; include unprofitable and unsupported triggers.
6. For PAPER commissioning, follow the full continuity requirements in [PAPER_RUNBOOK.md](commissioning/PAPER_RUNBOOK.md). A smoke test is not a seven-day run.
7. Report the commit SHA, date, commands, sample size, failure count, assumptions and limitations alongside every published result.

## What this evidence supports

It supports describing the project as a substantial experimental implementation with contract execution logic, local validation tooling, historical replay capability, PAPER safety controls and a documented backrun architecture.

It does **not** support claims of consistent profitable opportunity discovery, profitable live execution, successful relay inclusion, a completed seven-day PAPER burn-in, or superiority over all competing systems.
