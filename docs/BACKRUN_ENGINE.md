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

Fork errors also report the specific `rpcMethod`, parameter type names and,
for raw-prefix submission failures, the canonical transaction index/type.
Parameter values, signed bytes and authenticated URLs are not emitted. The
CLI prints the verified fork client version before replay. A `mine_prefix`
failure is a broad stage; use `rpcMethod` to distinguish header configuration,
transaction submission, mining and receipt retrieval. Full header tests include
timestamp, base fee, gas limit, coinbase and PREVRANDAO.

Historical `evm_mine` uses a separate ten-minute HTTP deadline. Executing a
canonical prefix can require many lazy archive state reads inside the fork node;
the ordinary 30-second RPC deadline is insufficient for some prefixes. Set
`BACKRUN_REPLAY_MINING_TIMEOUT_MS` (1000..1800000) in the private PAPER environment
to change this bounded deadline. Ordinary RPC calls and production simulation
deadlines are unchanged. `BACKRUN_REPLAY_MINING` reports start, a heartbeat every
15 seconds and completion, with elapsed time and the configured deadline. A
heartbeat means the client is waiting; it does not prove execution is advancing.

Mining is sent exactly once, with transport retries disabled. A timeout or lost
response does not cancel execution inside the node. The failure diagnostic
includes `timeoutMs`, `elapsedMs` and `miningOutcomeUnknown`; when the outcome is
unknown, the backend refuses further mutations and skips impersonation cleanup
that could interfere with in-flight mining. `--local` stops a node it started
when replay exits. If an existing node was reused, stop and restart that
dedicated node before another replay. No proof is issued on a mining failure;
raising the deadline alone does not establish successful canonical execution.

### Canonical prefixes containing type-3 blob transactions

Hardhat 2.24.3 rejects a bare signed blob body with `unexpected string`. Supplying
the correct pooled sidecar envelope does not solve ordered replay: that version
also rejects blob transactions while automining is disabled or the pool is not
empty. Enabling automining or omitting the blob transaction would change the
historical execution and must not be used to issue this proof.

Use the dedicated Anvil backend for the canonical case study:

```bash
npm run backrun:install-anvil
PAPER_ENV_FILE=.env.backrun-paper npm run backrun:replay -- --local --anvil
```

The installer downloads the official Foundry v1.8.4 release, checks its pinned
SHA-256 digest, extracts only Anvil and installs it below ignored
`runtime/backrun/tools`. It requires `curl` and `tar` on Linux/WSL or macOS.
No global Foundry installation or npm dependency changes are needed. This
version supports `anvil_setNextBlockPrevRandao`; older Anvil releases are not
equivalent substitutes. `BACKRUN_ANVIL_BIN` may point to a compatible executable.

`--anvil` explicitly selects a separate chain-1 node at `127.0.0.1:8548`, with
no generated accounts, FIFO ordering, manual mining and no automatic create2
deployer. It infers the historical hardfork from the source chain and timestamp.
The existing Hardhat node on 8547 is not used or stopped. `--local` owns and
cleans up only a node it starts; an existing matching Anvil node is left running.
Its private diagnostic log is `runtime/backrun/anvil-fork.log`.
The CLI transport selection does not alter the deployment/economics profile
fingerprint used by PAPER/LIVE commissioning; the proof names its replay backend
separately.

For an already canonical blob transaction, the recovered sender and original
signed body must match the canonical hash and sender before scoped local
impersonation admits the body without a sidecar. The account exception remains
only through prefix mining and is cleared after a definite success or failure.
If the mining response is lost, restart the node as described above. The raw signed
body is sent unchanged: its signature, type, blob hashes, fee fields, hash,
execution order and receipt remain verifiable. All prefix receipt/status/gas/log
checks remain mandatory. Pending/LIVE transactions do not receive this exception.

This is execution-only replay of a canonical block, not a fresh blob data
availability or KZG proof. The report records `executionOnly: true`,
`blobDataAvailabilityVerified: false` and the replay backend. The controlled
Anvil test verifies BLOBHASH, actual blob gas fees, the original hash, canonical
receipt equality and an unsigned executor appended in the same block.

References: [EIP-4844 body and pooled representations](https://eips.ethereum.org/EIPS/eip-4844),
[official Foundry v1.8.4 release](https://github.com/foundry-rs/foundry/releases/tag/v1.8.4).

### Test the current executor without deploying it to mainnet

After the canonical replay passes, run this from the backrun checkout using the
same private archive environment. No running terminal/node is required:

```bash
PAPER_ENV_FILE=.env.backrun-paper npm run backrun:executor-fork
```

This command compiles the current `ArbitrageFlashloan`, starts the dedicated
Anvil node if needed, and deploys the executor **only locally** against the real
historical Aave V2 provider. It tests the fixed fixture's WETH amount and exact
Uniswap V3/Pancake V3 route in both CAPITAL and FLASH_LOAN modes. No deployed
mainnet executor, database, execution key or real funds are required. It refuses
`PRIVATE_KEY`, uses unsigned impersonated local calls and never submits a relay
bundle or broadcasts to mainnet. It stops only a node it starts.

The test deliberately supplies synthetic native gas funds and hypothetical
capital. A real WETH deposit backs the hypothetical capital on the local fork.
FLASH_LOAN starts with zero executor WETH; CAPITAL starts with the fixture amount.
The deployed constructor state and that one new WETH balance slot are retained
across resets; historical pool/router/Aave setup state is not fabricated. The
canonical prefix through transaction 143 is rebuilt, all original receipt
status/gas/logs are verified, and our executor replaces the historical arb at
index 144 in the same block with its original header. Prefix receipt checks are
repeated after appending the executor. Aave's actual flash-loan event, recipient
balance increase, preserved executor principal, cleared allowances and operator
native gas delta must agree with the execution receipt.

`runtime/backrun/local-executor-diagnostic.json` reports:

- `technicalPassed`: both funding methods executed and passed accounting checks.
- `economicallyPositiveModes`: which had positive WETH profit after measured gas.
- Per method: actual gross, actual flash fee, withdrawn profit, gas used, effective
  gas price, net after gas and whether the configured minimum net was met.

The gas price uses the historical arbitrage's priority fee. It includes that
priority payment exactly once; no additional direct builder payment is modelled.
This is not a competitive live bid. Deployment and infrastructure costs are
reported as excluded. The contract profit floor is one wei so an executable
but uneconomic trade can still be measured; the configured net floor is reported
separately and production settings are unchanged. A technically successful test
can honestly report no economically positive methods.

This isolated diagnostic is **not commissioning evidence**: it explicitly labels
synthetic capital/gas, local deployment, unsigned execution and untested builder
inclusion. It cannot satisfy the production funding/deployment/readiness gates
and never writes the production capital/flash-loan proof paths or overwrites the
canonical replay proof. Do not treat it as proof of realized profit or live
capture. If it fails, share its sanitized CLI diagnostic rather than private
node logs or environment contents.

### Sweep local executor sizes and priority fees

```bash
PAPER_ENV_FILE=.env.backrun-paper npm run backrun:executor-sweep
```

No other terminal/node is required. The command compiles and deploys only on the
local Anvil fork, using the same archive environment and diagnostic safeguards
as `backrun:executor-fork`. It does not deploy to mainnet or sign a trade.

Default sizes are 0.01, 0.03, 0.06, 0.1, 0.2, 0.5 and 1 WETH plus the original
fixture size (0.06080858030334331 WETH). Defaults above `BACKRUN_MAX_AMOUNT_WETH`
are excluded. Each size tests CAPITAL and FLASH_LOAN at 0%, 25%, 50% and 100% of
the original arbitrage's priority fee. The canonical base fee stays unchanged.
Every executed combination starts with a reset to the same parent, identical
canonical prefix and header, verified original receipt/status/gas/logs, clean
executor constructor state and a fresh synthetic gas budget. CAPITAL starts with
exactly the selected amount; FLASH_LOAN starts with zero executor WETH. Profits,
Aave premiums, actual gas and priority payments are verified from execution.
The selected priority is included exactly once in effective gas cost.

Each size gets an exact post-trigger quote, including actual pool price impact.
A nonpositive quote after funding fees or insufficient Aave liquidity is recorded
as `QUOTE_REJECTED`; it is not an executed trade or a technical failure. Successful
executions can have negative net after gas. RPC, canonical receipt and executor
failures are separately recorded as `ERROR`, and prevent a clean-completion claim.
An unknown mining outcome stops the sweep without further node mutations.

The CLI prints a WETH/ETH table and compact final summary. The full report and
incremental checkpoints are saved to `runtime/backrun/local-executor-sweep.json`.
A partial report is marked incomplete. Best results at the original historical
priority fee are reported separately from best results at hypothetical lower
bids. Zero/lower bids do not establish builder inclusion or competitive capture.
All combinations describe alternatives for ONE historical trigger; never add
these profits together or extrapolate them as daily income. Deployment,
infrastructure and additional direct builder payments remain excluded. This
report is diagnostic only and cannot satisfy production commissioning gates.

Optional private environment settings:

```dotenv
BACKRUN_SWEEP_AMOUNTS_WETH=0.01,0.03,0.06,0.1,0.2,0.5,1
BACKRUN_SWEEP_PRIORITY_BPS=0,2500,5000,10000
```

Custom sizes must be positive, at most 12 values, and stay inside the configured
WETH cap. Fee multipliers are integers from 0 to 20000, at most four distinct
values, and must include 10000 so the historical fee comparator is retained.
These settings affect only the local diagnostic and do not increase LIVE limits.
A complete sweep with no positive net combinations is a valid result.

### Scan and size independent historical triggers locally

```bash
PAPER_ENV_FILE=.env.backrun-paper npm run backrun:executor-batch
```

This command starts/reuses the dedicated Anvil node automatically. No mainnet
executor deployment or execution key is needed. By default it scans **20 blocks,
26115893–26115912**, for every successful Swap transaction touching the two
canonical fixture pools. It does not select only transactions already known to
be profitable. It tests both WETH two-leg route directions, including same-DEX
parallel pools if supplied in the explicit pool file. This is coverage of the
tracked pools, not an Ethereum-wide search. The default window and pools are
anchored around a known example, so this initial sample is not representative
market evidence.

For each discovered trigger, the command replays its canonical signed prefix
and verifies transaction order, receipt status, gas and logs. It deploys the real
executor constructor locally and preserves only its isolated synthetic funding
and local identity across resets. Pool, router and Aave setup remains historical.
The existing reserve-math seed, exact-quote sweep and refinement size each route
separately for CAPITAL and FLASH_LOAN within `BACKRUN_MAX_AMOUNT_WETH` and actual
historical Aave liquidity. The top **three exact sizes per route per mode** are
executed unsigned in the same historical block, immediately after the trigger.
Their measured events, recipient balance increase, preserved principal, actual
Aave premium and actual receipt gas determine net ETH. Pre-trigger quotes also
show whether the gross-positive edge was created by that trigger or already
existed beforehand.

Sizing initially optimizes exact profit after funding before gas; actual gas
then ranks measured finalists. It does not prove a global optimum after gas.
Negative and positive nets are both retained. No viable tested quote is a valid
result; failed quotes, failed replay or failed executor accounting are reported
as errors. An uncertain mining response aborts all further mutations. Trigger
limits, route bounds, missing canonical blocks and technical errors cannot issue
a complete report. Zero discovered triggers is reported explicitly and supplies
no profitability evidence.

The fee reference is the **actual historical block base fee plus the median
priority fee of successful transactions in that block**. Priority is included
once in the measured gas cost. This uses hindsight and is not a known winning
builder bid. Additional direct builder payments, deployment and infrastructure
costs are excluded. Builder inclusion and public availability of historical
orderflow are unverified. Counts identify hypothetical net-positive triggers,
not live wins or realized income. Size/route/funding alternatives are mutually
exclusive; nearby triggers may also overlap through the same pools. The report
therefore never sums their profits or extrapolates daily earnings. It always
states `commissioningEvidence: false` and never writes production proof paths.

The final table and `LOCAL_EXECUTOR_HISTORICAL_BATCH_SUMMARY` show coverage,
errors, net-positive trigger counts, counts above the configured net minimum,
and the best measured trade for each funding mode. Full per-trigger searches,
measured alternatives, fee references and private atomic checkpoints are saved
in `runtime/backrun/local-executor-batch.json`. A completed loss-making sample
exits successfully; an incomplete or technically failed scan exits nonzero.
Archive reads and cold prefix mining can take considerably longer than the
single-fixture sweep; progress and mining heartbeats remain visible.

Use explicit settings to extend coverage, without changing LIVE settings:

```bash
BACKRUN_START_BLOCK=26115853 BACKRUN_END_BLOCK=26115952 \
PAPER_ENV_FILE=.env.backrun-paper npm run backrun:executor-batch
```

Both range endpoints are required together; each run supports at most 100
blocks. `BACKRUN_BATCH_TOPOLOGY_PATH` optionally selects a JSON file with a
`pools` array containing 2–20 supported pools (`dex`, `poolAddress` or `address`,
plus `feeTier` for V3). Router/factory/quoter addresses come from the existing
profile and exact pool validation. No unrelated topology file is used silently.
Other optional bounds are `BACKRUN_BATCH_MAX_TRIGGERS` (default 200, maximum
1000), `BACKRUN_BATCH_MAX_ROUTES` (default 32, maximum 64),
`BACKRUN_BATCH_MIN_AMOUNT_WETH` (default configured maximum / 1,000,000, at least
one wei), `BACKRUN_BATCH_SIZING_SAMPLES` (default 10, range 2–20),
`BACKRUN_BATCH_SIZING_REFINEMENTS` (default 5, range 0–10), and
`BACKRUN_BATCH_FINALISTS` (default 3, range 1–5 per route/mode). An exceeded trigger
limit reports truncation explicitly; an exceeded route limit fails that trigger
instead of silently choosing a subset.
