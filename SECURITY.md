# Security Policy

Klustertech Flashloan Arbitrage is experimental software that interacts with smart contracts, blockchain networks, transaction relays and wallet-signing infrastructure. A vulnerability may put funds, keys, infrastructure or users at risk.

## Reporting a vulnerability

**Do not disclose vulnerability details in a public GitHub issue, discussion, pull request or social-media post.**

If GitHub's private vulnerability reporting feature is enabled for this repository, use it to submit a report privately. If it is not enabled, contact the repository owner through a verified private contact channel before sending exploit details. Do not send secrets or exploit material to an unverified address.

Please include, where safe:

- A concise description and affected component or commit.
- Impact and realistic attack conditions.
- Reproduction steps or a proof of concept that does not affect real users or funds.
- Any suggested mitigation.

Please allow maintainers reasonable time to investigate and coordinate a fix before public disclosure. Do not test against live users, production wallets, third-party infrastructure or contracts without explicit authorisation.

## Bug bounty

No active bug bounty programme or reward schedule is represented by this repository. Do not assume a report is eligible for payment.

## Security review and deployment

- Solidity contracts and deployment configuration require independent review before use with real funds.
- Run relevant automated checks, but do not treat passing tests or static analysis as a security audit.
- Use dedicated, least-privilege keys and infrastructure. Never reuse personal wallet keys.
- Keep private keys, API keys, RPC credentials and passwords out of source control and logs.
- Review token approvals, executor roles, admin/timelock configuration, relay settings and public-mempool fallback before any deployment.
- PAPER mode is intended to remain unsigned and non-submitting. Do not weaken its safety controls to bypass a failed preflight.
- Profit-or-revert checks do not protect against key compromise, malicious dependencies, operational mistakes, unexpected token behaviour or every form of economic loss.

Security claims and supported configurations may change. Review the current code and documentation for the exact commit you use.
