# Backrun architecture

```text
order-flow source → TriggerIntake (bounded, deduplicated) → BackrunService queue (one at a time)
  → StatePredictor on dedicated fork (raw trigger replay | MEV-Share log-derived state)
  → BackrunEngine (routes, exact sizing) → BackrunTransactionBuilder.prepare (funding, gas, builder budget, minimum profit)
  → ordered fork bundle simulation → decision (PAPER: record) → BackrunExecutionEngine (LIVE: sign, relay)
```

- **Ledgers:**
  - `BackrunLedger` holds per-trigger rows:
    DETECTED → POST_TRIGGER_QUOTED → FUNDING_SELECTED → SIMULATED → SUBMITTED →
    INCLUDED, REVERTED or DROPPED. Any state before SUBMITTED can go to REJECTED.
  - `TradeLedger` holds LIVE executions. SUBMITTED is written before any relay
    call.
- **Stage clock:** T0–T9 per trigger ([LATENCY_TESTING.md](../validation/LATENCY_TESTING.md)).
- **Evidence:** PAPER burn-in ([PAPER_PHASE.md](../commissioning/PAPER_PHASE.md)),
  validation evidence ([LOCAL_VALIDATION_BLUEPRINT.md](../validation/LOCAL_VALIDATION_BLUEPRINT.md)).
- **Implementation detail, MEV-Share and limitations:** [BACKRUN_ENGINE.md](../BACKRUN_ENGINE.md).
