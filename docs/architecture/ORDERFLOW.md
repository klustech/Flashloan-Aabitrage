# Order flow

| Source (`BACKRUN_ORDERFLOW_SOURCE`) | Trigger | Post-trigger state | Submission |
|---|---|---|---|
| `public_pending` | signed raw transaction from the WebSocket mempool | trigger mined on the fork | `eth_sendBundle [trigger, backrun]` after relay `eth_callBundle` |
| `mev_share` | hint: double hash plus shared logs | Swap/Sync logs written into pool storage on the fork and read back | `mev_sendBundle {body:[{hash},{tx,canRevert:false}]}`, next block only |
| `custom` | authenticated raw transactions (`POST /api/backrun/triggers`) | as `public_pending` | as `public_pending` |

Hints that do not determine the complete post-trigger state are rejected with
`TRIGGER_UNSUPPORTED`. Hints that touch no tracked pool are rejected with
`NO_AFFECTED_POOL`. Raw order flow is never persisted. Details:
[BACKRUN_ENGINE.md](../BACKRUN_ENGINE.md).
