# Flashloan Arbitrage — Completion Blueprint

This blueprint is based on the **actual `Flashloan-Aabitrage` codebase on `main` that we just reviewed**, rather than the README. The objective should now be to **finish and harden the existing system**, not redesign it from scratch.

The target is a personal, production-capable arbitrage engine with a very simple operational model:

```text
LIVE DEX STATE
      │
      ▼
OPPORTUNITY DISCOVERY
      │
      ▼
EXACT ROUTE + EXACT POOLS
      │
      ▼
OPTIMAL TRADE SIZE
      │
      ▼
EXACT QUOTES
      │
      ▼
FLASHLOAN + GAS + BUILDER COST
      │
      ▼
REAL NET PROFIT
      │
      ▼
FULL TRANSACTION SIMULATION
      │
      ▼
PRIVATE BUNDLE SIMULATION
      │
      ▼
PRIVATE EXECUTION
      │
      ▼
RECEIPT + REALIZED P&L
```

The repository already contains most components needed for this. Completion should therefore be divided into **eight implementation phases**.

---

# Phase 0 — Freeze the production scope

Before changing code, simplify what we're trying to make reliable.

For the first production release I would make the supported core:

```text
Network
└── Ethereum mainnet initially

Flash liquidity
└── Aave

DEX execution
├── Uniswap V2
├── Uniswap V3
├── SushiSwap V2
└── PancakeSwap V3

Strategies
├── 2-leg cross-DEX arbitrage
└── 3-leg triangular arbitrage

Transaction submission
├── Flashbots
└── approved private relays

Modes
├── PAPER
└── LIVE

Disabled initially
├── mempool backrunning
├── RL-controlled trading decisions
├── cross-chain execution
├── Connext auto forwarding
├── long-cycle Bellman-Ford trading
└── public mempool fallback
```

Balancer and Curve can remain in the repository, but I would **not make production launch depend on them**.

This drastically reduces the number of things that can invalidate an otherwise profitable opportunity.

The first production invariant becomes:

> A trade can only be submitted when the exact pools, exact route, exact trade size, exact flash-loan cost, estimated gas, builder payment and minimum required profit have all been validated against current chain state.

---

# Phase 1 — Rebuild opportunity discovery correctly

This is the highest-priority work.

Current major files:

```text
server/scripts/routeFinder.js
server/scripts/liquidityScanner.js
server/scripts/onchainPools.js
server/scripts/incrementalGraph.js
server/scripts/priceIngestion.js
```

## 1.1 Replace token-only graph edges

The current graph effectively reasons primarily about:

```text
TOKEN A
   ↓
TOKEN B
```

Production arbitrage needs:

```text
TOKEN A
   │
   ├── Uniswap V3 pool X
   ├── Uniswap V3 pool Y
   ├── Sushi pool Z
   └── Pancake pool P
   │
   ▼
TOKEN B
```

Every graph edge should become something approximately equivalent to:

```javascript
{
    chainId,
    dex,
    protocolVersion,

    poolAddress,
    poolId,

    tokenIn,
    tokenOut,

    tokenInDecimals,
    tokenOutDecimals,

    feeTier,
    feeBps,

    liquidity,

    quoteMethod,

    metadata
}
```

The important architectural change is:

> **Pool identity must survive from discovery all the way through transaction execution.**

Never rediscover the pool later from just:

```text
tokenA + tokenB
```

---

# 1.2 First-class two-pool cycles

Explicitly support:

```text
WETH
 │
 │ Uniswap
 ▼
USDC
 │
 │ Sushi
 ▼
WETH
```

as a valid cycle.

The route finder must not interpret this as meaningless backtracking.

The scanner should directly enumerate parallel-market combinations.

For each token pair:

```text
Pool A
Pool B
Pool C
Pool D
```

test:

```text
A → B
A → C
A → D
B → A
B → C
B → D
...
```

where the outbound and inbound pool are different.

For two-pool arbitrage this is much more deterministic than attempting to derive everything through generic cycle detection.

---

# 1.3 Build a dedicated cross-DEX scanner

I would introduce something like:

```text
server/scripts/crossDexScanner.js
```

Its job:

```text
group pools by canonical pair
        ↓
identify multiple trading venues
        ↓
quote direction A→B→A
        ↓
quote opposite direction B→A→B
        ↓
calculate gross spread
        ↓
estimate feasible size
        ↓
produce candidate
```

A candidate should carry:

```javascript
{
    id,
    chain,
    borrowToken,

    legs: [
        {
            dex,
            poolAddress,
            poolId,
            tokenIn,
            tokenOut,
            fee
        },
        {
            dex,
            poolAddress,
            poolId,
            tokenIn,
            tokenOut,
            fee
        }
    ],

    stateBlock,
    discoveredAt
}
```

No information should be reconstructed later.

---

# 1.4 Keep triangular routes separately

The existing DFS functionality is useful for:

```text
DAI
 ↓
WETH
 ↓
USDC
 ↓
DAI
```

Keep it, but make it a separate strategy:

```text
strategy = CROSS_DEX_TWO_LEG
strategy = TRIANGULAR_THREE_LEG
```

Do not make one generic algorithm responsible for both.

---

# Phase 2 — Establish a canonical token and pool model

There are currently assumptions around 18-decimal tokens that must disappear.

Add a central registry/service.

Suggested location:

```text
server/services/tokenRegistry.js
```

or under the existing structure:

```text
server/scripts/tokenMetadata.js
```

Each token record should contain:

```javascript
{
    address,
    chainId,
    symbol,
    decimals
}
```

Examples:

```text
DAI    18
WETH   18
USDC    6
USDT    6
WBTC    8
```

All calculations must use token-specific units.

This affects:

```text
routeFinder.js
ammMath.js
swapDataBuilder.js
botLogic.js
optimalParams.js
price conversion
profit calculation
dashboard formatting
database persistence
```

There should be **no generic `parseUnits(..., 18)` in pricing logic unless the token is explicitly known to use 18 decimals**.

---

# Phase 3 — Replace approximate profitability with a deterministic quote pipeline

The current repository has several different profitability concepts.

They should converge into one pipeline.

## Candidate stage

Use cheap calculations to reduce the search space.

```text
thousands of pools
       ↓
coarse spread check
       ↓
hundreds of routes
       ↓
liquidity filter
       ↓
tens of serious candidates
```

Approximation is acceptable here.

## Validation stage

For every serious candidate:

```text
exact DEX quote
       ↓
exact next-hop quote
       ↓
exact resulting final amount
```

Then:

```text
grossProfit =
finalAmount
- borrowedAmount
- flashLoanPremium
```

Then:

```text
netProfit =
grossProfit
- estimatedGasCost
- estimatedBuilderPayment
```

Only `netProfit` should decide whether the opportunity progresses.

---

# 3.1 Fix the fee accounting

Do not apply pool fees twice.

If a DEX quote already returns executable output:

```text
getAmountsOut()
Quoter
queryBatchSwap()
get_dy()
```

the resulting amount already incorporates protocol pricing/fee mechanics.

Therefore:

```text
DEX executable quote
    ↓
do NOT subtract pool fee again
```

Fee-adjusted mathematical spot rates should be used only when working from raw pool state.

---

# 3.2 One profitability object

Introduce one canonical structure used everywhere:

```javascript
{
    borrowToken,
    borrowAmount,

    expectedFinalAmount,

    flashloanFee,
    grossProfit,

    estimatedGasUnits,
    estimatedGasCostNative,
    estimatedGasCostBorrowToken,

    estimatedBuilderPaymentNative,
    estimatedBuilderPaymentBorrowToken,

    expectedNetProfit,

    minimumRequiredProfit,

    profitable
}
```

This should replace duplicated profit calculations across the application.

---

# Phase 4 — Finish optimal trade sizing

You already have a good starting point in:

```text
server/scripts/ammMath.js
```

especially `findOptimalInput()`.

Keep that for V2-like pools.

## V2

For constant-product pools:

```text
mathematical optimisation
       ↓
exact quote around optimum
       ↓
final optimum
```

This is already close.

## V3

Do not rely solely on virtual reserves.

Use virtual reserves only to locate the approximate region.

For example:

```text
approximate optimum = 25,000 DAI

test:
15,000
18,750
21,250
23,750
25,000
26,250
28,750
31,250
35,000
```

through the actual V3 Quoter.

Then refine around the best point.

Eventually:

```text
coarse search
     ↓
real quotes
     ↓
local binary/ternary refinement
     ↓
actual maximum-net-profit size
```

The optimisation target should be:

```text
NET PROFIT
```

not gross swap output.

That means size optimisation should include:

```text
price impact
DEX fees
flashloan premium
gas
builder payment
```

---

# Phase 5 — Clean the protocol adapters

Create a clean execution boundary.

Something conceptually like:

```text
server/dex/
├── uniswapV2.js
├── uniswapV3.js
├── sushiV2.js
├── pancakeV3.js
├── balancer.js
└── curve.js
```

Each adapter implements a common API:

```javascript
discoverPools()
getPoolState()
quoteExactInput()
buildSwapStep()
validatePool()
```

The searcher shouldn't need protocol-specific details.

---

# 5.1 PancakeSwap V3

This is currently missing and should be added if it is part of the intended strategy.

It should support:

```text
factory discovery
pool fee tiers
pool liquidity
slot0
quoteExactInputSingle
router execution
```

On-chain execution can potentially reuse the Uniswap-V3-like execution abstraction where interfaces are compatible, but addresses and exact protocol behaviour must remain explicitly configured.

---

# 5.2 Fix Balancer metadata

If Balancer remains enabled, every route must retain:

```text
poolId
vault
tokens
direction
```

A zero `poolId` fallback must **not** be accepted for live execution.

Change the behaviour from:

```text
missing poolId
   ↓
HashZero
```

to:

```text
missing poolId
   ↓
candidate invalid
```

---

# 5.3 Fix Curve metadata

Standardize:

```text
curveIndexIn
curveIndexOut
curveUnderlying
```

from discovery through:

```text
route
→ quote
→ SwapStep
→ contract
```

One canonical schema only.

---

# Phase 6 — Standardize the flash-loan layer

Right now the repository has Aave-V2-style contract execution alongside some V3-oriented off-chain configuration.

Pick one initial implementation.

For the existing contract, the least disruptive path is:

```text
Aave V2
```

for the first hardened release.

Make the configuration unambiguous:

```javascript
flashloanProvider: {
    protocol: "aave",
    version: 2,
    addressesProvider,
    lendingPool
}
```

Remove logic that says "prefer V3" if the contract cannot actually use it.

Then later abstract this behind something like:

```text
IFlashLoanProvider
```

conceptually:

```text
                   FlashLoanProvider
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
          Aave V2                  Balancer
```

But don't block first production on multi-provider flash liquidity.

---

# Phase 7 — Harden transaction execution

This should become a strict pipeline with **no optional safety steps**.

Current relevant files:

```text
server/botLogic.js
server/scripts/flashbotsUtils.js
server/scripts/multiRelay.js
server/scripts/tipCalculator.js
server/scripts/riskManager.js
```

The final execution pipeline should be:

```text
Candidate
   ↓
fresh pool state
   ↓
recompute optimal amount
   ↓
exact route quote
   ↓
construct ArbitrageData
   ↓
eth_call / callStatic
   ↓
estimateGas
   ↓
calculate gas cost
   ↓
calculate builder payment
   ↓
recalculate net profit
   ↓
sign transaction
   ↓
private bundle simulation
   ↓
recalculate using simulation gas
   ↓
profit still above threshold?
   │
   ├── NO → drop
   │
   └── YES
         ↓
      submit privately
```

---

# 7.1 Make bundle simulation mandatory

You already have:

```text
flashbotsUtils.simulateBundle()
```

Wire it into `botLogic.js`.

Bundle simulation must check:

```text
transaction doesn't revert
gas usage
coinbase payment if applicable
state-block validity
all transaction results successful
```

Failure means:

```text
DROP OPPORTUNITY
```

not "try anyway."

---

# 7.2 Fix the DAI/ETH builder-tip bug

This is a launch blocker.

Current conceptual bug:

```text
netDAI
   ↓
expectedProfitWei
   ↓
interpreted as ETH
```

Correct process:

```text
profit in DAI
      ↓
current executable DAI→WETH quote
      ↓
profit in native ETH terms
      ↓
allowed builder budget
      ↓
priority fee / builder payment
```

Create explicit unit names.

Do not use ambiguous names such as:

```text
profitWei
```

when the unit might actually be DAI base units.

Prefer:

```javascript
profitBorrowToken
profitNativeWei
gasCostNativeWei
builderPaymentNativeWei
```

This makes unit errors much harder.

---

# 7.3 Enforce maximum builder budget

Introduce:

```text
MAX_BUILDER_SHARE_BPS
```

For example conceptually:

```text
builder payment <= configurable portion of gross opportunity
```

But the important invariant is:

```text
net profit after builder payment >= minimum required profit
```

The bot should dynamically refuse inclusion rather than chase a trade into negative economics.

---

# 7.4 Completely disable public fallback in production

Keep:

```text
ALLOW_PUBLIC_MEMPOOL_FALLBACK=false
```

and additionally enforce the production profile so it cannot accidentally become enabled.

Production should effectively be:

```text
private transaction accepted
         ↓
submit

private path unavailable
         ↓
DROP
```

not:

```text
private unavailable
       ↓
public mempool
```

---

# Phase 8 — Separate paper trading from live trading

This should be backend enforced.

Introduce a real trading state machine.

```text
STOPPED
   │
   ├─────────────► PAPER
   │
   │                │
   │                ▼
   │            simulated trading
   │
   │
   └─────────────► LIVE_ARMED
                     │
                     ▼
                 LIVE_RUNNING
                     │
                     ▼
                   PAUSED
```

I would simplify that in the UI to:

```text
STOPPED

PAPER
Scanning + simulation
No signing
No transaction submission

LIVE
Real transaction signing
Real flashloan execution
```

But internally distinguish armed/running for safety.

---

# 8.1 PAPER mode

PAPER mode should execute every step except transaction signing and submission.

It should do:

```text
discover
size
quote
construct transaction
callStatic
estimate gas
bundle simulate where possible
record hypothetical execution
```

Then record:

```javascript
{
    mode: "paper",

    opportunity,

    expectedProfit,
    expectedGas,
    expectedBuilderCost,

    simulatedSuccess,

    reasonExecutedOrRejected
}
```

---

# 8.2 LIVE mode

Starting the bot should **not automatically imply LIVE**.

Make it:

```text
Start scanner
      ↓
PAPER by default
```

Going live requires another explicit action.

The backend must reject transaction submission unless:

```text
TRADING_MODE === LIVE
AND
live trading is armed
AND
risk manager allows trade
AND
contract not paused
AND
private execution available
```

---

# Phase 9 — Turn realized P&L into the source of truth

The dashboard currently relies too heavily on predicted profit.

After a transaction lands, get its actual receipt.

Record:

```text
transaction hash
block number
borrow amount
flashloan premium
route
pools
actual gas used
effective gas price
actual gas cost
builder payment
profit-recipient balance change
realized gross profit
realized net profit
estimated profit
estimation error
```

Database trade status should evolve through:

```text
DISCOVERED
SIMULATED
SUBMITTED
INCLUDED
REVERTED
DROPPED
```

rather than just a generic success status.

---

# 9.1 Profit accuracy metric

Track:

```text
predictionError =
realizedProfit - expectedProfit
```

Then expose:

```text
mean prediction error
median prediction error
p95 prediction error
```

This becomes extremely useful when tuning the bot.

A profitable arbitrage bot needs more than:

```text
"found opportunity"
```

It needs to know:

```text
"our model predicted £34.18 and actually earned £31.73"
```

---

# Phase 10 — Simplify the risk engine

Keep the useful controls.

Production trading should reject an opportunity when any of these occurs:

```text
profit below minimum
gas above ceiling
pool state stale
quote stale
RPC unhealthy
route incomplete
token metadata missing
pool metadata missing
private relay unavailable
bundle simulation fails
contract paused
daily risk threshold exceeded
trade size exceeds configured maximum
```

I would add:

```text
MAX_BORROW_AMOUNT
MAX_SINGLE_TRADE_GAS
MAX_ROUTE_HOPS
MAX_QUOTE_AGE_MS
MAX_POOL_STATE_AGE_MS
MAX_PRICE_MOVEMENT_BPS
MAX_BUILDER_SHARE_BPS
```

Avoid "proceeding anyway" branches around safety-critical validation.

For example:

```text
sanity check error
      ↓
currently potentially proceed
```

should become:

```text
sanity check unavailable
      ↓
DROP TRADE
```

in LIVE mode.

PAPER mode can continue for diagnostics.

---

# Phase 11 — Remove V1 backrunning risk

Keep the code, but feature-gate it completely off for the first live release:

```text
MEMPOOL_MONITORING=false
```

Also fix before re-enabling:

```javascript
amountOutMinimum = 0
```

which appears in the current backrun path.

Backrunning should eventually have:

```text
actual post-target simulation
bundle containing target + backrun where applicable
non-zero minimum output
exact profitability
private-only submission
```

But that's a separate MEV strategy.

It should not share the completion milestone with normal cross-DEX arbitrage.

---

# Phase 12 — Simplify ML and RL roles

The existing ML/RL components can remain, but they should **never override deterministic economics**.

Correct priority:

```text
Mathematical / on-chain profitability
              │
              ▼
            TRUE?
           /    \
         NO      YES
         │        │
       reject     ▼
             ML ranking
                 │
                 ▼
              execution
```

Never:

```text
ML says 95%
     ↓
execute even though economics uncertain
```

ML should help prioritize candidates.

RL can help experiment with things like:

```text
candidate ordering
quote sampling
non-critical slippage heuristics
```

but not bypass hard execution constraints.

---

# Phase 13 — Refactor `botLogic.js`

At roughly 100 KB, `botLogic.js` is carrying too many responsibilities.

Do not rewrite the entire project.

Extract it incrementally.

Target structure:

```text
server/
├── bot/
│   ├── coordinator.js
│   ├── opportunityEngine.js
│   ├── executionEngine.js
│   ├── profitabilityEngine.js
│   ├── tradeSizer.js
│   └── stateMachine.js
│
├── dex/
│   ├── uniswapV2.js
│   ├── uniswapV3.js
│   ├── sushiV2.js
│   └── pancakeV3.js
│
├── flashloan/
│   └── aaveV2.js
│
├── execution/
│   ├── flashbots.js
│   ├── privateRelays.js
│   └── builderTip.js
│
├── market/
│   ├── tokenRegistry.js
│   ├── poolRegistry.js
│   └── marketState.js
│
└── risk/
    └── executionGuard.js
```

Then `botLogic.js` can become mostly an orchestrator.

---

# Phase 14 — Dashboard completion

The existing React UI is already substantial.

Keep:

```text
Overview
Route Candidates
Live Opportunities
ML Analytics
Simulator
Bot Status
```

Add one clear top-level control.

```text
┌──────────────────────────────────────────────────────────────┐
│ FLASHLOAN ARBITRAGE                         ● PAPER          │
├──────────────────────────────────────────────────────────────┤
│ Bot: RUNNING     RPC: HEALTHY      Contract: READY           │
│ Private Relay: READY               Wallet: CONNECTED         │
├──────────────────────────────────────────────────────────────┤
│ Expected P&L     Realized P&L      Gas       Opportunities   │
│  +42.71 DAI       +37.12 DAI      0.014 ETH      17          │
└──────────────────────────────────────────────────────────────┘
```

Most importantly:

```text
[ PAPER ]             [ GO LIVE ]
```

When live:

```text
██████████████████████████████████
LIVE MODE — REAL FUNDS
██████████████████████████████████
```

No ambiguity.

---

# 14.1 Replace decorative Auto Execute

The existing `RealTimeOpportunities.jsx` auto-execute switch should either:

1. actually call a backend setting that enforces execution state, or
2. be removed.

UI-only safety controls should not exist.

---

# 14.2 Add an execution panel

For the currently selected opportunity display:

```text
Route
DAI
 → WETH | Uniswap V3 0.05%
 → DAI  | Sushi V2

Borrow
24,360 DAI

Expected final
24,408.92 DAI

Flashloan fee
21.92 DAI

Gas
8.31 DAI

Builder payment
4.50 DAI

Expected net
14.19 DAI

Simulation
PASS

Private relay
READY
```

This will make validating the live system far easier.

---

# Phase 15 — Security cleanup

The current dashboard model is acceptable for personal/private operation, but I'd enforce:

```text
dashboard inaccessible publicly
VPN / Tailscale / localhost
backend API key server-side
wallet private key never exposed to browser
```

The browser should never contain a credential capable of moving funds.

The wallet/signing process remains backend-only.

For production, also verify:

```text
contract owner
profitRecipient
timelock
contract paused status
chain ID
contract bytecode hash
configured routers
configured Aave provider
```

at startup.

If any mismatch:

```text
LIVE MODE REFUSED
```

---

# Phase 16 — Smart-contract hardening

The current contract is fairly close.

I'd avoid major redesign before testing.

Focus on invariants.

Required tests:

```text
only owner can initiate flashloan
only Aave callback accepted
bad initiator rejected
first token must equal borrow token
last token must equal borrow token
route continuity enforced
every swap respects min output
principal always repaid
premium always repaid
minimum profit always enforced
loss can never settle
profit transferred correctly
pause prevents execution
reentrancy prevented
unsupported DEX fails
malformed pool metadata fails
```

Keep the existing property/fuzz tests.

Expand them around arbitrary:

```text
route lengths
amounts
fees
slippage
premium
token balances
```

---

# Phase 17 — Mainnet fork proof

This is the final technical gate before paper trading.

Use a fixed historical block where an actual cross-DEX discrepancy can be reproduced.

The test should:

```text
fork Ethereum at block N
        ↓
deploy current ArbitrageFlashloan
        ↓
impersonate/fund operator
        ↓
discover real pools
        ↓
construct exact route
        ↓
request flash loan
        ↓
execute swaps against real contracts
        ↓
repay real Aave fork state
        ↓
assert profitRecipient increased
```

Do not mock:

```text
DEXes
flashloan
reserves
quote
token balances
```

for this test.

That gives us our first true end-to-end proof.

---

# Phase 18 — Paper-production burn-in

Before real-money trading, run the actual production application in PAPER mode.

Recommended minimum:

```text
7 days continuous
```

Prefer:

```text
14 days
```

Collect:

```text
opportunities detected
opportunities exactly simulated
opportunities rejected
expected profit
predicted gas
predicted builder cost
quote expiry rate
private relay simulation pass rate
would-have-landed rate
RPC failure rate
pool-state staleness
```

Most importantly, classify every missed trade.

```text
Not profitable
State changed
Gas too high
Builder cost too high
Bundle simulation failed
Private inclusion unavailable
Risk gate
Quote expired
```

---

# Phase 19 — Controlled live commissioning

Do not immediately permit 100k DAI flash loans.

Commission gradually.

### Stage A

```text
MAX_BORROW = 1,000 DAI
MIN_NET_PROFIT = high
one pair
one DEX combination
```

Verify several successful executions.

### Stage B

```text
MAX_BORROW = 5,000 DAI
```

### Stage C

```text
MAX_BORROW = 10,000–25,000 DAI
```

### Stage D

Allow optimal sizing up to the configured production maximum.

Because flash loans don't require us to provide the principal, the cap is primarily about:

```text
execution risk
price impact
gas exposure
operational confidence
```

rather than capital requirements.

---

# Phase 20 — Production acceptance gates

I would not call this repository complete until every one of these passes.

### Discovery

```text
✓ same-pair parallel DEX pools represented independently
✓ two-leg cross-DEX routes found correctly
✓ three-leg routes found correctly
✓ exact pool IDs retained
✓ token decimals correct
✓ no fee double counting
```

### Quoting

```text
✓ every hop exactly quoted
✓ output from hop N becomes input to hop N+1
✓ V3 ticks handled through Quoter
✓ slippage bound generated
✓ quote freshness enforced
```

### Sizing

```text
✓ optimal amount maximizes net profit
✓ own price impact included
✓ flashloan premium included
✓ gas included
✓ private-builder payment included
```

### Contract

```text
✓ exact route encoded
✓ minAmountOut every hop
✓ minProfit final guard
✓ atomic failure
✓ flash loan fully repaid
```

### Execution

```text
✓ callStatic succeeds
✓ estimateGas succeeds
✓ private bundle simulation succeeds
✓ private relay only
✓ public fallback disabled
```

### Accounting

```text
✓ actual receipt captured
✓ actual gas captured
✓ actual recipient profit measured
✓ expected vs realized P&L stored
```

### Operations

```text
✓ PAPER/LIVE backend mode
✓ scanner can run without signing
✓ LIVE requires explicit arming
✓ emergency pause works
✓ risk breaker works
✓ RPC failover works
✓ stale data fails closed
```

### UI

```text
✓ actual mode displayed
✓ actual realized profit shown
✓ opportunity route/pools shown
✓ transaction hashes shown
✓ rejected opportunity reason shown
✓ risk status shown
```

---

# Implementation order

I would do the work in this exact dependency order:

```text
1  Canonical token metadata / decimals
       ↓
2  Canonical PoolEdge model
       ↓
3  Dedicated two-DEX scanner
       ↓
4  Exact pool-preserving route model
       ↓
5  Fee-accounting correction
       ↓
6  Exact quote pipeline
       ↓
7  V2/V3 optimal sizing
       ↓
8  Pancake V3 adapter
       ↓
9  Aave version cleanup
       ↓
10 Flashbots mandatory simulation
       ↓
11 Native-vs-token unit cleanup
       ↓
12 Dynamic tip fix
       ↓
13 Actual receipt/P&L accounting
       ↓
14 PAPER/LIVE backend state machine
       ↓
15 Dashboard mode + execution details
       ↓
16 Mainnet-fork E2E proof
       ↓
17 Paper burn-in
       ↓
18 Controlled live commissioning
```

That order matters. There's little value improving the dashboard or ML system before the opportunity engine is mathematically exact.

---

# What I would *not* work on yet

Until that list is finished, I would deliberately avoid spending development time on:

```text
additional chains
more machine learning
more reinforcement learning
Connext
cross-chain arbitrage
new Grafana dashboards
Kubernetes complexity
mempool backrunning
long arbitrage cycles
Balancer flash loans
additional lending protocols
public-user SaaS functionality
```

Those features can make the repository look more sophisticated while doing almost nothing to improve its ability to make a correctly identified profitable trade.

---

# Target finished architecture

The finished core should be this:

```text
                  ┌─────────────────────┐
                  │   MARKET INGESTION  │
                  │ WS + RPC + events   │
                  └──────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │    POOL REGISTRY    │
                  │ exact pool identity │
                  └──────────┬──────────┘
                             │
               ┌─────────────┴──────────────┐
               ▼                            ▼
     ┌────────────────────┐      ┌────────────────────┐
     │ CROSS-DEX SCANNER  │      │ TRIANGLE SCANNER   │
     └──────────┬─────────┘      └─────────┬──────────┘
                └────────────┬─────────────┘
                             ▼
                  ┌─────────────────────┐
                  │  CANDIDATE ENGINE   │
                  └──────────┬──────────┘
                             ▼
                  ┌─────────────────────┐
                  │    TRADE SIZER      │
                  │ max NET profit      │
                  └──────────┬──────────┘
                             ▼
                  ┌─────────────────────┐
                  │    EXACT QUOTER     │
                  └──────────┬──────────┘
                             ▼
                  ┌─────────────────────┐
                  │ PROFITABILITY ENGINE│
                  │ swap                │
                  │ + flashloan         │
                  │ + gas               │
                  │ + builder payment   │
                  └──────────┬──────────┘
                             ▼
                  ┌─────────────────────┐
                  │    RISK ENGINE      │
                  └──────────┬──────────┘
                             ▼
                  ┌─────────────────────┐
                  │ ON-CHAIN SIMULATION │
                  └──────────┬──────────┘
                             ▼
                  ┌─────────────────────┐
                  │ BUNDLE SIMULATION   │
                  └──────────┬──────────┘
                             │
                     PAPER ──┤── LIVE
                             │
                             ▼
                  ┌─────────────────────┐
                  │ PRIVATE EXECUTION   │
                  └──────────┬──────────┘
                             ▼
                  ┌─────────────────────┐
                  │ ArbitrageFlashloan  │
                  │                     │
                  │ Aave → swaps → repay│
                  │      → profit       │
                  └──────────┬──────────┘
                             ▼
                  ┌─────────────────────┐
                  │ RECEIPT ACCOUNTING  │
                  │ realized P&L        │
                  └─────────────────────┘
```

## Final target

When this blueprint is complete, operating the bot should be very simple:

```text
Open dashboard
      ↓
PAPER mode starts
      ↓
watch verified opportunities
      ↓
review simulated economics
      ↓
GO LIVE
      ↓
bot finds opportunity
      ↓
bot proves profit
      ↓
bot simulates exact transaction
      ↓
bot sends privately
      ↓
flash loan executes atomically
      ↓
profit reaches wallet
      ↓
dashboard shows REALIZED profit
```

So I would treat the current repository as roughly **the foundation plus most infrastructure already complete**, and this blueprint as the work needed to turn that infrastructure into a **deterministic, auditable and genuinely live-ready arbitrage system**.

The **first implementation milestone should be Phases 1–4 together**: fix token decimals, rebuild the pool-edge model, implement first-class two-DEX arbitrage, eliminate fee-accounting ambiguity, and connect it to the existing exact quote/optimal-size machinery. Once that part is correct, the rest of the repo becomes much easier to commission safely.