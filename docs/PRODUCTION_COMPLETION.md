# Production core implementation and commissioning

The application now uses an Ethereum-only deterministic execution path. This document describes implemented behavior and the operational checks still required on a configured deployment. Passing local tests does not establish profitable mainnet execution.

## Implementation map

| Blueprint phases | Implementation | Behavior |
| --- | --- | --- |
| 0, 11, 12 | `server/config/productionProfile.js` | Ethereum, Aave V2, Uniswap V2/V3, Sushi V2, Pancake V3; two/three-leg cycles. Backrunning, public fallback, cross-chain forwarding and RL execution are disabled. |
| 1, 2 | `server/market/`, `server/scripts/crossDexScanner.js`, `server/bot/opportunityEngine.js` | Chain-verified token decimals; canonical pool edges; parallel pools and triangles retain pool identity and direction. |
| 3, 4 | `server/bot/quoteEngine.js`, `profitabilityEngine.js`, `tradeSizer.js` | Executable quotes include DEX fees once; bounded sizing uses provisional gas costs, then the selected route must pass full transaction gas estimation, simulation and measured net economics. |
| 5 | `server/dex/` | Factory discovery, exact-pool verification, state reads, quotes and swap-step builders. Pancake V3 has its own factory, Quoter V2, fee tiers and DEX enum. Legacy Balancer/Curve helpers remain outside the production profile; missing IDs/indices fail validation. |
| 6 | `server/flashloan/aaveV2.js`, `server/backrun/fundingEngine.js` | Live Aave V2 premium/liquidity plus adaptive per-opportunity selection between owned executor capital and flash liquidity. Thin opportunities are rejected when funding cost removes net profit. |
| 7, 10 | `server/bot/executionEngine.js`, `server/execution/`, `server/risk/` | Pinned quotes, call simulation, gas estimates, native builder budgets, mandatory successful bundle simulation, private-only next-block submission and rechecks at signing/submission. |
| 8 | `server/bot/stateMachine.js`, `/api/trading/*` | STOPPED → PAPER → LIVE_ARMED → LIVE_RUNNING; pause disarms. Start/reset/restart never restores LIVE. Arming expires after 60 seconds. |
| 9 | `tradeLedger.js`, `receiptAccounting.js`, execution migration | Durable lifecycle, exact tx hashes, confirmed receipts, gas/priority costs, executor profit events, recipient block balance changes and prediction error. |
| 13, 14 | Coordinator behind `botLogic.js`; `TradingControl.jsx` | Existing entry points and tabs remain. New controls and panel show pool identities, token units, status, estimates and realized values. Decorative ML auto-execute is removed. |
| 15 | `frontend/server.js`, production Compose, readiness checks | Same-origin server proxy holds API_KEY; no browser signing key or API_KEY. Loopback ports by default; API/WebSocket authentication and origin checks. LIVE checks executor role, governance admin, recipient, approved routers, code hash, version, chain, Aave and router factories. |
| 16 | `contracts/ArbitrageFlashloan.sol`, production invariant tests | Active callback commitment, principal/premium/profit validation, continuity, nonzero output limits, actual output balance deltas, allowance cleanup, pause and no subsidy from prefunded tokens. |
| 17–19 | Fork proof test, paper heartbeat, commissioning report | Reproducible real fork proof and seven-day continuous PAPER evidence are required before LIVE can be armed. These are deployment commissioning gates. |

## Private operation

Create `.env` from the production environment example and supply your real RPC, PostgreSQL, API authentication and executor configuration. Keep credentials out of git. `PRIVATE_KEY` is optional for PAPER, required only for LIVE/deployment. PAPER requires `OPERATOR_ADDRESS` (the executor role holder) and uses that address as `eth_call` sender without signing.

For a new contract deployment, `npm run deploy:production` deploys the hardened executor and timelock on Ethereum. This command spends real deployment gas; it is **not** executed by the application or this implementation. Copy the non-secret addresses and expected runtime hash from `runtime/deployment.json` into `.env`. Existing contracts are not automatically upgraded. The current executor exposes `executorVersion=4`: the executor-only pre-funded capital path and the hardened flash-loan path, with admin/executor role separation and an on-chain router allowlist (see [EXECUTOR_GOVERNANCE.md](security/EXECUTOR_GOVERNANCE.md)). Readiness accepts only version 4, so older deployments must be explicitly redeployed with a new expected bytecode hash.

Run the database migration before updating an existing deployment:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run db:migrate:executions
docker compose -f docker-compose.production.yml up -d --build
```

For an existing Docker database, run the migration in the API service after PostgreSQL starts:

```sh
docker compose -f docker-compose.production.yml exec api node scripts/migrate-executions.js
```

Fresh production databases apply the schema and execution migration during initialization. API and dashboard bind published ports to `127.0.0.1`. Connect remotely with an SSH tunnel or a private network:

```sh
ssh -L 3002:127.0.0.1:3002 user@your-server
```

Open `http://localhost:3002`. The production dashboard build uses the private operator view; Auth0 remains available for other builds. Network restriction and the server-side API proxy are the security boundary. Do not expose the dashboard publicly. Start scanner → PAPER. The dashboard's **Arm live trading** checks readiness; **GO LIVE** is a separate action. Emergency pause changes backend state immediately. Already submitted transactions may still be included; their hashes remain tracked.

## Block-driven scanning and latency

The API and both standalone entry points now subscribe to new blocks rather than scanning once per minute or every ten seconds. `MAINNET_WEBSOCKET` supplies earlier wakeups when configured; an independent HTTP block subscription polls every second and continues if WebSocket disconnects. WebSocket heights are checked against the authoritative HTTP provider before scheduling. Duplicate notifications coalesce, only the latest queued head runs, and scans never overlap. New heads cancel obsolete sizing. Normal cancellation/expiration does not disarm LIVE; other execution failures retain the pause behavior.

`PoolStateCache` persists canonical topology only, keyed by the production profile. Restart verifies token metadata, factory/pool identity and fresh on-chain state before use. Subsequent blocks query complete ranges of state-changing pool/factory event topics and filter returned addresses against the registry. This avoids address arrays, which ethers v5 rejects. Coverage includes V2 Sync, V3 Initialize/Mint/Burn, both Uniswap and Pancake V3 Swap signatures, and PairCreated/PoolCreated. Unrelated pools are ignored. RPC log limits/errors still trigger the full-refresh fallback; the latest error is exposed as `cache.lastLogError`. Only affected pools read new reserves or V3 slot/liquidity state; unchanged states advance only after successful log coverage. Reorgs, gaps over 64 blocks and log-query failure cause a full state refresh. Factory events discover newly created pools immediately; periodic discovery every 300 blocks covers other topology changes. Empty pools remain tracked so later liquidity additions are detected. Cache updates commit atomically after a canonical block-hash check, and late results from cancelled RPC requests cannot overwrite a newer snapshot.

`CandidateIndex` caches two/three-leg route topology and reprices only routes touching changed pools. Fee-aware marginal spread removes impossible candidates before executable quoting. Exact screening now advances in batches rather than taking a fixed marginal prefix. Changed two-leg routes and triangles get the first slots, with slots for unchanged routes too. Each lane favors untried routes over previously screened routes, so failed prefixes rotate on successive blocks. `EXACT_QUOTE_CANDIDATES=4` controls batch size, with at most two concurrent candidate evaluations. Failed batches continue up to `MAX_SCREENED_CANDIDATES=48` attempted routes (hard configurable ceiling 128), enough exact-profitable finalists, or the screening deadline. Screening uses at most half the warm scan budget and reserves the other half for sizing/preparation; completed exact quotes survive a screening deadline, while outer cancellation, a changed block or mode invalidates the scan. The default is one fully sized route, four sizing samples and one refinement; `SIZED_CANDIDATES` may be raised to at most three. Executable quote promises and Aave terms are reused within the pinned block and cleared when its hash changes. Gas during screening is a heuristic, which can miss opportunities; it cannot authorize execution. Every selected route still needs two full executor calls, a measured gas estimate with margin, measured net profitability and a fresh head check. LIVE additionally retains readiness checks, signer/contract/risk guards and mandatory matching profitable relay simulation. There is no stale-head or public-mempool fallback.

Warm scans have a default five-second budget; initial metadata/discovery has a sixty-second allowance. The budget stops application work, but RPC transports can finish requests already sent. A private submission returns its tracked hash immediately; later block callbacks reconcile receipts, including while trading is paused, instead of holding the scanner for a 45-second receipt wait.

`/api/trading` and the existing control panel expose scan duration, stage timings, quote requests/cache hits, discovery/state/log counts, indexed/repriced candidates, cached block and scheduler source/cancellation counts. Profile changes invalidate commissioning evidence and reset paper continuity. `screeningBatches`, `screeningAttempted`, `screeningPassed` and `screeningStopReason` distinguish exhaustion, sufficient finalists, the candidate cap and the screening deadline. Existing `.env` files should use batch size 4 and `MAX_SCREENED_CANDIDATES=48`; increasing the batch size to 12 is no longer necessary to advance past failed routes. Screening remains bounded and may miss opportunities; it does not exhaustively optimize every route in one block.

Deterministic regression coverage processes 200 steady blocks with one initial discovery, zero repeated metadata reads and exactly 100 dynamic pool reads when one of two pools changes on alternate blocks. Other tests cover restart verification, factory discovery, reorg/log-failure/gap recovery, quote invalidation, overlapping notifications, budget cancellation and cancellation before signing. A five-token regression builds thousands of routes with a misleading high-marginal V3 triangle prefix, uses exact V2 reserve math and controlled failing V3 quotes, and verifies the PAPER coordinator progresses to the profitable V2 route, two executor calls and one gas estimate. These executor RPCs are stubbed in the deterministic regression; this is not a new live fork execution proof. Real ethers v5 and FallbackProvider tests cover topic-filtered incremental updates and persisted topology restart. Other tests cover candidate caps, lane rotation, concurrency, screening deadlines, late results and mode cancellation. This demonstrates reduced work; actual RPC/relay latency, competitive inclusion and profitability still require measurements on the configured deployment. PAPER remains unsigned and does not commission relay compatibility.

## Repeat the known-opportunity local check

For an already-running local fork with a deployed executor and manufactured discrepancy, keep the fork and miner running. Restore `SCAN_TOKENS=DAI,WETH,USDC,USDT,WBTC`, `BORROW_TOKENS=DAI`, `EXACT_QUOTE_CANDIDATES=4`, `MAX_SCREENED_CANDIDATES=48`, and `SIZED_CANDIDATES=1` in your local `.env`. Restart the API only, then select PAPER again. Rebuild/restart the dashboard if you want the new screening telemetry. Do not restart the fork, which would erase its local pool changes.

Inspect `GET /api/trading` for advancing blocks/scans, nonzero `screeningBatches`, and eventual `SIMULATED` with two transaction calls and one gas estimate. The chosen route may use a different counter-venue than the manual quote. On stable empty blocks, `cache.reusedPools` should equal the tracked pool count and `logFallbacks` should stop increasing. If log fallback resumes, inspect `cache.lastLogError`; provider limits still require a full refresh rather than trusting incomplete logs. Screens need not exceed four when a profitable route is already in the first diversified batch.

Repeated SIMULATED records are expected in PAPER because no transaction consumes the local discrepancy. Expected profit is not realized profit. Manufactured prices and local zero-base-fee economics demonstrate software integration only; they cannot supply the genuine fork proof, normal-market burn-in or relay commissioning evidence required for LIVE.

## Economics and accounting

All token amounts are integer base units with token-specific decimals. Gas is native ETH. Builder payment uses a bounded share of executable profit converted into ETH. The transaction pays builders through priority fees; direct coinbase transfers are unsupported and rejected by simulation validation.

Gas and builder costs are allocated from one exact-output borrow-token → WETH quote for the aggregate native cost, so conversion price impact is not understated by converting each cost independently. Predicted gas uses a conservative next-block base fee and gas-limit margin. Receipt gas uses `gasUsed × effectiveGasPrice`; priority fees are displayed separately but included only once in net P&L.

Realized gross token profit comes from the executor's profit-transfer event. Recipient before/after block balance changes are recorded separately because other transactions in the same block can affect that balance. Receipt costs are valued at the receipt block using an exact-output quote. This is an executable valuation of gas, not a claim that the token-to-ETH conversion itself occurred.

Ledger states: DISCOVERED, SIMULATED, SUBMITTED, INCLUDED, REVERTED, DROPPED. Relay acceptance is never counted as inclusion. An uncertain submission stays pending and blocks another trade until receipts or target expiry resolve it. Confirmation checks and receipt block hashes protect accounting. The local journal is fsynced and PostgreSQL stores the full payload without floating-point conversion. The new panel groups P&L and prediction errors by token. Legacy DAI charts consume only settled DAI executions; historical predicted-profit rows are not treated as new realized P&L.

## Commissioning gates still require a configured environment

1. Set a real archive-capable `MAINNET_RPC_URL` and fixed `FORK_BLOCK_NUMBER` where a genuine profitable supported route exists. Run `npm run test:fork:proof`. This test discovers real pools, uses real Aave V2 fork state, executes the current contract and proves the recipient's token balance increases. It never mocks DEX state or creates an artificial discrepancy. Failure to find a real profitable route is a failed proof. Its report is `runtime/fork-proof.json`.
2. Run the actual deployment continuously in PAPER for at least seven days. `runtime/paper-burn-in.json` records heartbeats, simulation count and rejection reasons. Gaps over three minutes or a changed profile reset the continuity window. At least one complete profitable transaction simulation is required. PAPER never signs trade transactions, so Flashbots bundle simulation is explicitly reported as not run in PAPER.
3. Run `npm run commission:report` in that deployment, with matching fork and PAPER reports. It refuses incomplete or mismatched evidence and writes `runtime/commissioning.json`.
4. Verify the executor role, governance admin, recipient, approved routers, code hash, router factories, Aave provider and signer gas balance. Open the dashboard, start PAPER, arm, then choose GO LIVE for controlled commissioning. Set a small hard `MAX_BORROW_AMOUNT` and daily loss ceiling before generating evidence.

No live trade, mainnet deployment, seven-day burn-in or profitable fork proof is claimed by local tests. A newly deployed executor and external RPC/relay access remain necessary before LIVE commissioning.

## Validation commands

```sh
npm run test:core
npm test
cd frontend
npm ci --ignore-scripts --legacy-peer-deps
CI=true npm test -- --watchAll=false --runInBand
CI=false npm run build
```

The `Production core` workflow also validates the PostgreSQL execution migration and persistence precision on a real PostgreSQL service. Fork tests stay explicit and require archive RPC configuration; they are not substituted with mocks.

Protocol references used for the adapters and simulation contract:

- https://developer.pancakeswap.finance/contracts/v3/addresses
- https://docs.flashbots.net/flashbots-auction/advanced/rpc-endpoint
- https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments

Pool event coverage reference: https://github.com/pancakeswap/pancake-v3-contracts/blob/main/projects/v3-core/contracts/interfaces/pool/IPancakeV3PoolEvents.sol
