# PAPER phase

> PAPER means processing live Ethereum conditions through the production
> decision pipeline without signing or submitting the arbitrage transaction.

```text
live order flow → current block state → trigger decoding → state prediction → route search
  → sizing → funding decision → executor construction → simulation → economics → hypothetical record
```

It stops before private-key signing, relay submission, public submission and
on-chain execution. `PAPER_ONLY=true` is enforced in the backend. The PAPER
environment refuses `PRIVATE_KEY`. `RELAY_AUTH_PRIVATE_KEY` may exist for relay
identity only: it signs request headers, never transactions, must differ from
any execution key and must never hold ETH.

| PAPER proves | PAPER does not prove |
|---|---|
| live order-flow visibility | builder win rate |
| live trigger frequency | actual block inclusion |
| live latency | realised live P&L |
| real current-state economics | competitor behaviour |
| operational continuity, simulation stability | |

## Entry

PAPER starts only when local validation reports **Ready for PAPER** for the
running commit and profile (see
[ACCEPTANCE_CRITERIA.md](../validation/ACCEPTANCE_CRITERIA.md)).
`npm run paper:preflight` / `npm run backrun:preflight` enforce it.

## Evidence

`runtime/backrun/burn-in.json` (`BACKRUN_BURN_IN_PATH`), produced by
`server/backrun/evidence.js`, holds one continuous window with:

- heads, triggers observed, decoded and evaluated, and candidates generated;
- profitable candidates, with CAPITAL- and FLASH_LOAN-positive counts;
- total, best and median hypothetical net (native) and hypothetical gas;
- latency p50/p95/p99;
- source disconnects and RPC, fork and relay error counts;
- rejections by canonical code;
- the last 200 opportunity records;
- signatures and submissions;
- gaps, resets with reasons and configuration changes.

Each opportunity record keeps: timestamp, head number and hash, trigger hash,
order-flow source, affected pools, candidate route count, selected route and
DEX path, borrow token and amount, funding mode, gross profit, flash-loan fee,
estimated gas and gas cost, builder budget, expected retained profit (token
and native), reject reason and code, and pipeline latency. Raw transactions
are never stored.

## Continuity rules

The 7-day clock resets, with the reason recorded, when (checked in this order
on every 5 s heartbeat):

| Rule | Reason |
|---|---|
| mode leaves PAPER | `left_paper_mode` |
| any trade signature | `signing_occurred` |
| any submission | `submission_occurred` |
| no heartbeat for 30 s (process stopped, laptop slept) | `process_stopped` |
| service circuit breaker tripped | `circuit_breaker:<reason>` |
| observer stopped | `observer_stopped` |
| database unavailable (production) | `database_unavailable` |
| no new chain head for 60 s | `chain_heads_stalled` |
| order-flow source disconnected for more than 60 s | `orderflow_disconnected` |
| profile fingerprint changed (risk limits, routers, operator, executor address or code hash, order-flow source, funding policy …) | `configuration_changed` |

A source outage up to 60 s is tolerated and counted in `sourceDisconnects`.
Transient RPC errors are counted in `rpcErrors` and never reset the window:
every decision re-reads full canonical state, so nothing carries over from a
failed call.

## PAPER passed

- ≥ 7 continuous days under one configuration (the rules above guarantee live
  order flow, advancing heads and a healthy database throughout);
- 0 trade signatures, 0 trade submissions;
- profitable opportunities observed, including CAPITAL economics
  (FLASH_LOAN reported where available);
- p95 decision latency ≤ `BACKRUN_LATENCY_BUDGET_MS`;
- executor v4.

## Rejection taxonomy

Every rejection maps to one code (`server/backrun/rejectionTaxonomy.js`), so
the dashboard answers *why are we not trading?*:

`TRIGGER_UNSUPPORTED`, `TRIGGER_STALE`, `TRIGGER_REPLACED`, `STATE_MISMATCH`,
`NO_AFFECTED_POOL`, `NO_ROUTE`, `NO_POSITIVE_GROSS`, `FLASH_LIQUIDITY_LOW`,
`CAPITAL_LOW`, `GAS_TOO_HIGH`, `BUILDER_COST_TOO_HIGH`, `NET_PROFIT_TOO_LOW`,
`SLIPPAGE_TOO_HIGH`, `ROUTER_NOT_APPROVED`, `CONTRACT_PAUSED`,
`SIMULATION_REVERT`, `LATENCY_BUDGET_EXCEEDED`, `RPC_UNHEALTHY`,
`RELAY_UNAVAILABLE`, `RISK_LIMIT`. Operational outcomes are kept separate:
`DUPLICATE_TRIGGER`, `QUEUE_SATURATED` and `TRADING_STOPPED`. Anything new is
`UNCLASSIFIED`, which is a prompt to extend the table.

## Dashboard

The Backrun workspace's **PAPER commissioning** panel (from `/status` →
`backrun.dashboard`) shows:

- mode, executor version, current head and source status;
- triggers and evaluations per minute, and profitable candidates per day;
- CAPITAL and FLASH_LOAN opportunities;
- best, median and total hypothetical net;
- latency p50/p95/p99;
- top rejection codes;
- RPC, fork, database and relay health;
- signatures and submissions (must be 0);
- continuity Day X / 7 and the last reset reason.

## Economics

Do not annualize PAPER profit. `npm run backrun:projection` produces
conservative, base and optimistic projections:

```text
observed opportunities/day × capture × inclusion rate
  × (avg net × (1 − builder haircut) − avg gas × (gas multiplier − 1))
  − infrastructure/day  →  retained/day  →  annualized last
```

`MONTHLY_INFRASTRUCTURE_COST_USD` covers archive and WebSocket RPC, the server,
database, monitoring, relay infrastructure and a backup provider. With
`ETH_USD_PRICE` and `BACKRUN_RISK_MARGIN_BPS` (default 2000) it gives the
minimum required daily net. Economic readiness needs the base case to cover
infrastructure plus the margin and the conservative trading net to be
positive. Scenario assumptions are operator inputs for the risk review
(`BACKRUN_PROJECTION_ASSUMPTIONS` overrides them). Only the observed figures are
measurements.
