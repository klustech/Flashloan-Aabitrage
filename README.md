# Flashloan Arbitrage Bot

This experimental project implements an arbitrage bot that leverages Aave flash
loans and multiple DEX integrations.

## Setup

1. Install the base dependencies and recover missing modules if needed.

```bash
npm ci
./scripts/install-deps.sh
```

2. Copy `.env.example` to `.env` and fill in the required addresses (router addresses, deployed Arbitrage contracts, etc.). Only Uniswap and SushiSwap routers are needed; the old `ROUTERXYZ` fields have been removed.
   The project now uses a central config loader (`utils/config.js`) so any process
   reading environment variables will automatically pull from `.env`.
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

By default the bot queries Uniswap V3, Balancer V2 and Curve V2 pools. You can
disable any of these integrations by setting the corresponding `INCLUDE_*`
variable to `false`:

```bash
# Optional DEX toggles (defaults to true)
INCLUDE_UNISWAP_V2=true
INCLUDE_SUSHISWAP_V2=true
INCLUDE_V3=true
INCLUDE_BALANCER=true
INCLUDE_CURVE=true
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

4. Start the services:

```bash
npm run bot &
npm run api
```

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

Running the Hardhat test suite downloads compiler binaries. If you are behind a
proxy, ensure access to `binaries.soliditylang.org`.

```bash
npm test
```

## Architecture Overview

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

Implementing these recommendations holistically can increase the chances of the
bot finding profitable opportunities in a competitive market.
