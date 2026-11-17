# Flashloan Arbitrage Bot — One-Pager

## 1. Problem Statement

Decentralised exchanges often exhibit fleeting price discrepancies across liquidity pools. Manual arbitrage is slow and capital-inefficient, missing most flash-loan opportunities.

## 2. Solution

An automated Aave V2 flash-loan executor that:

- Instantly borrows ERC-20 tokens
- Performs multi-hop swaps across Uniswap V2/V3, SushiSwap, Balancer & Curve
- Is profit-or-revert on-chain: a trade reverts unless it nets at least the borrowed amount + Aave premium + minimum profit (any loss reverts the whole transaction)
- Submits via Flashbots / private relays by default to avoid front-running

## 3. Key Metrics

- **Latency:** measured per stage (T0–T9) by the latency gate; see [LATENCY_TESTING.md](validation/LATENCY_TESTING.md). No fixed figure is claimed.
- **Profit Threshold:** configurable off-chain minimum (`MIN_PROFIT_DAI`), enforced on-chain as profit-or-revert
- **Downside:** a losing trade reverts, so the route itself cannot lose principal. Remaining risks: hot-key compromise, approvals to approved routers, gas on public fallback submissions, and capital held for capital-funded trades.
- **Tests:** unit + integration + invariant tests (run via `hardhat test`)
- **On-chain Live Demo:** not yet deployed

## 4. Market Opportunity

- **Market size:** large DEX liquidity on Ethereum, but the arbitrage and backrun opportunity is contested by well-capitalised searchers. No market-size figure here is sourced or claimed.
- **Revenue Potential:** Highly variable and competitive; actual returns depend on market conditions, MEV competition and gas costs. No revenue figure is guaranteed. (Any dollar-per-day target should be treated as an illustrative goal, not a projection.)

## 5. Competitive Differentiators

- **Adaptive Slippage:** 24h-volatility-driven tolerance
- **Flashbots Support:** Private bundle submission
- **Dynamic Borrow:** Optimal loan sizing via on-chain reserve data
- **End-to-End Monitoring:** Prometheus + Grafana dashboards

## 6. Roadmap

| Phase          | Deliverables                               | ETA      |
| -------------- | ------------------------------------------ | -------- |
| **Alpha**      | Mainnet-fork bot + basic UI + unit tests   | Complete |
| **Beta**       | Sepolia live runs + back-testing harness   | Q2 2025  |
| **Production** | Mainnet deployment + formal security audit | Q3 2025  |
| **Scale-Up**   | Multi-chain support (Polygon, Optimism)    | Q4 2025  |

## 7. Team & Contacts

- **Lead Dev:** tboy (GitHub: @tboy)
- **Security Contact:** security@example.com
- **Demo & Code:** https://github.com/tboy/flashloan-arbitrage
