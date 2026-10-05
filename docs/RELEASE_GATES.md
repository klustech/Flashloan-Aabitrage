# Release gates

Every gate below blocks. Nothing in the security or test path is wrapped in
`|| true` or `continue-on-error`. The only advisory jobs left are coverage
upload and Solhint style lint, which have no security role.

| Gate | Where | Fails when |
|---|---|---|
| Production core | `production-core.yml` (push, PR, reused by deploy) | Any core Node, Hardhat, frontend test or build fails; PostgreSQL persistence check fails |
| Slither | `security-gates.yml` | Any High-impact finding outside `contracts/mocks` |
| Dependency audit | `security-gates.yml` → `scripts/audit-gate.js` | A high/critical production advisory (root, `server`, `frontend`) is not in `security/audit-exceptions.json`, or its `reviewBy` date has passed |
| Production deploy | `deploy-production.yml` | Run from any ref other than `main`; production core or security gates fail on the deployed commit |

## Reviewed exceptions

- **Slither:** a false positive gets an inline `// slither-disable-next-line <detector>`
  with the reason directly above it. Don't add path or detector exclusions to the command.
- **Dependencies:** `security/audit-exceptions.json` lists accepted advisories, each with
  a `reason` and a `reviewBy` date. When the date passes, CI fails until the entry is
  fixed, re-justified or removed. `node scripts/audit-gate.js --write-baseline` keeps
  existing entries and adds new findings with a 30-day review date; edit the reasons
  before committing. The gate prints entries that no longer apply so you can remove them.

The initial baseline was taken after non-breaking `npm audit fix`, which reduced
production advisories from 79 to 25. The remaining ones need major upgrades or
replacements. Notably, `elliptic` (critical) comes from ethers v5 signing, and
removing it means migrating signing to ethers v6 / `@noble/curves`.

## Protect `main` (repository settings, admin only)

Settings → Branches → add a rule (or ruleset) for `main`:

- Require a pull request with at least one approving review; dismiss stale approvals.
- Require status checks to pass, and require branches to be up to date. Required checks:
  - `deterministic` and `persistence` (Production core)
  - `Slither (fail on High)` and `Dependency audit (reviewed exceptions only)` (Security gates)
  - `Smart Contract Tests` and `Backend Tests` (CI)
- Block force pushes and deletions; include administrators.

Settings → Environments → `production`: add required reviewers and restrict
deployment branches to `main`.
