# Transaction-Triggered Backrun Architecture

## Why this exists

The previous production core is a finalized-block scanner. It is correct for residual
cross-DEX discrepancies, but commissioning evidence showed that a representative
real mainnet opportunity was created and removed inside the same block:

- block 26115902, transaction index 143 touched the tracked Pancake V3 pool;
- transaction index 144 immediately executed the tracked Uniswap V3 -> Pancake V3
  WETH cycle;
- the exact route at block 26115901 was -6.40 bps gross;
- the executed route was +12.24 bps gross;
- the same route was positive with owned WETH after observed gas, but negative after
  adding the historical Aave V2 premium.

The implementation therefore keeps the proven block scanner as a fallback/diagnostic
path and adds a separate transaction-triggered backrun path. The two strategies must
not be conflated in telemetry or commissioning evidence.

## Safety model

The backrun subsystem is disabled by default.

```env
BACKRUN_ENABLED=false
BACKRUN_ORDERFLOW_SOURCE=disabled
BACKRUN_MEV_SHARE_STREAM_URL=https://mev-share.flashbots.net
```

PAPER remains unsigned. A PAPER backrun plan never contains a signed transaction.
LIVE backruns require all of the following:

1. the ordinary LIVE readiness gates;
2. a raw trigger transaction;
3. a signed backrun transaction created only after profitability checks;
4. an ordered two-transaction bundle simulation;
5. successful trigger and backrun hashes in that simulation;
6. measured backrun gas within the configured ceiling;
7. private relay submission only.

A backrun must fail closed when the trigger cannot be reproduced or when the
post-trigger state cannot be evaluated. The implementation does not silently fall
back from private/hinted order flow to public-mempool execution.

## Components

### `server/backrun/triggerIntake.js`

Bounded, deduplicating trigger queue. A trigger contains:

```js
{
  hash,
  rawTx,            // required for LIVE bundle construction
  affectedPools,    // canonical pool addresses from decoder/hints
  receivedAt,
  source
}
```

The intake deliberately does not guess affected pools from incomplete information.
The order-flow adapter/decoder must provide them.

### `server/backrun/mevShareSource.js`

Built-in read-only SSE client for the Flashbots MEV-Share mainnet hint stream. It
reconnects with bounded exponential backoff, emits normalized transaction hints, and
never signs or submits transactions. The hint stream may contain swap logs, calldata,
function selectors or only a transaction hash depending on the originating user's
privacy preferences. Hints without enough tracked-pool information are rejected by
the decoder rather than guessed.

### `server/backrun/backrunEngine.js`

Builds two- and three-leg cycles from the existing canonical `PoolRegistry`, limits
them to routes touching the trigger's affected pools, and prioritizes configured
backrun borrow tokens. The default is:

```env
BACKRUN_BORROW_TOKENS=WETH,DAI,USDC
```

WETH is first because the commissioning audit observed WETH-funded cycles while the
DAI-only scanner observed none.

The engine requires an injected `evaluatePostTrigger` adapter. This is intentional:
a normal finalized-state JSON-RPC quote is not a valid post-trigger quote. Production
must evaluate the route against state *after the trigger transaction* using a
transaction/bundle-capable simulation backend.

### `server/backrun/fundingEngine.js`

Funding is selected per opportunity:

- `CAPITAL`: executor already holds sufficient token balance and net profit survives
  gas/builder costs.
- `FLASH_LOAN`: Aave liquidity is sufficient and net profit survives premium plus
  gas/builder costs.
- `REJECT`: neither funding source meets the minimum-profit gate.

`adaptive` prefers owned capital because thin backruns can be destroyed by a
flash-loan premium. Operators may force `capital` or `flashloan` for controlled
experiments.

Per-token limits are mandatory whenever `BACKRUN_ENABLED=true`. They are token-denominated and deliberately have no unsafe cross-token fallback: `BACKRUN_MIN_PROFIT_WETH` cannot inherit the DAI minimum, and `BACKRUN_MAX_AMOUNT_WETH` must be set independently. Startup fails closed if any configured backrun token lacks either limit.

A configurable reserve prevents using all executor capital:

```env
BACKRUN_FUNDING_MODE=adaptive
BACKRUN_CAPITAL_RESERVE_BPS=1000
```

### Executor v3

`ArbitrageFlashloan.executorVersion` is now `3`.

The existing `initiateFlashLoan(ArbitrageData)` remains unchanged. A second owner-only
entrypoint is added:

```solidity
executeCapitalArbitrage(ArbitrageData)
```

It:

- requires the executor already to hold at least `borrowAmount`;
- executes the same validated swap route;
- requires the final token balance to be at least starting balance + `minProfit`;
- never consumes principal to subsidize a losing route;
- transfers only realized profit to `profitRecipient`;
- remains pause- and owner-gated.

LIVE readiness now requires executor version 3 and a matching deployed bytecode hash.
Existing version-2 deployments therefore fail readiness until explicitly redeployed.

### `server/backrun/executorTransaction.js`

Selects the correct executor entrypoint from the funding decision. This keeps
funding choice out of router/DEX code.

### `server/backrun/bundlePlan.js`

Constructs the ordered execution plan. LIVE order is immutable:

```
[trigger raw transaction, signed backrun transaction]
```

PAPER returns an unsigned plan and records that full bundle simulation is still
required before LIVE.

### Private relay support

`PrivateRelays` now accepts one or more signed raw transactions. Existing
single-transaction execution remains backward compatible.

`validateBackrunBundleSimulation` validates the two-result simulation separately:
the trigger must be first and successful, the backrun must be second and successful,
and only backrun gas is charged to our opportunity economics. Trigger gas belongs to
the trigger sender.

## Post-trigger evaluator contract

A production evaluator receives:

```js
evaluatePostTrigger({ trigger, route, block, signal })
```

and must return:

```js
{
  borrowAmount,
  grossProfit,
  gasCostBorrowToken,
  builderPaymentBorrowToken,
  flashloanTerms
}
```

The evaluator must derive these values from a state that includes the trigger
transaction. Reading the current/past finalized block and pretending it is
post-trigger state is prohibited.

Recommended implementations, in order:

1. private/hinted-order-flow simulation backend that can simulate the trigger and
   candidate backrun atomically;
2. local shadow fork continuously pinned to the current parent block;
3. historical replay harness for regression/backtesting.

## Configuration

```env
BACKRUN_ENABLED=false
BACKRUN_BORROW_TOKENS=WETH,DAI,USDC
# Required hard risk limits for every configured backrun token before enabling:
BACKRUN_MIN_PROFIT_WETH=
BACKRUN_MAX_AMOUNT_WETH=
BACKRUN_MIN_PROFIT_DAI=
BACKRUN_MAX_AMOUNT_DAI=
BACKRUN_MIN_PROFIT_USDC=
BACKRUN_MAX_AMOUNT_USDC=
BACKRUN_FUNDING_MODE=adaptive
BACKRUN_CAPITAL_RESERVE_BPS=1000
BACKRUN_MAX_CANDIDATES=32
BACKRUN_ORDERFLOW_SOURCE=disabled
```

Allowed order-flow source values are `disabled`, `mev_share` and `custom`. The built-in MEV-Share source consumes the official mainnet SSE hint stream; custom sources must provide the same normalized hint shape. Merely changing the setting does not create an order-flow adapter;
deployment must supply and verify the corresponding adapter.

## Commissioning sequence

1. Keep the existing finalized-block scanner running as a control.
2. Replay the known block-26115902 regression case and prove:
   - pre-trigger route is unprofitable;
   - post-trigger route is profitable;
   - post-backrun route is compressed again.
3. Backtest at least seven days of trigger transactions through the same evaluator.
4. Record opportunity frequency by starting token, route, DEX pair and funding mode.
5. Run unsigned PAPER on live order flow.
6. Require successful ordered bundle simulations with zero signatures/submissions in
   PAPER.
7. Deploy executor v3 only after the backrun PAPER evidence is satisfactory.
8. Re-run all readiness checks with the new bytecode hash.
9. LIVE remains a separate explicit operator action.

## Non-goals

This change does not claim that every positive closed swap cycle is profitable MEV.
It does not infer private order flow from finalized blocks, and it does not treat
marginal spot spreads as executable opportunities. Exact post-trigger simulation,
funding cost, measured gas, builder allowance and minimum profit remain mandatory.
