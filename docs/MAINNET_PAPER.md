# Laptop mainnet PAPER commissioning

This profile observes real Ethereum and performs unsigned executor calls. It never arms, signs or submits a trade. A version-4 executor must already exist on Ethereum mainnet with its operator (executor role), admin timelock, recipient and runtime code hash recorded (see [EXECUTOR_GOVERNANCE.md](security/EXECUTOR_GOVERNANCE.md)). Deploy it with a separate deployment environment; do not put its private key in the PAPER environment. Deployment spends gas and is an operator action outside this commissioning setup.

## What the hardening implements

Authenticated reads have a separate 600-request / five-minute budget. Settings, trading and other mutations each have independent 30-request budgets. Authentication runs first; bad credentials cannot consume the authorized budgets. Health/Prometheus probes and authenticated emergency pause/stop are exempt, so throttling cannot prevent disarming. No proxy trust or forwarded-IP bypass is enabled.

Stored settings accept `_savedAt` only as file metadata. Runtime settings remain strict; unknown settings and corrupt files produce an explicit warning and safe fallback. Environment overrides take precedence, and persisted `botActive` never restarts the scanner. Explicit `BOT_AUTO_START=true` retains its existing PAPER behavior; the canonical profile sets it false. Atomic replacement uses private file permissions. Explicitly saved production overrides are restored on restart and remain capped by the configured production ceilings. The dashboard strips only documented response metadata before validating settings. Container-injected environment values now take precedence over dotenv files.

`PAPER_ONLY=true` rejects a private key at API startup and profile construction. It rejects arm/live endpoints with 409, blocks direct LIVE state transitions, and independently refuses execution-engine signing even if a caller spoofs the state. The dashboard shows MAINNET PAPER-ONLY and disables LIVE controls. Runtime signature/submission counters are process-lifetime diagnostic evidence; the smoke check also checks all historical LIVE rows in PostgreSQL. Existing LIVE readiness gates are unchanged. The new profile field changes the commissioning fingerprint: finish configuration before beginning the official continuity run.

## Prepare configuration

Keep the current fork setup separate. From the repository root:

```sh
cp server/config/mainnet-paper.env.example .env.mainnet-paper
chmod 600 .env.mainnet-paper
```

Fill HTTP and WebSocket mainnet RPC endpoints, the deployed executor fields, a database password and a strong API key. Keep `PRIVATE_KEY` empty, `PAPER_ONLY=true`, `BOT_AUTO_START=false` and `ALLOW_PUBLIC_MEMPOOL_FALLBACK=false`. Never paste RPC credentials, API keys or private keys into logs or support messages. The template is the canonical source of variable names; PostgreSQL uses the five `PG_*` variables, not `DATABASE_URL`.

The HTTP provider and deployed code—not `CHAIN_ID=1` alone—must actually match Ethereum mainnet. Preflight verifies this. Router/Aave addresses inherit the deterministic production defaults and are checked against your RPC. No optional ML, Connext, additional chains or mempool strategy is required.

## Start the dedicated laptop stack

Use a distinct Compose project so fork/older LIVE data never enters this commissioning ledger. Existing volumes are preserved. Commands assume Docker Compose v2 and existing Node dependencies (`npm ci --ignore-scripts --legacy-peer-deps` if needed).

```sh
export BOT_ENV_FILE=.env.mainnet-paper
export PAPER_ENV_FILE=.env.mainnet-paper

docker compose --env-file .env.mainnet-paper -p mainnet-paper \
  -f docker-compose.production.yml -f docker-compose.mainnet-paper.yml \
  up -d postgres redis
```

Postgres is exposed only on `127.0.0.1:5433`; the host environment uses that address. API container settings use `postgres:5432` internally. API/dashboard ports remain published only on `127.0.0.1:3001` and `127.0.0.1:3002`. The internal container bind is `0.0.0.0`, which is necessary for Docker networking; do not publish these ports on all host interfaces. The Compose override locks PAPER mode and public fallback, but does not mask an accidental private key: startup fails until it is removed.

A fresh Postgres volume initializes the execution migration automatically. For an existing dedicated volume missing the table, apply `npm run db:migrate:executions` using the same configured `PG_*` environment. Do not drop or erase existing volumes to resolve a migration problem.

```sh
npm run paper:preflight
```

Preflight loads `.env.mainnet-paper` (or `PAPER_ENV_FILE`) without overriding already-exported variables. It checks production mode, unsigned PAPER policy, authentication, host bindings, chain/head/base fee, a received mainnet WebSocket block, executor version/code hash/executor role/admin/recipient/approved routers/pause, Aave/router relationships and bytecode, execution schema, absence of historical LIVE rows, and writable evidence locations. It does not start the scanner, sign or submit transactions, create commissioning evidence, or require signer gas. The latter exemption applies only to PAPER preflight; LIVE readiness still checks signer funds. A FAIL row is blocking; no secrets are printed in failure details.

Host preflight checks host-side file locations. The subsequent running API health probe independently verifies the mounted container runtime and database.

Once preflight is green:

```sh
docker compose --env-file .env.mainnet-paper -p mainnet-paper \
  -f docker-compose.production.yml -f docker-compose.mainnet-paper.yml \
  up -d --build api dashboard
```

Open `http://localhost:3002`, confirm MAINNET PAPER-ONLY, and select PAPER. Startup deliberately stays STOPPED until this explicit action.

```sh
npm run paper:smoke
```

Smoke makes authenticated GET requests to the running API. It allows initial discovery to finish, then observes advancing HTTP blocks, scanner notifications, scan counts and cached state over subsequent blocks. Each observation requires unsigned locked PAPER, zero signature/submission counters, no pending/LIVE ledger records, production PostgreSQL and a writable runtime. It fails on pool log errors and stalled progress. HTTP fallback is reported as the scheduler source rather than concealed. A successful smoke can contain zero profitable simulations. Each phase waits up to three minutes by default; `PAPER_SMOKE_TIMEOUT_MS` can set a bounded timeout of up to ten minutes per phase. The command does not activate PAPER or change settings.

## Preserve evidence

The `mainnet-paper_executions-production` volume persists the journal, topology, burn-in and operator settings under `/usr/src/app/runtime/mainnet-paper`. Use ordinary `docker compose down` to stop without deleting volumes; do not use `down -v`. Freeze environment and operator settings during the official run. Profile changes and heartbeat gaps exceeding the existing three-minute limit reset burn-in continuity. Laptop sleep, RPC outages and restarts lasting longer than that gap interrupt the seven-day proof. A seven-day proof also needs a complete profitable simulation. A short smoke proves observation and safeguards, not profitability or relay commissioning.

After a stable several-hour laptop run, move the same finalized profile to the VPS for continuous commissioning. Preserve accurate profile fingerprints and deployment evidence. PAPER remains unsigned and cannot prove signed Flashbots simulation; fork proof, relay commissioning and any controlled LIVE trade remain separate acceptance tasks.

## Validation boundaries

Automated regressions exercise settings restart/metadata/corruption, environment precedence, API read/mutation budgets and auth, PAPER-only arming/signing/UI, preflight failures, and a smoke run against an actual local HTTP test server with advancing test data and no POST requests. CI also exercises contracts, frontend builds, Docker and PostgreSQL persistence. These tests do not claim real mainnet RPC, deployed executor or live-network smoke evidence. Run the two commands on your configured laptop to generate that operational result.
