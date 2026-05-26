# SECURITY.md

# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project or its infrastructure, please report it privately to **security@flashloan.arb**. If possible, encrypt your report using our PGP key before sending. Do not disclose details publicly until addressed.

## Bug Bounty Program

We run a bug bounty program. Rewards depend on issue severity. Send a detailed report (reproduction steps, impact) to **security@flashloan.arb**.

## Smart Contract Audits

All Solidity contracts should be reviewed before deployment. We recommend running Slither and Foundry tests (see CI) and obtaining an external audit if using the contracts in production. Audit reports can be uploaded to the `docs` directory for transparency.

## Operational Risk Controls

- **Profit-or-revert on-chain:** `ArbitrageFlashloan` reverts the entire transaction unless the final balance is at least the borrowed amount plus the Aave premium plus `minProfit`. Any net loss reverts atomically, so a trade can never settle at a loss. (The previously documented `maxLossBps` / "max loss cap" was removed; it never actually enforced anything.) `MIN_PROFIT_DAI` sets the off-chain minimum profit the bot requires before it will even attempt a trade.
- **Fail-closed API auth:** Every non-health API route requires a matching `x-api-key` header. The server refuses requests when `API_KEY` is unset, and CORS is restricted to `CORS_ORIGIN`.
- **Private transaction submission by default:** Arbitrage transactions are submitted via Flashbots / private relays by default. The public-mempool fallback is disabled unless `ALLOW_PUBLIC_MEMPOOL_FALLBACK=true` is explicitly set.
- Worker simulations must succeed before on-chain execution; failures cause the cycle to abort.
- A circuit-breaker (now wired into the trade loop) halts trading after repeated failed cycles, requiring manual intervention to resume.
