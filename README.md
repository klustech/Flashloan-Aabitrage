# Flashloan Arbitrage Bot

This experimental project implements an arbitrage bot that leverages Aave flash
loans and multiple DEX integrations.

## Setup

1. Install the base dependencies and recover missing modules if needed.

```bash
npm ci
./scripts/install-deps.sh
```

2. Set The Graph API variables if querying via the hosted service. Include your API key and optional subgraph IDs for Arbitrum and Optimism networks:

```
THEGRAPH_API_KEY=<your_key>
UNISWAP_ARBITRUM_SUBGRAPH_ID=<id>
SUSHISWAP_ARBITRUM_SUBGRAPH_ID=<id>
UNISWAP_OPTIMISM_SUBGRAPH_ID=<id>
SUSHISWAP_OPTIMISM_SUBGRAPH_ID=<id>
```

3. Start the services:

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
