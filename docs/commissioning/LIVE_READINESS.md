# LIVE readiness

LIVE is an engineering decision made on evidence. Every gate is required:

- executor v4 deployed and governance verified ([EXECUTOR_GOVERNANCE.md](../security/EXECUTOR_GOVERNANCE.md));
- local validation passed ([ACCEPTANCE_CRITERIA.md](../validation/ACCEPTANCE_CRITERIA.md));
- historical benchmark of 7 days or more with complete coverage, at least 2
  independent profitable triggers and positive aggregate simulated economics;
- CAPITAL and FLASH_LOAN fork proofs;
- PAPER of 7 continuous days or more with 0 signatures, 0 submissions,
  positive opportunities, acceptable latency and healthy infrastructure
  ([PAPER_PHASE.md](PAPER_PHASE.md));
- risk review approved and economic floor approved (projection covers
  infrastructure plus margin);
- the operator explicitly arms LIVE.

`server/backrun/readiness.js` refuses LIVE unless the commissioning report is
passing, less than 7 days old, matches the profile and records local
validation, and a LIVE signer is present.

## Tiny controlled LIVE test

Only after local validation, the benchmark, PAPER, commissioning and the risk
review all pass. Limits:

- very low maximum trade size (`BACKRUN_MAX_AMOUNT_*`);
- strict minimum retained profit;
- one transaction in flight (enforced: a pending submission blocks signing);
- private relays only, no public fallback (`ALLOW_PUBLIC_MEMPOOL_FALLBACK=false`);
- daily loss limit near zero (`MAX_DAILY_LOSS_ETH`);
- operator present, manual kill switch (`pause()` and API stop) ready.

## What still cannot be proven before LIVE

Beating competing searchers, winning builder auctions, relay reputation,
adequate private order flow and a profitable live inclusion rate. Only
controlled LIVE measures inclusion.
