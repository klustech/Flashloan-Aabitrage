# Failure injection and restart recovery

```bash
npm run backrun:validate:failure
npm run backrun:validate:recovery
```

## Failure injection (36 scenarios)

Each scenario drives the real LIVE execution path (`BackrunExecutionEngine`,
`PrivateRelays`, `TradeLedger`, a real wallet) with one dependency faulted,
and classifies the outcome:

| Outcome | Meaning |
|---|---|
| `DROP_BEFORE_SIGN` | nothing signed, nothing sent |
| `DROP_AFTER_SIGN` | signed, never sent, nothing pending |
| `HELD_UNCERTAIN` | submission intent recorded before the relay failed; signing blocked until it settles |
| `CIRCUIT` | service circuit breaker tripped and LIVE paused |
| `UNSAFE_*` | **release blocker** |

Categories: RPC (timeouts, 5xx, 429, invalid head, parent advanced,
disconnects, wrong chain), trigger (malformed, hash mismatch, mined,
disappeared, nonce replaced, expired), execution (paused, router or role
removed, gas balance, pending submission, daily loss, disarmed, gas ceiling,
below minimum, stale quote), relay (simulation timeout, revert, malformed
response, every relay rejecting, partial availability), database (unavailable,
insert fails at submission intent), fork (unknown mining outcome) and service
(persistence failure at intake, source error storm, uncertain state after
submission).

A healthy control scenario must reach `SUBMITTED`. That control found a real
defect: the per-relay guard counted the engine's own SUBMITTED record as
another pending execution, so no public-pending LIVE bundle could reach a
relay.

## Restart recovery

Crash-point journals are written to disk and reloaded by new ledger instances:

| Crash point | Required recovery |
|---|---|
| Before signing (DETECTED … SIMULATED rows) | rows expire as `ephemeral_trigger_expired_on_restart`; nothing resumes on stale state |
| LIVE intent written, not sent (DISCOVERED/SIMULATED) | dropped as `restarted_before_submission`; PAPER rows untouched |
| After submission intent (SUBMITTED) | stays pending and blocks signing; the backrun row is linked to the execution; receipt reconciliation settles it; signing resumes only afterwards |
| Torn final journal line | skipped (it was never acknowledged); corruption anywhere else stops startup |
