# SECURITY.md

# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project or its infrastructure, please report it privately to **security@flashloan.arb**. If possible, encrypt your report using our PGP key before sending. Do not disclose details publicly until addressed.

## Bug Bounty Program

We run a bug bounty program. Rewards depend on issue severity. Send a detailed report (reproduction steps, impact) to **security@flashloan.arb**.

## Smart Contract Audits

All Solidity contracts should be reviewed before deployment. We recommend running Slither and Foundry tests (see CI) and obtaining an external audit if using the contracts in production. Audit reports can be uploaded to the `docs` directory for transparency.

## Operational Risk Controls

- The bot enforces `maxLossBps` and `MIN_PROFIT_DAI` to cap downside per flash‑loan.
- Worker simulations must succeed before on-chain execution; failures cause the cycle to abort.
- A circuit-breaker halts trading after repeated failed cycles, requiring manual intervention to resume.
