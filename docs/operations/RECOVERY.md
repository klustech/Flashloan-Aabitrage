# Restart recovery

Startup restores state from the journals (`EXECUTION_LEDGER_PATH`,
`BACKRUN_LEDGER_PATH`) and PostgreSQL, then:

| Found at startup | Action | Why |
|---|---|---|
| LIVE trade DISCOVERED/SIMULATED | DROPPED `restarted_before_submission` | Submission intent is written as SUBMITTED before any relay call, so these were never sent |
| LIVE trade SUBMITTED | kept pending; blocks all signing | It may have been sent; receipt reconciliation settles it (INCLUDED, REVERTED or DROPPED after its target block plus confirmations) |
| Backrun row DETECTED … FUNDING_SELECTED | REJECTED `ephemeral_trigger_expired_on_restart` | Trigger, parent and fork state are gone |
| Backrun row SIMULATED with a sent LIVE execution for the same trigger | linked as SUBMITTED to that execution, then settled by reconciliation | Never lose a possibly-included trade |
| Backrun row SIMULATED otherwise | REJECTED | as above |
| Unterminated final journal line | skipped, counted in `tornWrites` | A crash mid-append; that write was never acknowledged |
| Corrupt line elsewhere | startup fails | Not a torn write. Restore the journal from PostgreSQL or backup |
| PAPER window | resets `process_stopped` if the gap exceeded 30 s | continuity rule |

Do not delete journals to "unstick" a pending submission. Wait for
reconciliation, or resolve it explicitly with the transaction receipt.
`npm run backrun:validate:recovery` exercises every row above.
