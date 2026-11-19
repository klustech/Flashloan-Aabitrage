# Contributing

Thank you for considering a contribution to Klustertech Flashloan Arbitrage.

The project is experimental financial software. Contributions should prioritise correctness, security, reproducibility and clear documentation over trading-performance claims.

## Before you start

- Read the [README](README.md), [architecture documentation](docs/README.md) and relevant runbooks.
- Check existing issues and discussions before starting substantial work.
- For a security vulnerability, do not open a public issue; follow [SECURITY.md](SECURITY.md).
- Do not commit private keys, seed phrases, API tokens, RPC credentials, passwords, populated environment files, private relay credentials or production data.
- Do not include user data, proprietary datasets or third-party code unless you have the right to contribute them.

## Scope and compatibility

- Keep pull requests focused and explain the problem they solve.
- Preserve existing safety gates and fail-closed behaviour.
- Do not silently change PAPER/LIVE semantics, contract permissions, execution conditions, funding paths or relay behaviour.
- Changes to Solidity execution, signing, transaction submission, approvals or key handling require tests and a clear security rationale.
- Avoid unrelated formatting or refactoring in functional changes.

## Tests

Run the checks relevant to your change and include the exact commands and results in your pull request. Depending on the change, this may include:

```bash
npm ci
npm run compile
npm run test:core
npm test
```

Fork, Docker, database and dashboard checks may require additional services or credentials. State clearly which checks were not run and why. Never describe a skipped test as passing.

For execution, replay and PAPER changes, include reproducible local evidence and explain the assumptions. Simulated results must not be presented as realised trading profit.

## Pull request checklist

- [ ] The change has a clear purpose and bounded scope.
- [ ] Relevant tests were added or updated.
- [ ] Relevant tests were run and exact results are reported.
- [ ] Documentation and configuration examples were updated where needed.
- [ ] No secrets, private runtime data or generated build artefacts were added.
- [ ] Safety controls and PAPER/LIVE boundaries are preserved or explicitly justified.
- [ ] Third-party code and licence obligations have been checked.

## Licensing and contribution terms

By submitting a contribution, you represent that you have the right to submit it under the licence applicable to the files you change. The repository is primarily MIT-licensed, with file-specific third-party licensing notices including Aave-derived AGPL-3.0 interfaces. Your contribution does not change the licence of existing third-party files.

Unless a separate written agreement says otherwise, you retain any rights you have in your contribution and grant the permissions necessary under the applicable project licence when you submit it. If a contribution requires a different licence or additional terms, discuss that with the maintainers before submitting it.

## Review

Maintainers may request changes, additional tests or clarification, and may decline contributions that introduce unverified claims, weaken security controls or create unclear licensing obligations.
