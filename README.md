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

3. Set The Graph API variables if querying via The Graph gateway. Provide your API key and the subgraph IDs for each network you plan to query. These IDs can be obtained from [The Graph explorer](https://thegraph.com/explorer/). If an ID is omitted, the scanner defaults to the legacy hosted-service URL:

```
THEGRAPH_API_KEY=<your_key>

# Uniswap/SushiSwap V2 subgraphs
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
```

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
