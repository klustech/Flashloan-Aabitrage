# Transaction-triggered backrun implementation

Baseline: main commit `4c9ef5a`. This additive implementation remains disabled
unless `BACKRUN_ENABLED=true`. It is an implementation candidate, not a claim of
mainnet profitability or completed commissioning. The authoritative acceptance
criteria remain in [the blueprint](TRANSACTION_TRIGGERED_BACKRUN_BLUEPRINT.md).

## Implemented path

Public pending transactions, MEV-Share hints or authenticated custom raw
transactions enter a bounded, deduplicated queue. Direct V2/V3 router calldata
resolves exact tracked pool identities. Unknown aggregator calldata can proceed
only with a signed raw transaction; its actual execution logs determine tracked
impact. Hash-only hints are recorded/rejected when exact prediction is impossible.

A dedicated chain-1 Hardhat node forks the pinned parent, applies the authentic
trigger and reads touched pools. Its overlay never replaces the confirmed
registry. CandidateIndex reprices affected two/three-hop routes with WETH priority.
The normal exact DEX adapters and TradeSizer run against that fork state.

Funding policy compares retained executor capital with Aave terms, protects the
configured capital reserve and enforces token-specific size/profit limits.
Selected exact sizes pass executor calls and measured gas estimates. Adaptive
funding tests both available entrypoints with measured costs and prefers viable
capital. Quotes in different tokens are ranked in native units.

PAPER rebuilds the parent and mines the trigger followed by an unsigned,
impersonated operator call in one local block. No signing key is used. A successful
receipt must contain the executor's actual profit withdrawal above the signed
gas-cost budget and minimum profit. Fork coinbase accounting compares identical
prefix/bundle block headers and subtracts the backrun priority fee once. This is
a net balance check; LIVE independently requires relay evidence of zero direct
coinbase transfer. Unsigned local execution is explicitly labelled separately
from a private relay simulation.

LIVE uses the authentic raw trigger first and locally signed arb second. Every
relay simulation must match both hashes/order, successful outcomes, parent state,
gas ceiling and zero direct backrun coinbase transfer. Submission checks parent
identity, trigger nonce/availability, age, trading revision, wallet gas, pause,
loss and pending-submission limits again. No public broadcast fallback exists.

Each bundle targets only the block after its simulated parent. A bundle that
misses that block is never resubmitted to later blocks: the trigger, pool state,
nonce and gas economics it was priced against are stale by then. The next head
refreshes canonical state, and any new opportunity is quoted, signed and
simulated from scratch. The builder payment is always the measured priority fee
from the economics, never a fixed tip.

### Relay identity

Two keys with different roles:

- `PRIVATE_KEY` signs the funded backrun transaction (the execution identity).
- `RELAY_AUTH_PRIVATE_KEY` only signs relay request headers. Relays and builders
  key searcher reputation to its address. It must hold no funds and must never
  equal `PRIVATE_KEY`; the process refuses to start if the two match.
  `FLASHBOTS_AUTH_KEY` is accepted as a legacy alias.

Without `RELAY_AUTH_PRIVATE_KEY` a random identity is generated per process, which
throws away relay reputation on every restart. That is acceptable for PAPER but
readiness fails, so LIVE cannot be armed. Readiness also fails if the auth
address has a nonzero ETH balance. Generate it once, store it like any other
secret, and never fund it:

```bash
node -e "const w=require('ethers').Wallet.createRandom();console.log(w.address);console.log(w.privateKey)"
```

`status().relays` reports the auth address (never the key) and per-relay counts:
simulations, transport/simulation errors, bundles that passed or failed our ordered
validation, accepted submissions, latency (EMA), and settled outcomes
(included/reverted/dropped). Relays do not reveal which builder won, so an
outcome is credited to every relay that accepted the bundle. These counters are
in memory and reset on restart; the ledger rows keep each submission's relay
URLs for durable analysis.

The shared confirmed-block scheduler maintains topology/cache and reconciles
receipts. While backrunning is enabled it performs canonical refresh rather than
competing with the trigger engine for a second full sizing pass. Disabling
backrunning restores the original post-block scan. A shared pending ledger and
coordinator lock prevent simultaneous legacy/backrun signing.

## Laptop / WSL setup

Use Node 22 and a mainnet archive RPC supporting the historical block range. No
mainnet deployment, token funding, SSH command or trade is performed automatically
by this implementation.

Create a private profile from both templates:

```bash
cp server/config/mainnet-paper.env.example .env.backrun-paper
cat server/config/backrun-paper.env.example >> .env.backrun-paper
chmod 600 .env.backrun-paper
```

Edit the HTTP/WS RPC, PostgreSQL, API credential and verified executor identities.
The deployment used for backrunning must expose executorVersion 3. CAPITAL
requires real tokens already held by that executor. No token balances are
fabricated by the predictor or benchmark. Aave must be economically viable for
FLASH_LOAN; having liquidity alone is insufficient.

Then load the file without printing credentials:

```bash
set -a
source .env.backrun-paper
set +a
export PAPER_ENV_FILE=.env.backrun-paper
test -z "${PRIVATE_KEY:-}" || { echo "Remove PRIVATE_KEY from the PAPER profile"; exit 1; }
npm ci --include=dev --ignore-scripts --legacy-peer-deps
npm --prefix server ci --ignore-scripts --legacy-peer-deps
npm run db:migrate:executions
npm run backrun:fork
```

Keep the last command in a separate terminal. It binds only 127.0.0.1:8547 and
starts with no test accounts or deploy scripts. Never expose this disposable
node: its impersonation/reset RPC is intentionally powerful.

In a second terminal, load the same private environment and run:

```bash
npm run backrun:preflight
npm run api
```

Open the existing private dashboard and select PAPER explicitly. Select the
Backrun observer workspace. Start the dashboard normally with its server-side
API credential/proxy; do not place API_KEY in the browser bundle. API and fork
processes must share the host loopback network. The existing API Docker image
does not bundle the development-only Hardhat runtime; the supplied backrun VPS
profile therefore uses host services.

Then:

```bash
npm run backrun:smoke
```

The smoke command sends authenticated GETs only, requires advancing blocks and
order-flow counters, checks database/runtime health and zero signatures/submissions.
It does not require invented profitable trades. Under a quiet or disconnected
source it fails honestly.

## Historical intra-block proof

The supplied transcript is preserved as
`test/fixtures/backrun-audit-evidence.json`, explicitly marked as user-supplied
diagnostic evidence. It is not converted into a successful regression proof.

```bash
npm run backrun:replay -- --local
```

The command reconstructs four independent prefixes of block 26115902:
previous block, transactions 0..142, 0..143, and 0..144. Each prefix is mined in
the original block number/order with its timestamp/base fee/coinbase/prevRandao.
Replayed receipts must match canonical transaction hashes, indices, status,
gas used and exact log payloads before route quotes are accepted.

The fixture includes both 100-fee V3 pools, so this case study can run without
the full topology file. The proof requires: negative previous-block quote;
nonpositive quote after tx142; positive quote after tx143; materially smaller
edge after tx144. Prior/post-trigger quotes must match the supplied observations
within the fixture's explicit tolerance.

If tx84 had already created the edge, the tx143-specific proof fails. That is a
valid finding; do not change the fixture to force a pass.

Hardhat/archive support for blob/authorization envelopes, historical hardforks
and system-state changes can vary. Authentic signed envelopes are reconstructed
only from existing signature fields and their hashes are verified. Unsupported
transactions, missing receipts or semantic mismatches stop proof issuance.

## Seven-to-thirty-day benchmark

Provide the actual canonical topology in `POOL_CACHE_PATH`, then explicit block
bounds covering at least seven days:

```bash
export BACKRUN_START_BLOCK=YOUR_START_BLOCK
export BACKRUN_END_BLOCK=YOUR_END_BLOCK
npm run backrun:benchmark
```

This is a costly exact archive/fork experiment, not the earlier fast log audit.
Each tracked trigger reconstructs its full preceding block prefix. Available
capital/flash paths are evaluated through the executor; viable paths are appended
unsigned to that same historical prefix and mined in the same block.
Canonical prefix receipts and principal preservation are rechecked.

The report separates gross, measured capital net and flash net by token, route
length and DEX combination. It records coverage/errors, decision latency,
funding availability, net/capital percentiles, gas and builder budgets. At most
one opportunity per trigger contributes to capture estimates; competition and
concurrent capital availability remain explicit upper-bound assumptions.

Existing executor-v3 code/capital must actually exist at the historical parent
being replayed. A missing executor or unsupported prefix is incomplete coverage,
not evidence that the market had no opportunities. Choose a suitable post-deployment
window for prospective commissioning, or implement/review an explicitly labelled
deployment-scenario simulator separately.

The first proven profitable execution for each funding mode writes its matching
capital/flash mainnet-fork evidence file. Controlled local mock tests do not issue
these files. Production benchmark reports persist in a separate PostgreSQL table.

Run CLI experiments while the observer is stopped. A filesystem lock also
serializes fork contexts across API/CLI processes, preventing one experiment from
resetting another's state. Preserve runtime and database volumes.

## VPS PAPER commissioning

Templates are in `ops/systemd/backrun-fork.service` and
`ops/systemd/backrun-paper.service`. Adjust the service user, Node executable
and /opt path to the actual VPS. Install dependencies and apply migrations first.
The service user needs runtime/cache ownership; the private profile lives at
`/etc/arbitrage/backrun-paper.env`. Keep both API and fork on host loopback.
Use the existing dashboard proxy or an authenticated SSH tunnel for operator
access. Source/fork/database failure leaves LIVE disarmed.

The observer does not auto-activate PAPER or LIVE. PAPER must be selected after
service startup. At least seven continuous days are required. Source loss,
head stagnation, a process gap above 30 seconds, database failure, signing,
submission or risk-configuration change invalidates the unfinished run.

Build the commissioning report only after replay, benchmark, both funding-path
proofs and PAPER evidence exist:

```bash
npm run backrun:commission
```

It additionally requires an explicit `runtime/backrun/risk-review.json` containing:
`profileFingerprint`, `reviewed: true`, a positive
`minimumOpportunitiesPerDay`, positive `minimumNetNativePerDay` in wei,
`capitalPlan`, `drawdownPlan`, and `competitionAssumptions`. The net threshold
must include the operator's infrastructure allowance.

The report rejects incomplete coverage, a single historical anomaly, missing
same-block simulation, excessive measured p95 latency, insufficient frequency/net
and absent risk review. Completed PAPER evidence is valid for seven days; switching
to LIVE does not retroactively erase that completed run. The evidence configuration
hash omits only PAPER_ONLY, so moving from commissioning to LIVE does not invalidate
otherwise identical risk settings. Trading still requires explicit ARM and GO LIVE.

No report or green unit suite elects LIVE for the operator.

## API / persistence

Authenticated read endpoints:

- GET /api/backrun/status
- GET /api/backrun/recent-triggers
- GET /api/backrun/candidates
- GET /api/backrun/simulations
- GET /api/backrun/benchmark

POST /api/backrun/triggers accepts only hash + authentic signed raw transaction
on an explicitly configured custom source. It reuses fail-closed API authentication
and the separate mutation rate budget. It cannot bypass PAPER or execution gates.

Migration 0002 adds backrun_records and backrun_benchmarks. Records preserve exact
integer token values in JSONB and a fsynced journal. Raw trigger transactions are
excluded. API reads use bounded recent records; PostgreSQL retains historical data.
Existing deployments must run the migration; Compose init files cover only fresh
databases.

## Validation and remaining evidence

Tests exercise decoders, pool identity, signed envelopes, context isolation,
funding costs/reserves, lifecycle persistence, queue/state expiry, unsigned PAPER,
ordered relay validation, historical receipt fidelity and evidence invalidation.
A dedicated controlled local-chain test mines actual CAPITAL and FLASH_LOAN
executor calls through the fork backend. CI also verifies PostgreSQL precision,
contracts, frontend tests/build and Docker configuration/images.

These controlled checks do not provide mainnet tx143 causality, seven-day
historical/PAPER results, a VPS deployment, or private-relay commissioning.
Those are explicit outstanding acceptance items until real evidence is collected.

Protocol references:
[Hardhat fork/mining RPC](https://v2.hardhat.org/hardhat-network/docs/reference),
[Flashbots bundle RPC](https://docs.flashbots.net/flashbots-auction/advanced/rpc-endpoint),
[MEV-Share event stream](https://docs.flashbots.net/flashbots-mev-share/searchers/event-stream).

## Replay diagnostics and local node lifecycle

Use `npm run backrun:replay -- --local` for a single-terminal replay. It starts a
chain-1 Hardhat node on loopback port 8547 if needed, waits for readiness, and
stops only the process group it created when replay ends. An already-running
verified chain-1 Hardhat node is reused and left running. Without `--local`,
keep `npm run backrun:fork` alive in another terminal while replay executes.

Hardhat is a development dependency. Install with `npm ci --include=dev
--ignore-scripts --legacy-peer-deps`, even when the PAPER environment has
`NODE_ENV=production`. This command does not enable signing or LIVE execution.

Replay prints bounded progress for configuration, archive chain ID, canonical
headers, signed envelopes, fork resets, prefix mining, receipt verification and
quotes. On failure, `BACKRUN_REPLAY_FAILED` reports the stage, relevant block or
transaction index, error code and sanitized diagnostic. Authenticated URLs,
configured secrets, long hex payloads and raw provider request/response bodies
are excluded. No new proof is issued when replay throws. Keep the local fork
log private: it may contain raw provider errors even though CLI diagnostics are
sanitized. Share the CLI diagnostic JSON instead.

Historical blocks may contain signed legacy transactions with `v=27/28` and
no embedded chain ID. EIP-155 retains the validity of that signature scheme.
Canonical replay accepts these original envelopes only when their hashes and
recovered senders match the canonical transaction records. It carries those
records through prefix mining and historical unsigned-executor simulations.
The raw bytes and parsed chain ID are preserved; signatures are not recreated.
Pending order-flow and LIVE trigger validation still require chain-ID protection.
Other-chain protected signatures, typed chain-zero transactions, unsigned
envelopes, mismatched hashes and mismatched senders remain rejected.
See [EIP-155](https://eips.ethereum.org/EIPS/eip-155).

Historical CLI archive reads are paced at a minimum 150 ms between request
starts and use at most three attempts for transient HTTP 408/429/500/502/503/504,
timeouts, temporary connection failures or RPC rate-limit errors. Exponential
backoff and `BACKRUN_ARCHIVE_RETRY` progress remain bounded. Set
`BACKRUN_ARCHIVE_MIN_INTERVAL_MS` (0..5000) and
`BACKRUN_ARCHIVE_MAX_ATTEMPTS` (1..5) in the private PAPER environment to adjust
these defaults. Authentication/permission failures, HTTP 402 quota exhaustion,
execution reverts, missing evidence and canonical mismatches fail immediately.
The final diagnostic includes HTTP status, RPC method and attempts when known.
Transaction submissions and local fork mutations are never automatically
repeated by this archive-read policy. Production order-flow scanning is unchanged.
