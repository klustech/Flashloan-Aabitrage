# PAPER runbook

Stack setup (environment file, Compose project, database, dashboard) is in
[MAINNET_PAPER.md](../MAINNET_PAPER.md). This runbook adds the backrun
commissioning steps.

1. **Validate locally** on the exact commit you will run:
   ```bash
   npm run backrun:executor-sweep && npm run backrun:executor-batch
   node scripts/backrun-fork-node.js --anvil &
   LOCAL_BACKRUN_TEST_RPC=http://127.0.0.1:8548 npm run backrun:validate-local
   ```
   Before the first run, set `EXPECTED_CONTRACT_CODE_HASH` from the deployed
   executor: `npm run backrun:executor-code-hash` (read-only) prints the line.
   The report must say `Ready for PAPER: YES`. Freeze configuration now:
   any profile change after this point invalidates the report and resets PAPER.
2. **Preflight**: `npm run backrun:preflight` (includes `paper:preflight` and the
   local validation check). Every row must pass.
3. **Start** the API and dashboard, select PAPER, confirm *MAINNET PAPER-ONLY*,
   then `npm run paper:smoke`.
4. **Observe** the PAPER commissioning panel daily:
   - Signatures and submissions stay 0.
   - Continuity advances. A reset shows its reason; fix the cause, and the window restarts.
   - Top rejection codes explain missing opportunities.
   - p95 latency stays within budget.
5. **After 7 continuous days**: `npm run backrun:projection` (set
   `MONTHLY_INFRASTRUCTURE_COST_USD`, `ETH_USD_PRICE`), write the risk review
   (`runtime/backrun/risk-review.json`), then `npm run backrun:commission`.

Stop with `docker compose down` (never `down -v`). Evidence lives in the
runtime volume.
