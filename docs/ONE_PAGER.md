# Flashloan Arbitrage Bot — One-Pager

## 1. Problem Statement

Decentralised exchanges often exhibit fleeting price discrepancies across liquidity pools. Manual arbitrage is slow and capital-inefficient, missing most flash-loan opportunities.

## 2. Solution

An automated Aave V2 flash-loan executor that:

- Instantly borrows ERC-20 tokens
- Performs 2- & 3-hop triangular swaps across Uniswap V2 & SushiSwap
- Enforces loss-cap (maxLossBps) and min-profit guardrails
- Submits via Flashbots to avoid front-running

## 3. Key Metrics

- **Latency:** <500ms Tx dispatch from opportunity detection
- **Profit Threshold:** ≥ 0.5 DAI per trade
- **Max Drawdown:** ≤ 0.1% per flash-loan
- **Test Coverage:** 100% unit + fuzz + invariant tests
- **On-chain Live Demo:** Sepolia deployment at `0x…`

## 4. Market Opportunity

- **Total Value Locked (TVL)** across Uniswap V2 & SushiSwap v2: > $2 Bn
- **Daily Volume Disparity:** > $10 M in liquid pools
- **Revenue Potential:** At 0.05% capture rate, ≈ $5k/day

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
