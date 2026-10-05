# Latency testing

`BackrunService` stamps every trigger with a stage clock, in ms since receipt:

| Mark | Stage |
|---|---|
| T0 | trigger received |
| T1 | dequeued |
| T2 | canonical parent verified |
| T3 | post-trigger state predicted |
| T4 | routes quoted and sized |
| T5 | funding selected |
| T6 | ordered bundle simulated |
| T7 | decision recorded (`latencyMs`) |
| T8 / T9 | LIVE execution started / returned |

The clock is journaled on SIMULATED and final rows and summarized in
`/status` (`latency.p95Ms`, `p99Ms`, `decisionP95Ms`).

```bash
npm run backrun:validate:latency
```

reports min, mean, median, p75, p90, p95, p99 and max overall, per order-flow
source, per funding mode and per stage. Samples come from the backrun journal
(`BACKRUN_LEDGER_PATH`) and from the historical batch's per-trigger decision
timings (`source: historical_batch`, which includes canonical-prefix replay
overhead).

The local gate needs ≥ `BACKRUN_LATENCY_MIN_SAMPLES` (20) samples: a recorded
baseline. The budget `BACKRUN_LATENCY_BUDGET_MS` (default 2500) is enforced on
live PAPER latency, and locally with `BACKRUN_LATENCY_ENFORCE_BUDGET=true`.

## Concurrency

Bursts of 1, 2, 4, 8 and 16 simultaneous triggers go through the real service
with timed stand-ins for prediction and simulation, set to the measured
medians. Triggers are processed one at a time, so queue wait grows with the
burst. Invariants:

- every trigger ends SIMULATED or REJECTED;
- no decision is recorded after its trigger expired;
- the queue never exceeds `maxPending`.

Two stress runs (short trigger age, `maxPending = 4`) must shed load through
expiry and `pending_queue_saturated` rejections.
