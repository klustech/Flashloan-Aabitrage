# Klustertech Flashloan Arbitrage

Experimental EVM flashloan-arbitrage and MEV-Share backrun infrastructure. The repository contains Solidity execution contracts, off-chain route and opportunity analysis, a backrun pipeline, API services, a dashboard, local-chain validation tools and operational documentation.

> **Status: research and engineering project. Live profitability has not been demonstrated.**
>
> This repository is not a promise of returns, an investment product or a turnkey production trading service. Historical replay and PAPER observations are limited evidence about implementation behaviour; they are not evidence of repeatable live profits.

## What is in the repository

- **On-chain execution:** Aave V2 flash-loan and pre-funded execution paths, with profit-or-revert checks in the executor.
- **Opportunity analysis:** multi-DEX route discovery and profitability checks.
- **Backrun pipeline:** trigger intake, state prediction, route sizing, funding selection, ordered fork simulation and decision ledgers.
- **PAPER controls:** unsigned observation and decision recording, with explicit separation from LIVE signing and submission.
- **Operations:** API, dashboard, persistence, monitoring and commissioning runbooks.
- **Validation:** contract, unit, failure-injection, fork and historical-replay tooling.

The implementation is evolving. Consult the architecture and commissioning documents before relying on any individual feature.

## Project status and evidence

The current evidence and its limitations are recorded in [docs/OPEN_SOURCE_VALIDATION.md](docs/OPEN_SOURCE_VALIDATION.md). In summary:

- Selected historical replay studies evaluated candidate triggers and found a small number of positive simulated outcomes under the tested historical conditions.
- The local PAPER execution ledger reviewed for release preparation contained 769,522 records, all recorded as `DROPPED`. These are decision/rejection records, not completed profitable trades.
- The PAPER observation run reviewed was approximately 6.59 seconds across six cycles. It was not a 24-hour or seven-day burn-in.
- The backrun trading path was disabled/not started in the reviewed runtime. Do not describe it as having completed live or continuous PAPER operation.
- No live trading profitability, live execution track record, or investment return is claimed.

These are historical observations from the reviewed local environment, not a claim that every result can be reproduced from a clean clone. Re-run the documented checks on the exact commit you intend to evaluate.

## Architecture

The high-level execution path is:

```text
DEX / order-flow data
        |
        v
discovery and trigger intake
        |
        v
state prediction and route evaluation
        |
        v
sizing, funding and gas/profit checks
        |
        v
ordered local-fork simulation
        |
        +---- PAPER: record decision; do not sign or submit
        |
        +---- LIVE: explicit readiness/arming, signing and relay submission
        |
        v
execution ledger and receipt-based accounting
```

Key areas:

| Area | Location |
|---|---|
| Solidity contracts | `contracts/` |
| Bot and coordinator | `server/bot/` |
| Backrun pipeline | `server/backrun/` |
| Execution and relay integration | `server/execution/` |
| API | `server/scripts/server.js` |
| Dashboard | `frontend/` |
| Scripts and validation | `scripts/` |
| Architecture and operations docs | `docs/` |

Read [docs/README.md](docs/README.md) for the canonical documentation index and [docs/architecture/BACKRUN_ARCHITECTURE.md](docs/architecture/BACKRUN_ARCHITECTURE.md) for the backrun sequence. The executor and order-flow documents linked there describe important implementation details and limitations.

## Installation

### Prerequisites

- Git
- Node.js and npm compatible with the lockfiles and dependencies
- Docker Compose v2 for the documented containerized PAPER stack
- Anvil only for local fork validation
- PostgreSQL and Redis for the full service stack (the documented Compose setup provides these)

Clone the repository and install dependencies:

```bash
git clone https://github.com/klustech/Flashloan-Aabitrage.git
cd Flashloan-Aabitrage
npm ci
```

Install dashboard dependencies if you intend to build or run the dashboard:

```bash
cd frontend
npm ci
cd ..
```

Compile the contracts:

```bash
npm run compile
```

The root package also defines the test and validation commands listed below. Some integration and fork checks require additional local services or RPC configuration; read each runbook before running them.

## Safe configuration: start with local validation

Do not begin by configuring a funded wallet or attempting LIVE execution.

1. Keep private keys, RPC credentials, API keys and passwords out of source control.
2. Copy a relevant example configuration only after reading its associated documentation.
3. For PAPER, keep `PAPER_ONLY=true`, leave `PRIVATE_KEY` unset, and use the dedicated PAPER configuration described in [docs/MAINNET_PAPER.md](docs/MAINNET_PAPER.md).
4. Restrict API and dashboard ports to localhost unless you have deliberately configured and secured a remote deployment.
5. Run the preflight checks before starting any scanner or service.

The root `.env.example` contains legacy and optional integration settings; it is not, by itself, the canonical mainnet PAPER profile. Use [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) and [docs/MAINNET_PAPER.md](docs/MAINNET_PAPER.md) for the current configuration path. Never commit a populated `.env` file.

## PAPER and LIVE are different operating modes

| Mode | Behaviour | What it proves |
|---|---|---|
| Local tests / fork simulation | Runs code against local test or fork state | The tested code paths behave as asserted in that environment |
| PAPER | Observes and records decisions without signing or submitting transactions | The configured observation pipeline and safety controls operate as observed |
| LIVE | Requires explicit readiness checks and arming; can sign and submit transactions | Only a separately authorised live trial can provide live execution evidence |

PAPER is not a profitable trade, and a successful PAPER smoke test can contain zero profitable simulations. PAPER does not prove private-relay inclusion, real execution latency, live gas costs or live profitability.

The documented mainnet PAPER profile rejects a private key and blocks signing/submission. Do not weaken those controls to make a test pass. See [docs/MAINNET_PAPER.md](docs/MAINNET_PAPER.md), [docs/commissioning/PAPER_RUNBOOK.md](docs/commissioning/PAPER_RUNBOOK.md) and [docs/commissioning/LIVE_READINESS.md](docs/commissioning/LIVE_READINESS.md).

LIVE execution can lose funds through key compromise, incorrect configuration, approvals, operational errors, unexpected token behaviour, relay/public-mempool conditions and other risks. Profit-or-revert logic does not eliminate these risks or guarantee successful execution.

## Tests and validation

The principal commands defined in the root `package.json` include:

| Purpose | Command |
|---|---|
| Compile contracts | `npm run compile` |
| Core tests | `npm run test:core` |
| Hardhat tests | `npm test` |
| Local backrun validation | `npm run backrun:validate-local` |
| Executor sweep | `npm run backrun:executor-sweep` |
| Executor batch | `npm run backrun:executor-batch` |
| PAPER preflight | `npm run paper:preflight` |
| PAPER smoke | `npm run paper:smoke` |
| Fresh-clone validation | `npm run backrun:validate:fresh-clone` |

Run commands from the repository root unless the relevant documentation says otherwise. Some commands require Anvil, RPC access, Docker, PostgreSQL, Redis or a configured executor. Read [docs/README.md](docs/README.md) and the linked runbooks for prerequisites and expected evidence.

Do not interpret a command name, test count in old notes, or a successful compile as proof that the whole system is production-ready. Publish new test results with the commit SHA, date, exact command, environment, pass/fail counts and any skipped tests.

## Licensing

The repository's root licence is MIT, subject to the file-specific third-party licensing notice for the Aave-derived interfaces. In particular, `contracts/interfaces/ILendingPool.sol` and `contracts/interfaces/ILendingPoolAddressesProvider.sol` identify AGPL-3.0 in their SPDX headers. See [LICENSE](LICENSE) and the individual source headers.

Do not assume every dependency, generated artifact, dataset or third-party file is relicensed under MIT. Review file headers and dependency licences before redistributing modified or bundled copies.

## Contributing

Contributions are welcome, especially reproducible bug reports, tests, documentation improvements and carefully scoped fixes. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.

## Security

Do not publish vulnerabilities, private keys, API tokens, RPC credentials or production configuration in public issues. Read [SECURITY.md](SECURITY.md) for the current reporting guidance. Do not deploy contracts or enable LIVE execution based solely on this repository's test results.

## Disclaimer

This software is provided "as is", without warranties or guarantees. It is experimental software for research and engineering use. You are responsible for reviewing the code, understanding the applicable laws and protocol terms, securing infrastructure and keys, and assessing all financial and operational risks before use.
