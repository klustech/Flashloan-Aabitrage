# Flashloan Arbitrage Bot

An experimental Ethereum arbitrage and MEV-Share backrun engine: Aave V2 flash
loans, multi-DEX routing (Uniswap V2/V3, SushiSwap, Balancer, Curve), exact
pool-preserving quotes, private-relay simulation, a PAPER → LIVE state machine
and receipt-based accounting.

## Project status

**This is engineering validation, not proven profitability.**

- **What is validated:** the on-chain executor is profit-or-revert and has
  adversarial, failure-injection and fork tests. The bot starts in PAPER, needs
  explicit arming for LIVE, and records every decision with evidence gates (see
  [docs/README.md](docs/README.md)).
- **What is not claimed:** that it finds or wins profitable opportunities on
  mainnet. MEV is highly competitive. No live track record, revenue figure or
  backtest result in this repository should be read as a profit projection.
- **Real risks remain** even though losing trades revert: a compromised hot key,
  token approvals to approved routers, gas paid on public fallback submissions,
  dependency vulnerabilities, and capital held in the executor for
  capital-funded trades.

Commissioning path: local validation (`npm run backrun:validate-local`) gates
PAPER, and PAPER gates LIVE. See
[docs/PRODUCTION_COMPLETION.md](docs/PRODUCTION_COMPLETION.md) for the supported
Ethereum/Aave V2 profile.

Released under the [MIT licence](LICENSE), except
`contracts/interfaces/ILendingPool.sol` and
`contracts/interfaces/ILendingPoolAddressesProvider.sol`, which are derived from
Aave Protocol V2 and remain under AGPL-3.0 (see their SPDX headers and the notice
in `LICENSE`). Provided as is, without warranty; use at your own risk.

### Running in PAPER (no signing, no submissions)

PAPER mode records decisions without signing or sending transactions. Keep
`PAPER_ONLY=true` and do not set `PRIVATE_KEY`; startup refuses that combination.
Start the API with `npm run api`, select PAPER on the dashboard, then run
`npm run paper:preflight` and `npm run paper:smoke`. The full procedure, including
the Docker Compose stack, is in
[docs/commissioning/PAPER_RUNBOOK.md](docs/commissioning/PAPER_RUNBOOK.md) and
[docs/MAINNET_PAPER.md](docs/MAINNET_PAPER.md).

## Setup

1. Install the dependencies for the root, the backend and the dashboard.

```bash
npm ci
(cd server && npm ci)
(cd frontend && npm ci)
npm run compile   # build output (artifacts/, cache/) is not committed
```

2. Copy `.env.example` to `.env` and fill in the required addresses (router addresses, deployed Arbitrage contracts, etc.). Only Uniswap and SushiSwap routers are needed; the old `ROUTERXYZ` fields have been removed.
   The project now uses central config loaders – `utils/config.js` for shared
   scripts and `server/utils/runtimeConfig.js` for bot/server processes – so any
   process reading environment variables will automatically pull from `.env`.
   See [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) for details.

   To verify that the most important secrets are present without printing
   their values, run the safer diagnostic command:

   ```bash
   npm run env:check
   ```

   Missing variables are listed by name so you can fill them in without
   leaking sensitive data to shared logs.

3. Set The Graph API variables if querying via The Graph gateway. Provide your API key and the subgraph IDs for each network you plan to query. These IDs can be obtained from [The Graph explorer](https://thegraph.com/explorer/). If an ID is omitted, the scanner defaults to the legacy hosted-service URL:

```
THEGRAPH_API_KEY=<your_key>

# Uniswap/SushiSwap V2 subgraphs
# UNISWAP_V2_SUBGRAPH_ID=<id>
# SUSHISWAP_V2_SUBGRAPH_ID=<id>
# UNISWAP_ARBITRUM_SUBGRAPH_ID=<id>
# SUSHISWAP_ARBITRUM_SUBGRAPH_ID=<id>   # optional
# UNISWAP_OPTIMISM_SUBGRAPH_ID=<id>
# SUSHISWAP_OPTIMISM_SUBGRAPH_ID=<id>   # optional

# Uniswap V3 subgraphs
UNISWAP_V3_SUBGRAPH_ID=<id>
UNISWAP_V3_ARBITRUM_SUBGRAPH_ID=<id>
UNISWAP_V3_OPTIMISM_SUBGRAPH_ID=<id>

# Balancer V2 subgraphs
BALANCER_V2_SUBGRAPH_ID=<id>
BALANCER_ARBITRUM_SUBGRAPH_ID=<id>   # optional
BALANCER_OPTIMISM_SUBGRAPH_ID=<id>   # optional

# Curve V2 subgraphs
CURVE_V2_SUBGRAPH_ID=<id>   # optional
CURVE_OPTIMISM_SUBGRAPH_ID=<id>   # optional
```

Optional integrations default to disabled so the bot can still start when
supporting credentials are missing. Enable the pieces you need in `.env`:

```bash
# Optional DEX toggles
INCLUDE_UNISWAP_V2=true
INCLUDE_SUSHISWAP_V2=true
INCLUDE_V3=true
INCLUDE_BALANCER=true   # requires ETH_RPC_URL (falls back to MAINNET_RPC_URL)
INCLUDE_CURVE=true

# Reinforcement learning slippage controller
ENABLE_RL=true
```

If the bot logs `routeFinder returned 0 routes`, double-check these subgraph
IDs and ensure your API key has access. Some legacy endpoints such as
SushiSwap on Arbitrum/Optimism or Curve V2 on Ethereum are disabled unless you
provide a custom subgraph deployment ID. Leaving the variable blank skips that
DEX entirely. The liquidity scanner also retries using `liquidityPools` and
`inputTokens` for subgraphs following the community DeFi standard schema.
Be sure to map V2 and V3 subgraph IDs to the correct environment variables; a
V3 ID for `UNISWAP_ARBITRUM_SUBGRAPH_ID` will cause `pairs` queries to fail.

You can run `node scripts/checkSubgraphs.js` to quickly verify that each
configured subgraph responds to queries.

### PostgreSQL Persistence

The bot requires a PostgreSQL instance to persist executed trades and compute
drawdown guardrails. Populate the `PG_USER`, `PG_HOST`, `PG_DB`, `PG_PASSWORD`,
and `PG_PORT` environment variables in `.env` (see `server/dbClient.js` for the
exact list). On startup the server performs a health check; in production builds
(`NODE_ENV=production`) the process exits immediately if the connection cannot
be established so that orchestration layers can restart the service.

Operational telemetry is exposed via Prometheus: the `db_enabled` gauge reports
`1` when persistence is active and `0` otherwise, and the
`db_insert_failures_total` counter increments each time an insert is skipped or
fails because the database is unavailable. Monitor these metrics to trigger
alerts when persistence is degraded.

4. Start the services:

```bash
npm run bot &
npm run api
```

The bot prints which integrations are active at startup. For example, if
`MAINNET_WEBSOCKET` is omitted it will fall back to HTTP polling, and if
`INCLUDE_BALANCER` or `ENABLE_RL` are unset the log will note that those
features are running in a reduced mode instead of aborting the process.

To replay historical data or evaluate strategy tweaks offline, run the dedicated
backtest entry point:

```bash
npm run backtest
```

## Configuration

The bot's pool selection and profit thresholds are controlled via environment
variables. To include smaller pools and lower the profit target, add the
following settings to your `.env` file:

```bash
# Include all pools regardless of size
# (new) DYNAMIC_ROUTE_MIN_LIQUIDITY_USD=0
# or legacy MIN_LIQUIDITY=0

# Fetch more pools and allow longer routes
DYNAMIC_ROUTE_TOPN=200
DYNAMIC_ROUTE_HOPS=5

# Permit up to 0.5% slippage and detect sub‑$1 opportunities
SLIPPAGE_BIPS=50
MIN_PROFIT_DAI=0.1
# Stop trading if daily losses exceed this amount (in DAI)
DAILY_DRAWDOWN_LIMIT_DAI=100
```

Slippage tolerance adjusts automatically with market volatility. The bot fetches
ETH's 24‑hour price change from CoinGecko each minute and adds `10 × |change|`
bips to `SLIPPAGE_DEFAULT_BIPS` (50 by default). The computed value is cached
for one minute before it is refreshed.

### Offline Pool Data

If subgraph endpoints are blocked, provide pool information from a local JSON
file and set `OFFLINE_POOLS_FILE` in your `.env`:

```bash
OFFLINE_POOLS_FILE=./docs/offline_pools_sample.json
```

The file should contain an object keyed by chain with arrays of pool entries.
See `docs/offline_pools_sample.json` for an example structure.

## Testing

| Suite                                            | Command                                               |
| ------------------------------------------------ | ----------------------------------------------------- |
| Unit suite (node:test; compiles first)           | `npm run test:core`                                   |
| Contract, security and API tests (Hardhat/Mocha) | `npm test`                                            |
| Dashboard tests                                  | `cd frontend && CI=true npm test -- --watchAll=false` |
| Lint                                             | `npx eslint .`                                        |
| Dependency audit gate                            | `node scripts/audit-gate.js`                          |
| Full local validation (needs a local Anvil fork) | `npm run backrun:validate-local`                      |

None of these need mainnet credentials or a funded key. Passing them shows the
code behaves as specified on local chains; it does not show that profitable
opportunities exist or that live execution will succeed.

The contracts compile with solc 0.8.20. Running the Hardhat test suite normally
downloads the compiler binary, so if you are behind a proxy, ensure access to
`binaries.soliditylang.org`.

```bash
npm test
```

In restricted networks where Hardhat cannot fetch the solc binary, compile with
the bundled solc-js fallback instead:

```bash
node scripts/compileWithSolcJs.js
```

Tests now run against an in-memory Hardhat chain by default so they no longer
require mainnet RPC credentials. To opt into mainnet forking, set the explicit
flag and provide RPC URLs:

```bash
ENABLE_MAINNET_FORK=true MAINNET_RPC_URL=<https_provider> npx hardhat test
```

Fork helpers for Arbitrum and Optimism also respect the flag. Supply the
respective `ARB_RPC_URL` or `OP_RPC_URL` variables when you need those forked
chains.

The convenience script wires the flag for you, only requiring the RPC URL:

```bash
npm run test:fork
```

## Architecture Overview

Current components (details in [docs/architecture/](docs/architecture/BACKRUN_ARCHITECTURE.md)):

- **Executor contract** `contracts/ArbitrageFlashloan.sol` (executor v4): Aave V2
  flash-loan or pre-funded routes across approved routers; profit-or-revert;
  admin (timelock) and hot executor roles are separate.
- **Coordinator and trading state machine** `server/bot/`: STOPPED → PAPER →
  LIVE_ARMED → LIVE_RUNNING; LIVE requires explicit arming and readiness checks.
- **Backrun engine** `server/backrun/`: order-flow intake (MEV-Share or custom),
  state prediction on a dedicated fork, exact post-trigger quoting and sizing,
  funding selection, ordered bundle simulation, ledger and evidence.
- **Execution** `server/execution/` (private relays) and
  `server/bot/receiptAccounting.js` (realised PnL from receipts).
- **API and dashboard** `server/scripts/server.js` (API-key protected, binds to
  127.0.0.1 by default) and `frontend/`.
- **Optional** Connext profit forwarding (`contracts/ConnextAdapter.sol`), off
  unless `CONNEXT_AUTO_FORWARD=true`.

The diagram below shows the original scanner layout, which the API still serves
alongside the components above:

```
      +-------------+      HTTP        +-----------------+
      |   Frontend  | <--------------> |      API        |
      +-------------+                  +---------+-------+
                                              |
                                              |
                                              v
                                       +--------------+
                                       |   Bot Logic   |
                                       +------+-------+
                                              |
             +--------------------------------+--------------------------------+
             |                                                                |
             v                                                                v
   +---------------------+                                         +-----------------+
   |  Worker Simulators  |                                         |   ML Scorer     |
   +----------+----------+                                         +--------+--------+
              |                                                        |
              |                                                        v
              |                                             lightgbm_model.txt
              v
     Flash-loan executions on-chain
```

This diagram shows how the React front-end communicates with the Express API. The API dispatches tasks to the core bot, which runs simulations in worker threads and queries the ML scoring microservice before submitting flash‑loan bundles on-chain.

## ML Model Training

The ML service loads a LightGBM model from `ml/lightgbm_model.txt`. The
repository already contains a trained model, so running the training step is
optional. If you wish to retrain using your own dataset in
`ml/ml_training_data.csv`, run the provided Python helper script:

```bash
python ml/train_model.py
```

This script trains a LightGBM classifier using the `lightgbm` Python package and
writes the resulting `lightgbm_model.txt`. The inference microservice
`ml/ml_scorer.py` loads this model at startup. Run it locally with
`npm run ml:serve` and point `ML_MODEL_ENDPOINT` to the service URL.

### Data Collection

Use `npm run update-dataset` to regenerate `ml/ml_training_data.csv` from the
offline pool list. The script reads `OFFLINE_POOLS_FILE` (defaults to
`docs/offline_pools_sample.json`) and writes a CSV for model training.
Additional features such as pool fee tier, whether the pair contains WETH or a
stablecoin, and the originating DEX are now included automatically for richer
model inputs.

To pull a larger and more recent pool set directly from Uniswap's subgraph run:

```bash
npm run collect-data
```

This writes `docs/latest_pools.json` which can be fed into the dataset builder.

```bash
npm run update-dataset
```

## Reinforcement Learning Slippage Agent

The bot now features a lightweight RL module that tunes slippage tolerance
during live trading. The agent treats different slippage offsets as actions and
updates their value estimates based on realized profits. A JSON file persists
the learned Q-values between sessions. You can tweak exploration and learning
rates via the `RL_EPSILON_START`, `RL_EPSILON_MIN`, `RL_EPSILON_DECAY` and
`RL_ALPHA` environment variables. Set `RL_CONTINUOUS=true` to enable a
continuous action space where offsets are sampled from ±`RL_MAX_OFFSET_BIPS`.

## AI Trading Bot

The repository includes `scripts/ai_trading_bot.js`, an example implementation of a
VWAP and mean-reversion strategy using the `ccxt` and `technicalindicators` libraries.
The bot polls Binance once per minute, calculates VWAP bands, a 50-period EMA and
ATR-based stop-loss and take-profit levels, then submits market orders with dynamic
exits.

Configure credentials and optional parameters in your `.env`:

```bash
BINANCE_API_KEY=<your_key>
BINANCE_SECRET=<your_secret>
SYMBOL=BTC/USDT
ORDER_SIZE=0.001
```

Run the bot with:

```bash
npm run ai-bot
```

Always test with paper trading before risking real funds.

### Monitoring

Prometheus metrics are exposed at `/metrics` and in JSON form at `/api/metrics-json`.
Example Grafana dashboards can track `rl_epsilon`, `arb_attempts_total` and trade
profit over time.

## Final Recommendations

The following guidelines summarise key steps to improve long-term reliability
and maintainability of the arbitrage bot:

- **Eliminate Runtime Errors**: prioritise robust error handling across all
  services and scripts to avoid crashes during live operation.
- **Refine Slippage Handling**: continuously test and tune slippage logic so
  trades execute successfully even in volatile markets.
- **Expand Datasets**: collect additional data for model training and maintain
  up-to-date pool information for real-time route discovery.
- **Harden Security**: schedule regular audits, keep monitoring dashboards
  current and enforce strict operational controls.
- **Audit Scripts**: run `npm run slither` and `npm run mythx` to generate
  security reports for the smart contracts.
- **Refactor as Needed**: as the codebase grows, break out components and add
  documentation to keep the project approachable.

These recommendations improve robustness; they do not make profitability any
more likely in a competitive market.
