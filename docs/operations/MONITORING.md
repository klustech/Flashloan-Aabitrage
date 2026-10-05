# Monitoring

| Signal | Where | Act when |
|---|---|---|
| Liveness | `GET /healthz` | not 200 |
| Prometheus metrics | `GET /metrics` | per alert rules |
| Trading state, readiness | `GET /api/trading`, `/api/trading/readiness`, `/api/trading/paper-health` | unexpected state or readiness errors |
| Backrun status and PAPER dashboard | `GET /api/backrun/status` → `dashboard` | see below |
| Recent triggers, candidates, simulations | `GET /api/backrun/recent-triggers`, `/candidates`, `/simulations` | |

All `/api` routes require `x-api-key`.

## PAPER dashboard checks

- `signatures` or `submissions` > 0: stop immediately. PAPER must never
  sign. Investigate before restarting; the window has already reset.
- `continuity.lastReset` changed: read the reason (see
  [PAPER_PHASE.md](../commissioning/PAPER_PHASE.md)) and fix the cause.
- `health.rpc` false: no new head for 60 s.
- `health.fork` false: the circuit breaker tripped or the observer stopped. Read
  `circuitReason`.
- `health.database` false: persistence is lost; PAPER evidence is not recorded.
- `latency.p95Ms` above `BACKRUN_LATENCY_BUDGET_MS`: PAPER cannot pass. Check
  per-stage latency in `/api/backrun/status` and the RPC/fork host.
- `topRejections`: `RPC_UNHEALTHY` or `STATE_MISMATCH` dominating points to
  infrastructure, not economics. `UNCLASSIFIED` means the taxonomy needs a new
  rule.

## LIVE checks

- `relays[url].submissionErrors`, `inclusionRate`, `lastError` per relay.
- Pending submissions (`summary.pending`) never exceed 1.
- Daily realised loss against `MAX_DAILY_LOSS_ETH`.
