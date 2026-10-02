# Production core implementation and commissioning

The application now uses an Ethereum-only deterministic execution path. This document describes implemented behavior and the operational checks still required on a configured deployment. Passing local tests does not establish profitable mainnet execution.

## Implementation map

| Blueprint phases | Implementation | Behavior |
| --- | --- | --- |
| 0, 11, 12 | `server/config/productionProfile.js` | Ethereum, Aave V2, Uniswap V2/V3, Sushi V2, Pancake V3; two/three-leg cycles. Backrunning, public fallback, cross-chain forwarding and RL execution are disabled. |
| 1, 2 | `server/market/`, `server/scripts/crossDexScanner.js`, `server/bot/opportunityEngine.js` | Chain-verified token decimals; canonical pool edges; parallel pools and triangles retain pool identity and direction. |
| 3, 4 | `server/bot/quoteEngine.js`, `profitabilityEngine.js`, `tradeSizer.js` | Executable quotes include DEX fees once; geometric sizing and local refinement use net economics and full transaction gas estimates. |
| 5 | `server/dex/` | Factory discovery, exact-pool verification, state reads, quotes and swap-step builders. Pancake V3 has its own factory, Quoter V2, fee tiers and DEX enum. Legacy Balancer/Curve helpers remain outside the production profile; missing IDs/indices fail validation. |
| 6 | `server/flashloan/aaveV2.js` | Live premium and available reserve liquidity from the exact V2 pool; no V3 preference in the V2 executor. |
| 7, 10 | `server/bot/executionEngine.js`, `server/execution/`, `server/risk/` | Pinned quotes, call simulation, gas estimates, native builder budgets, mandatory successful bundle simulation, private-only next-block submission and rechecks at signing/submission. |
| 8 | `server/bot/stateMachine.js`, `/api/trading/*` | STOPPED → PAPER → LIVE_ARMED → LIVE_RUNNING; pause disarms. Start/reset/restart never restores LIVE. Arming expires after 60 seconds. |
| 9 | `tradeLedger.js`, `receiptAccounting.js`, execution migration | Durable lifecycle, exact tx hashes, confirmed receipts, gas/priority costs, executor profit events, recipient block balance changes and prediction error. |
| 13, 14 | Coordinator behind `botLogic.js`; `TradingControl.jsx` | Existing entry points and tabs remain. New controls and panel show pool identities, token units, status, estimates and realized values. Decorative ML auto-execute is removed. |
| 15 | `frontend/server.js`, production Compose, readiness checks | Same-origin server proxy holds API_KEY; no browser signing key or API_KEY. Loopback ports by default; API/WebSocket authentication and origin checks. LIVE checks owner, recipient, timelock, code hash, version, chain, Aave and router factories. |
| 16 | `contracts/ArbitrageFlashloan.sol`, production invariant tests | Active callback commitment, principal/premium/profit validation, continuity, nonzero output limits, actual output balance deltas, allowance cleanup, pause and no subsidy from prefunded tokens. |
| 17–19 | Fork proof test, paper heartbeat, commissioning report | Reproducible real fork proof and seven-day continuous PAPER evidence are required before LIVE can be armed. These are deployment commissioning gates. |

## Private operation

Create `.env` from the production environment example and supply your real RPC, PostgreSQL, API authentication and executor configuration. Keep credentials out of git. `PRIVATE_KEY` is optional for PAPER, required only for LIVE/deployment. PAPER reads the configured operator or executor owner and uses that address as `eth_call` sender without signing.

For a new contract deployment, `npm run deploy:production` deploys the hardened executor and timelock on Ethereum. This command spends real deployment gas; it is **not** executed by the application or this implementation. Copy the non-secret addresses and expected runtime hash from `runtime/deployment.json` into `.env`. Existing contracts are not automatically upgraded. The new executor exposes `executorVersion=2`; old deployments cannot pass LIVE readiness.

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

## Economics and accounting

All token amounts are integer base units with token-specific decimals. Gas is native ETH. Builder payment uses a bounded share of executable profit converted into ETH. The transaction pays builders through priority fees; direct coinbase transfers are unsupported and rejected by simulation validation.

Gas and builder costs are allocated from one exact-output borrow-token → WETH quote for the aggregate native cost, so conversion price impact is not understated by converting each cost independently. Predicted gas uses a conservative next-block base fee and gas-limit margin. Receipt gas uses `gasUsed × effectiveGasPrice`; priority fees are displayed separately but included only once in net P&L.

Realized gross token profit comes from the executor's profit-transfer event. Recipient before/after block balance changes are recorded separately because other transactions in the same block can affect that balance. Receipt costs are valued at the receipt block using an exact-output quote. This is an executable valuation of gas, not a claim that the token-to-ETH conversion itself occurred.

Ledger states: DISCOVERED, SIMULATED, SUBMITTED, INCLUDED, REVERTED, DROPPED. Relay acceptance is never counted as inclusion. An uncertain submission stays pending and blocks another trade until receipts or target expiry resolve it. Confirmation checks and receipt block hashes protect accounting. The local journal is fsynced and PostgreSQL stores the full payload without floating-point conversion. The new panel groups P&L and prediction errors by token. Legacy DAI charts consume only settled DAI executions; historical predicted-profit rows are not treated as new realized P&L.

## Commissioning gates still require a configured environment

1. Set a real archive-capable `MAINNET_RPC_URL` and fixed `FORK_BLOCK_NUMBER` where a genuine profitable supported route exists. Run `npm run test:fork:proof`. This test discovers real pools, uses real Aave V2 fork state, executes the current contract and proves the recipient's token balance increases. It never mocks DEX state or creates an artificial discrepancy. Failure to find a real profitable route is a failed proof. Its report is `runtime/fork-proof.json`.
2. Run the actual deployment continuously in PAPER for at least seven days. `runtime/paper-burn-in.json` records heartbeats, simulation count and rejection reasons. Gaps over three minutes or a changed profile reset the continuity window. At least one complete profitable transaction simulation is required. PAPER never signs trade transactions, so Flashbots bundle simulation is explicitly reported as not run in PAPER.
3. Run `npm run commission:report` in that deployment, with matching fork and PAPER reports. It refuses incomplete or mismatched evidence and writes `runtime/commissioning.json`.
4. Verify configured contract ownership, recipient, timelock, code hash, router factories, Aave provider and signer gas balance. Open the dashboard, start PAPER, arm, then choose GO LIVE for controlled commissioning. Set a small hard `MAX_BORROW_AMOUNT` and daily loss ceiling before generating evidence.

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
