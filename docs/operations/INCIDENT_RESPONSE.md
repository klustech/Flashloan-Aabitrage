# Incident response

## Stop first

1. **Pause trading:** `POST /api/trading/pause` (exempt from rate limits).
2. **Pause the executor on-chain:** the operator key or governance calls
   `pause()`. Only governance (via the timelock) can `unpause()`.
3. If a key may be compromised:
   - Bot key: governance revokes it with `setExecutor(old, false)`. The bot key
     never holds governance rights, so it cannot redirect funds.
   - Relay-auth key: rotate `RELAY_AUTH_PRIVATE_KEY`. It holds no funds, but
     its reputation is attached to the address.
   - RPC or API credentials: rotate them at the provider and in the
     environment.

## Classify

| Symptom | Likely cause | Next |
|---|---|---|
| `backrun_submission_uncertain` circuit | a transaction may have been sent while its record failed | Do not restart LIVE. Let reconciliation settle the pending record ([RECOVERY.md](RECOVERY.md)) |
| `backrun_prediction_or_relay_mismatch` | prediction differed from relay or fork result | Treat as a model defect, collect the backrun row and stage clock |
| `orderflow_source_circuit_breaker` | 30 source errors per minute | Source or network problem; PAPER continuity resets after 60 s |
| `backrun_persistence_or_ingress_failed` | database or journal write failed | Fix storage. Nothing signs without persistence |
| Unexpected signature or submission in PAPER | configuration error | Stop. Verify `PAPER_ONLY=true` and that `PRIVATE_KEY` is absent |
| Realised loss | inclusion or prediction error | Stop LIVE, compare `predictionError` in the ledger, re-run validation |

## After

- Record the timeline, the evidence files and the commit.
- Any code or configuration change means re-running local validation and
  restarting PAPER continuity.
