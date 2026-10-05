# Transaction-Triggered Backrun Engine — Comprehensive Implementation Blueprint

## Status

> **Superseded executor version.** This design record describes executor v3.
> The operating executor is **v4** (`EXECUTOR_VERSION` in
> `server/config/executorVersion.js`), which adds role separation and an on-chain
> router allowlist; see [EXECUTOR_GOVERNANCE.md](security/EXECUTOR_GOVERNANCE.md). Readiness,
> fork proofs, benchmarks and the commissioning report accept only v4 evidence.
> References to v2/v3 below are kept as history.

This blueprint defines the architectural change from the current post-block, flash-loan-first arbitrage scanner to a transaction-triggered, WETH-first, adaptive-funding backrun system.

It is based on the production baseline at `4c9ef5a192f1386e0e5d65140fe44b449ccb182f` and the empirical mainnet audit performed against the existing 77-pool universe.

The current production core remains the safety and execution foundation. The new design adds an order-flow/backrun layer rather than replacing verified pool discovery, exact quoting, route topology, execution guards, PAPER controls, ledger accounting, or private relay submission.

The branch for this implementation is:

```
feature/backrun-orderflow-engine-v2
```

No LIVE deployment should be performed from this branch until every acceptance gate in this document passes.

---

## 1. Empirical reason for the redesign

The rolling observer established that the current scanner can safely sample Ethereum mainnet state and generate thousands of routes, but it did not find a natural finalized-state opportunity that survived exact quoting.

A historical audit of the same tracked universe then inspected 3,001 consecutive Ethereum blocks and found:

- 22,136 tracked swap logs.
- 19,974 transactions touching tracked pools.
- 32 positive closed cycles.
- 28 two-hop cycles.
- 4 three-hop cycles.
- 0 four/five-hop cycles.
- 32/32 cycles started and ended in WETH.
- 0 DAI 2/3-hop cycles compatible with the current DAI-only borrow configuration.
- 30/32 cycles had a prior same-block tracked-pool swap consistent with transaction-triggered backrunning.
- Only 1/32 positive cycles covered the historical Aave V2 premium.
- That one cycle did not cover Aave premium plus observed transaction gas.

The strongest case study was block `26115902`:

```
tx 143
0x45b3f5812ff2cb833fc6b3addd7176e5327d35da4e54780604d307289ea4109d
Pancake V3 pool-changing swap

tx 144
0x4f09b8061b26552e7f87826f0d09b2336f4237389395178d1211d148ad326f17
Uniswap V3 -> Pancake V3 WETH cycle
```

The exact route was:

```
WETH
  -> Uniswap V3
USDT
  -> Pancake V3
WETH
```

At the end of block `26115901`, exact quoting showed the route at approximately `-6.40 bps` gross.

The successful same-block arbitrage transaction realized approximately `+12.24 bps` gross.

The opportunity therefore moved by roughly `18.64 bps` inside the block and was already consumed before a post-block scanner could act.

This evidence changes the production thesis:

> The primary opportunity source must be transaction-triggered state changes, not residual finalized-block price differences.

It also changes the funding thesis:

> Flash liquidity is an optional funding source, not the default funding source for every trade. Thin WETH backruns can be viable with owned capital and unviable after adding flash-loan premium.

---

## 2. Goals

The redesigned system MUST:

1. Detect opportunities caused by pending, hinted, or otherwise known trigger transactions.
2. Reprice only routes affected by the trigger.
3. Simulate the trigger before evaluating the backrun.
4. Preserve exact Uniswap V2, SushiSwap V2, Uniswap V3, and Pancake V3 execution semantics.
5. Prioritize WETH while continuing to support DAI and USDC where configured.
6. Choose between owned capital and Aave flash liquidity using net economics.
7. Simulate the ordered bundle:
   ```
   [trigger transaction]
   [our backrun transaction]
   ```
   before any LIVE submission.
8. Submit only privately.
9. Preserve PAPER_ONLY guarantees.
10. Produce enough evidence to determine whether the strategy is economically viable before enabling LIVE.
11. Keep the current post-block scanner available as a fallback/diagnostic path rather than deleting it.
12. Maintain deterministic, replayable historical tests for known mainnet cases.

---

## 3. Explicit non-goals

This implementation does NOT initially attempt:

- sandwich/front-run strategies;
- intentional user harm;
- arbitrary generalized MEV;
- liquidation searching;
- cross-chain arbitrage;
- CEX arbitrage;
- more than 3 executable swaps in production;
- automatic LIVE enablement;
- public-mempool fallback unless explicitly configured;
- blind transaction signing;
- unsigned raw transaction reconstruction from hashes only.

The system is designed as a backrunner: it reacts after a known trigger transaction.

---

## 4. Target architecture

```
                         ORDER FLOW
                +------------------------+
                | public pending tx      |
                | MEV-Share / hints      |
                | custom private source  |
                +-----------+------------+
                            |
                            v
                    TriggerIntake
                            |
                            v
                    TriggerDecoder
                            |
                            v
                 AffectedPoolResolver
                            |
                            v
                   StatePredictor
             (simulate trigger transaction)
                            |
                            v
                 PostTriggerPoolView
                            |
                            v
                  CandidateIndex
               affected routes only
                            |
                            v
                    QuoteEngine
                   exact executable
                            |
                            v
                    TradeSizer
                            |
                            v
                    FundingEngine
                 /                    \
          owned capital             Aave V2
             preferred           only if net viable
                 \                    /
                  +---------+---------+
                            |
                            v
                 BackrunTransactionBuilder
                            |
                            v
                  BundlePlan / Guard
                            |
                            v
                 [trigger + backrun]
                            |
                            v
                  private simulation
                            |
                            v
                    PAPER record
                     or LIVE
                            |
                            v
                 private builder relay
```

---

## 5. Preserve the existing verified production core

The following components remain authoritative and should be reused rather than duplicated:

- `TokenRegistry`
- `PoolRegistry`
- `PoolStateCache`
- DEX adapters
- `CandidateIndex`
- `QuoteEngine`
- `TradeSizer`
- `profitabilityEngine`
- `executionGuard`
- `TradeLedger`
- `PaperBurnIn`
- `TradingStateMachine`
- private relay transport
- readiness checks
- operator authentication
- API rate limits
- production persistence
- frontend operator workspace

The backrun system consumes these modules through explicit interfaces.

---

## 6. New server module layout

Target layout:

```
server/
  backrun/
    triggerIntake.js
    triggerDecoder.js
    affectedPoolResolver.js
    statePredictor.js
    postTriggerQuoter.js
    backrunEngine.js
    fundingEngine.js
    backrunTransactionBuilder.js
    bundlePlan.js
    historicalReplay.js
    backrunLedger.js
    sources/
      publicPending.js
      mevShare.js
      custom.js
```

Initial implementation already introduces:

```
server/backrun/triggerIntake.js
server/backrun/backrunEngine.js
server/backrun/fundingEngine.js
server/backrun/bundlePlan.js
```

These are foundations, not the completed production feature.

---

## 7. TriggerIntake

### Responsibility

Normalize and deduplicate candidate trigger transactions from any supported order-flow source.

### Input model

```js
{
  hash,
  rawTx,              // required for LIVE bundle inclusion
  source,             // public_pending | mev_share | custom
  receivedAt,
  targetBlock,
  affectedPools,
  affectedTokens,
  metadata
}
```

### Requirements

- bounded pending queue;
- hash deduplication;
- source tagging;
- zero signing responsibility;
- no mutation of chain state;
- raw transaction optional in PAPER discovery;
- raw transaction mandatory before LIVE bundle submission.

### Safety

A transaction hash by itself is not enough for LIVE bundle construction.

---

## 8. TriggerDecoder

### Responsibility

Determine what a trigger transaction is expected to do.

### First supported scope

Decode calls that can be deterministically mapped into swaps affecting the tracked pool universe.

Priority order:

1. direct Uniswap V2 router calls;
2. direct SushiSwap V2 router calls;
3. direct Uniswap V3 router calls;
4. direct Pancake V3 router calls;
5. known aggregators where decoding is deterministic;
6. simulation-derived touched-pool detection when calldata decoding alone is insufficient.

### Output

```js
{
  triggerHash,
  swaps: [
    {
      dex,
      poolAddress,
      tokenIn,
      tokenOut,
      amountIn,
      minAmountOut
    }
  ],
  affectedPools,
  affectedTokens,
  confidence,
  decodingMethod
}
```

Unknown or ambiguous triggers must fail closed.

---

## 9. AffectedPoolResolver

The current full candidate universe contains thousands of cycles.

A trigger must not cause the entire universe to be requoted.

The resolver takes:

```
trigger.affectedPools
```

and retrieves only CandidateIndex routes that touch those pools.

Required behavior:

- 2-hop and 3-hop routes only;
- no repeated pool in one route;
- topology identity retained;
- WETH lane ranked first by default;
- DAI and USDC lanes retained;
- route fairness/rotation remains available;
- hard cap from `BACKRUN_MAX_CANDIDATES`.

---

## 10. StatePredictor

This is the core architectural addition.

The engine must answer:

> What will the relevant tracked pool state be immediately after the trigger executes?

Two implementations are permitted.

### 10.1 Preferred production method — transaction simulation

Use a simulator/relay/provider capable of evaluating the trigger transaction against the intended parent state, then read or derive changed pool state after that simulated transaction.

This avoids trying to reimplement every aggregator and router internally.

### 10.2 Deterministic local method — protocol-specific state transition

For direct supported swaps, derive the post-trigger state from decoded calldata and exact pool math.

This is useful for tests and low-latency paths but must match on-chain semantics.

### Required output

```js
{
  triggerHash,
  parentBlock,
  predictedPools: Map<poolAddress, PoolState>,
  changedPools: Set<poolAddress>,
  simulationGas,
  simulationSource,
  predictedAt
}
```

### Required guard

No backrun route may use a mixture of pre-trigger and post-trigger pool state for a changed pool.

---

## 11. Post-trigger exact quote semantics

The current QuoteEngine is block-tag based.

For backrunning, exact quotes need a post-trigger state view.

The implementation should expose a quote adapter that can execute against:

- a local fork after applying the trigger;
- a simulator state override;
- an order-flow provider simulation context;
- another deterministic post-trigger state backend.

Production acceptance requires the quoted route to correspond to the state in which the trigger has already executed.

A normal `eth_call` against the unmodified parent block is not sufficient.

---

## 12. Borrow/settlement asset strategy

### Default backrun priority

```
WETH
DAI
USDC
```

Configuration:

```env
BACKRUN_BORROW_TOKENS=WETH,DAI,USDC
```

This setting is separate from the legacy post-block `BORROW_TOKENS` setting so the legacy scanner does not silently change behavior.

### Why WETH is first

The audited mainnet sample found 32 positive cycles and all 32 were WETH-denominated.

This is evidence for priority, not proof that other assets never produce viable opportunities.

---

## 13. FundingEngine

Funding must be chosen after exact route economics are known.

Supported modes:

```
CAPITAL
FLASH_LOAN
REJECT
```

Configuration:

```env
BACKRUN_FUNDING_MODE=adaptive
BACKRUN_CAPITAL_RESERVE_BPS=1000
```

### CAPITAL

Use tokens already held by the executor when:

```
available capital >= trade size
AND
gross profit - gas - builder cost >= minimum profit
```

A reserve percentage remains untouched.

### FLASH_LOAN

Use Aave V2 only when:

```
Aave liquidity >= amount
AND
gross profit
 - Aave premium
 - gas
 - builder cost
 >= minimum profit
```

### ADAPTIVE

Prefer CAPITAL when viable.

Otherwise test FLASH_LOAN.

Otherwise reject.

The engine must never choose flash liquidity merely because it is available.

---

## 14. Executor contract v3

The existing executor v2 supports Aave-backed execution only.

The redesign requires executor v3.

### Required retained properties

- owner-only execution;
- pause/unpause protection;
- reentrancy protection;
- route continuity validation;
- min output per step;
- balance-delta output accounting;
- no prefunded-token subsidy of flash-loan loss;
- profit recipient isolation;
- allowance cleanup;
- timelock controls;
- no ownership renouncement.

### New entrypoint

```solidity
executeCapitalArbitrage(ArbitrageData calldata data)
```

Behavior:

1. verify executor holds at least `borrowAmount`;
2. snapshot starting token balance;
3. execute route;
4. require final balance >= starting balance + minProfit;
5. transfer only realized profit to `profitRecipient`;
6. retain starting capital inside the executor.

This entrypoint must not borrow from Aave.

### Versioning

```
executorVersion = 3
```

Readiness must reject older executors for the redesigned deployment.

---

## 15. Backrun transaction construction

The transaction builder selects:

```
CAPITAL   -> executeCapitalArbitrage(data)
FLASH_LOAN -> initiateFlashLoan(data)
```

The same swap route representation is used for both.

The transaction builder MUST calculate:

- exact borrow/input amount;
- per-step minimum output;
- minimum net profit;
- gas limit;
- EIP-1559 fee values;
- target block;
- route identity;
- trigger identity;
- funding mode.

---

## 16. Ordered bundle model

The primary LIVE execution object is no longer a single raw transaction.

It is:

```
[
  triggerRawTransaction,
  signedBackrunTransaction
]
```

The trigger MUST be first.

The backrun MUST be second.

The system must never sign or submit a backrun bundle when the raw trigger transaction is unavailable.

---

## 17. Relay changes

`PrivateRelays` must support arrays of signed raw transactions.

Legacy single-transaction usage remains supported through normalization.

Required operations:

```js
simulate([triggerRawTx, backrunSignedTx], targetBlock, stateBlock)
submit(approved, [triggerRawTx, backrunSignedTx], targetBlock, guard)
```

No public transaction submission fallback is permitted.

---

## 18. Bundle simulation validation

Backrun simulation validation MUST verify:

- exactly two expected transaction results for a standard backrun bundle;
- trigger hash matches the expected raw trigger transaction;
- trigger succeeds;
- backrun hash matches the locally signed transaction;
- backrun succeeds;
- state block matches expectation;
- backrun gas is inside configured ceiling;
- direct coinbase transfer is zero unless a future explicit payment model is implemented;
- final exact economics still pass the execution guard.

A trigger simulation failure invalidates the entire opportunity.

---

## 19. PAPER behavior

PAPER must remain unsigned.

In PAPER:

- trigger intake may observe hashes/raw transactions/hints;
- trigger simulation may run;
- post-trigger quotes may run;
- funding decisions may run;
- backrun transaction calldata may be constructed;
- full bundle simulation may run when the provider permits unsigned or locally generated execution context;
- no production private key is loaded;
- no trade transaction is signed;
- no bundle is submitted.

PAPER records should distinguish:

```
DETECTED
POST_TRIGGER_QUOTED
FUNDING_SELECTED
SIMULATED
REJECTED
```

with rejection reasons.

---

## 20. Backrun PAPER telemetry

Required metrics:

- triggers received;
- triggers decoded;
- triggers rejected;
- pools affected;
- candidate routes generated;
- exact post-trigger routes quoted;
- positive gross routes;
- capital-viable routes;
- flash-loan-viable routes;
- bundle simulations attempted;
- bundle simulations profitable;
- bundle simulations rejected;
- median trigger-to-decision latency;
- p95 trigger-to-decision latency;
- expected WETH profit;
- expected DAI profit;
- expected USDC profit;
- funding-mode distribution;
- route DEX-pair distribution;
- missed-trigger causes.

The dashboard must clearly distinguish legacy block scanning from transaction-triggered backrun observation.

---

## 21. Historical replay harness

Before LIVE, the system must support deterministic historical replay.

Primary regression fixture:

```
block: 26115902
trigger:
0x45b3f5812ff2cb833fc6b3addd7176e5327d35da4e54780604d307289ea4109d
backrun:
0x4f09b8061b26552e7f87826f0d09b2336f4237389395178d1211d148ad326f17
```

Expected sequence:

```
state after block 26115901
  -> route not profitable

replay transactions 0..142
  -> quote route

apply trigger transaction 143
  -> route becomes profitable

apply transaction 144
  -> discrepancy is materially reduced/removed
```

The regression test must fail if the system cannot reproduce the opportunity transition within an explicit tolerance.

---

## 22. Multi-day historical benchmark

The nine-hour audit was diagnostic, not enough to justify LIVE capital.

Required benchmark window:

- minimum 7 days;
- preferred 30 days.

Required report:

```
blocks examined
transactions examined
decoded triggers
affected tracked pools
post-trigger positive routes
capital-profitable routes
flash-loan-profitable routes
estimated gas
estimated builder allowance
expected net profit
profit by settlement token
profit by route type
profit by DEX pair
opportunity frequency
median/p95 decision latency budget
capital required for capture percentiles
```

The benchmark must separate:

1. gross arbitrage;
2. owned-capital net arbitrage;
3. flash-loan net arbitrage.

No strategy should be called viable using gross spread alone.

---

## 23. Live order-flow sources

The configuration supports:

```env
BACKRUN_ORDERFLOW_SOURCE=disabled
BACKRUN_ORDERFLOW_SOURCE=public_pending
BACKRUN_ORDERFLOW_SOURCE=mev_share
BACKRUN_ORDERFLOW_SOURCE=custom
```

### disabled

No order-flow listener. Safe default.

### public_pending

Observe public pending transactions.

This is useful but does not expose all private flow.

### mev_share

Consume supported MEV-Share hints/order flow.

Implementation must respect whatever transaction data is actually provided; hints must not be treated as complete raw transactions.

### custom

Explicit integration point for another authenticated order-flow source.

No source may silently fall back to public broadcast.

---

## 24. Legacy block scanner coexistence

The current block scheduler remains valuable for:

- topology discovery;
- canonical state synchronization;
- reorg handling;
- health monitoring;
- residual opportunity diagnostics;
- receipt reconciliation.

The backrun engine should not create a second independent pool registry.

Instead:

```
BlockScheduler
   -> canonical base state

TriggerIntake
   -> ephemeral post-trigger state overlays
```

Post-trigger predicted state is temporary and must never overwrite canonical confirmed state.

---

## 25. Reorg and expiry behavior

Every trigger opportunity is ephemeral.

Reject when:

- parent block changes;
- trigger disappears/replaces;
- nonce becomes invalid;
- target block changes outside allowed horizon;
- simulation state no longer matches;
- quote age exceeds the backrun limit;
- trigger has already landed;
- competing state changes invalidate route economics;
- trading state changes;
- PAPER/LIVE configuration changes.

Never carry an old trigger opportunity into a later unrelated block.

---

## 26. Latency requirements

The current block scanner can tolerate seconds.

Backrunning cannot.

Target architecture budget after trigger receipt:

```
decode/resolution          < 10 ms where cached
affected route lookup      < 5 ms
post-trigger simulation    provider-dependent
route exact quote          bounded and parallel
funding decision           < 5 ms excluding RPC
transaction build          < 5 ms
bundle simulation          provider/relay-dependent
submission                 immediately after approval
```

The code must record actual timing per stage rather than assuming these targets are met.

Performance optimization must never remove economic or safety checks.

---

## 27. Configuration additions

Initial environment surface:

```env
BACKRUN_ENABLED=false
BACKRUN_BORROW_TOKENS=WETH,DAI,USDC
BACKRUN_FUNDING_MODE=adaptive
BACKRUN_CAPITAL_RESERVE_BPS=1000
BACKRUN_MAX_CANDIDATES=32
BACKRUN_ORDERFLOW_SOURCE=disabled
```

Future likely additions:

```env
BACKRUN_MAX_TRIGGER_AGE_MS=
BACKRUN_MAX_DECODER_GAS=
BACKRUN_SIMULATION_TIMEOUT_MS=
BACKRUN_TARGET_BLOCK_OFFSET=
BACKRUN_MAX_CAPITAL_PER_TRADE_WETH=
BACKRUN_MAX_CAPITAL_PER_TRADE_USDC=
MEV_SHARE_URL=
MEV_SHARE_AUTH_KEY=
```

Secrets must never be committed.

---

## 28. API surface

Recommended read endpoints:

```
GET /api/backrun/status
GET /api/backrun/recent-triggers
GET /api/backrun/candidates
GET /api/backrun/simulations
GET /api/backrun/benchmark
```

Mutation endpoints, if later added, must reuse authenticated operator controls and strict rate limiting.

PAPER_ONLY must reject any action capable of signing or submission.

---

## 29. UI changes

Add a Backrun workspace or extend the Opportunities view with:

### Order-flow status

- source;
- connected/disconnected;
- trigger rate;
- decode rate;
- last trigger;
- latency.

### Candidate funnel

```
triggers
decoded
affected routes
gross positive
capital viable
flash viable
bundle simulated
```

### Funding

Show:

- chosen mode;
- executor capital available;
- protected reserve;
- flash premium;
- expected net after funding;
- rejected funding reason.

### Bundle details

Show:

- trigger hash;
- target block;
- trigger source;
- route;
- predicted post-trigger state;
- funding mode;
- expected net;
- simulation status.

PAPER-only mode must remain visually unmistakable.

---

## 30. Database / ledger evolution

Backrun records should persist:

```
id
triggerHash
triggerSource
triggerReceivedAt
targetBlock
parentBlock
affectedPools
candidateId
route
borrowToken
inputAmount
fundingMode
capitalAvailable
flashPremium
grossProfit
gasEstimate
builderAllowance
expectedNetProfit
simulation
status
rejectionReason
createdAt
updatedAt
```

Historical benchmark records should be stored separately from live PAPER execution records.

---

## 31. Security invariants

The redesigned system must preserve and extend the following invariants.

### PAPER

- `PRIVATE_KEY` absent.
- zero signatures.
- zero submissions.
- no LIVE state.
- bundle simulation does not imply submission.

### CAPITAL execution

- only owner may execute;
- executor must hold starting capital;
- principal capital may not be transferred as profit;
- losing route must revert;
- minProfit must be enforced against pre-trade executor balance;
- route continuity enforced;
- slippage minimums enforced.

### FLASH_LOAN execution

Existing v2 invariants remain unchanged.

### Bundle

- trigger order fixed;
- backrun second;
- raw trigger required LIVE;
- simulation required LIVE;
- private relay only;
- stale trigger invalidates submission.

---

## 32. Testing plan

### Unit

- TriggerIntake deduplication.
- queue bounds.
- source normalization.
- affected-route filtering.
- WETH priority.
- adaptive funding prefers owned capital.
- adaptive funding falls back to flash loan.
- funding rejects negative net.
- bundle plan ordering.
- PAPER plan unsigned.
- LIVE plan requires raw trigger.
- bundle simulation hash validation.
- trigger failure rejects bundle.
- backrun failure rejects bundle.

### Contract

- owner-only capital execution.
- owned-capital profitable route succeeds.
- owned-capital loss reverts.
- starting capital preserved.
- profit recipient receives only realized profit.
- pause behavior.
- reentrancy behavior.
- min output enforcement.
- continuity enforcement.

### Historical integration

- block 26115902 case study.
- exact pre-trigger unprofitable quote.
- post-trigger profitable quote.
- post-arbitrage normalization.

### Fork

- local mainnet fork trigger replay.
- capital execution.
- flash-loan fallback.
- trigger+backrun ordered bundle where supported.

### Existing regression

All current core, Hardhat, frontend, build and PAPER hardening tests must continue to pass.

---

## 33. Migration plan

### Phase 0 — baseline freeze

Tag/document `4c9ef5a` as the verified post-block PAPER baseline.

Do not rewrite it.

### Phase 1 — historical replay

Implement deterministic intra-block replay of the known mainnet example.

Acceptance:

- trigger transition reproduced;
- route identity matches;
- quote direction matches observed result.

### Phase 2 — backrun domain core

Implement:

- TriggerIntake;
- affected-route selection;
- FundingEngine;
- BundlePlan.

Acceptance:

- comprehensive unit coverage;
- no production behavior enabled by default.

### Phase 3 — executor v3

Add owned-capital execution.

Acceptance:

- principal preservation;
- profit-only transfer;
- loss reversion;
- existing flash-loan path unchanged.

### Phase 4 — transaction decoding

Implement direct router decoding and pool-affect resolution.

Acceptance:

- known direct swaps decoded;
- unknown calls fail closed.

### Phase 5 — state prediction

Implement trigger simulation / post-trigger state overlay.

Acceptance:

- block 26115902 trigger produces profitable route after trigger and not before.

### Phase 6 — post-trigger quoting and sizing

Wire overlays into exact quote/sizing.

Acceptance:

- no changed pool uses stale pre-trigger state.

### Phase 7 — bundle simulation

Support ordered two-transaction relay simulation.

Acceptance:

- trigger and backrun hashes match;
- both transactions succeed;
- economics remain profitable.

### Phase 8 — historical benchmark

Run 7–30 day benchmark.

Acceptance criteria defined in Section 35.

### Phase 9 — live PAPER order-flow observer

Deploy to VPS with:

```
PAPER_ONLY=true
PRIVATE_KEY=
BACKRUN_ENABLED=true
```

No signing.

Collect at least seven continuous days.

### Phase 10 — LIVE readiness

Only after commissioning evidence is reviewed.

---

## 34. Deployment strategy

The redesigned executor is version 3 and therefore requires a new deployment.

Do not attempt to mutate an existing v2 deployment in place.

Deployment sequence:

```
deploy timelock
deploy executor v3
verify bytecode
record code hash
configure operator
configure recipient
fund executor only if CAPITAL mode will be used
run PAPER preflight
run PAPER smoke
run backrun PAPER burn-in
review commissioning report
only then consider LIVE
```

Funding the executor is an explicit operator action and is never automatic.

---

## 35. Economic acceptance gates

The redesigned system should not progress to LIVE merely because it detects backruns.

Before LIVE, historical + PAPER evidence must show:

1. nonzero post-trigger exact opportunities;
2. nonzero full bundle simulations;
3. positive expected net after:
   - DEX fees;
   - gas;
   - builder allowance;
   - funding cost;
   - configured minimum profit;
4. enough frequency to justify infrastructure cost;
5. latency compatible with intended source;
6. capital requirement understood;
7. expected drawdown understood;
8. no dependence on a single historical anomaly.

A minimum recommended report should include:

```
capital-mode opportunities/day
flash-mode opportunities/day
median net profit
p25/p50/p75/p95 net profit
capital needed p50/p95
gas share of gross profit
builder share of gross profit
failure/rejection distribution
DEX-pair distribution
token distribution
```

No absolute profitability guarantee is possible.

---

## 36. Live risk controls

In addition to existing controls:

- maximum owned capital per token;
- maximum owned capital per trade;
- minimum retained executor reserve;
- maximum trigger age;
- maximum target-block horizon;
- maximum bundle simulation age;
- maximum concurrent trigger evaluations;
- maximum pending submitted bundle;
- per-source circuit breaker;
- automatic pause on relay inconsistency;
- automatic pause on state prediction mismatch;
- automatic pause on unexpected executor balance delta.

---

## 37. Backrun-specific readiness checks

Readiness should eventually verify:

- executor version 3;
- expected contract code hash;
- order-flow source configured;
- order-flow connectivity;
- private relay connectivity;
- post-trigger simulation backend available;
- funding configuration valid;
- executor token balances visible;
- no signing key in PAPER;
- database healthy;
- historical benchmark present;
- backrun PAPER burn-in present;
- no unresolved submitted bundles.

---

## 38. Rollback

The implementation must remain reversible.

Because the backrun engine is additive:

```env
BACKRUN_ENABLED=false
```

must disable all transaction-triggered opportunity processing and leave the existing confirmed-block scanner intact.

Executor v3 retains the flash-loan entrypoint, so the existing route executor remains available.

---

## 39. Current implementation progress on this branch

The branch now contains the additive implementation candidate:

- bounded trigger intake and public pending / MEV-Share / authenticated custom sources;
- direct V2/V3 router decoding and simulation-derived aggregator impact;
- canonical CandidateIndex reuse against ephemeral post-trigger pool overlays;
- isolated chain-1 fork prediction, exact post-trigger quoting and sizing;
- measured CAPITAL / FLASH_LOAN selection with reserves and per-token risk limits;
- executor v3, synchronized ABIs and retained flash-loan invariants;
- ordered unsigned PAPER fork simulation and signed private LIVE bundle validation;
- shared pending-submission / receipt accounting and signing safety;
- intra-block replay harness with canonical receipt fidelity checks;
- complete-coverage historical economics benchmark and funding-path proof output;
- PostgreSQL backrun/benchmark migration, durable journal and read APIs;
- Backrun observer workspace with latency, funding and rejection details;
- backrun preflight, smoke and evidence-backed commissioning report commands;
- VPS host-service templates and a documented rollback;
- deterministic, contract, frontend, persistence and controlled local-chain checks.

See [the implementation runbook](BACKRUN_ENGINE.md) for commands, limitations and
source interfaces. The existing post-block baseline remains available by setting
BACKRUN_ENABLED=false. Default production behavior remains disabled.

The following empirical acceptance items are still outstanding:

- actual canonical replay of mainnet block 26115902 with an archive RPC;
- isolated proof that transaction 143, rather than transaction 84, created the edge;
- measured seven-to-thirty-day historical economics through executor v3;
- real mainnet-fork evidence for both funding paths;
- deployed/verified executor v3 and explicitly funded capital when used;
- VPS deployment and seven continuous days of unsigned live order-flow PAPER;
- at least one profitable ordered bundle observation under actual configuration;
- operator economic/risk acceptance and explicit LIVE election.

The audit transcript and mock/local-chain test results are not substitutes for
these items. The branch is therefore an implementation candidate with closed
commissioning gates, not a production-ready backrunner. Main stays at the proven
baseline until the requested acceptance evidence is available and reviewed.

---

## 40. Definition of done

The redesign is complete only when all of the following are true:

- known historical trigger/backrun is reproduced deterministically;
- trigger-driven candidate generation is implemented;
- WETH-first multi-token route selection works;
- post-trigger state simulation is exact enough for execution decisions;
- CAPITAL and FLASH_LOAN funding paths both pass contract/fork tests;
- ordered bundle simulation is mandatory;
- private-only submission remains mandatory;
- PAPER_ONLY remains impossible to sign from;
- all existing tests pass;
- all new tests pass;
- frontend exposes backrun observability;
- 7–30 day historical economics are documented;
- seven-day live PAPER order-flow burn-in is complete;
- at least one full profitable backrun bundle simulation is observed;
- commissioning report passes;
- operator explicitly elects to enable LIVE.

---

## 41. Final implementation principle

The previous architecture answered:

> Is there a profitable cycle in confirmed state?

The new architecture answers:

> If this known transaction executes first, will it create a profitable cycle that we can safely and privately capture immediately afterward?

That is the governing design principle for every change in this blueprint.
