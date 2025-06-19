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

<<<<<<< ours 3. Set The Graph API variables if querying via the hosted service. Include your API key and the subgraph IDs for each network you plan to query. These IDs can be obtained from [The Graph explorer](https://thegraph.com/explorer/):
======= 3. Set The Graph API variables if querying via The Graph gateway. Provide your API key and the subgraph IDs for each network you plan to query. These IDs can be obtained from [The Graph explorer](https://thegraph.com/explorer/). If an ID is omitted, the scanner defaults to the legacy hosted-service URL:

> > > > > > > theirs

```
THEGRAPH_API_KEY=<your_key>
UNISWAP_ARBITRUM_SUBGRAPH_ID=<id>
SUSHISWAP_ARBITRUM_SUBGRAPH_ID=<id>
UNISWAP_OPTIMISM_SUBGRAPH_ID=<id>
SUSHISWAP_OPTIMISM_SUBGRAPH_ID=<id>
UNISWAP_V3_SUBGRAPH_ID=<id>
BALANCER_V2_SUBGRAPH_ID=<id>
CURVE_V2_SUBGRAPH_ID=<id>
UNISWAP_V3_ARBITRUM_SUBGRAPH_ID=<id>
BALANCER_ARBITRUM_SUBGRAPH_ID=<id>
CURVE_ARBITRUM_SUBGRAPH_ID=<id>
UNISWAP_V3_OPTIMISM_SUBGRAPH_ID=<id>
BALANCER_OPTIMISM_SUBGRAPH_ID=<id>
CURVE_OPTIMISM_SUBGRAPH_ID=<id>
```

If the bot logs `routeFinder returned 0 routes`, double-check these subgraph
IDs and ensure your API key has access. When an ID is invalid, the scanner
falls back to the public subgraphs, but no pools may be returned.

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
