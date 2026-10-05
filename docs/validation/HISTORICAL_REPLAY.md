# Historical replay

Replays real mainnet blocks on local Anvil and appends the **unsigned**
executor v4 call after the trigger, in the same historical block, with the
block's own header and the canonical transaction prefix. Every prefix receipt
must match mainnet (status, gas, logs) before the executor result counts.

| Command | Output | Purpose |
|---|---|---|
| `npm run backrun:executor-sweep` | `runtime/backrun/local-executor-sweep.json` | Size × priority-fee grid on the fixture trigger (block 26115902) |
| `npm run backrun:executor-batch` | `runtime/backrun/local-executor-batch.json` | Every tracked-pool Swap trigger in a block range, both funding modes, engine-sized |
| `npm run backrun:replay` | replay proof | Canonical intra-block transition proof for commissioning |
| `npm run backrun:benchmark` | benchmark report | 7-to-30-day commissioning benchmark |

Both sweep and batch reports record `executorVersion` and
`executorArtifactHash`. The canonical-replay gate refuses reports from another
executor build.

## Batch options

| Variable | Default | Bound |
|---|---|---|
| `BACKRUN_START_BLOCK` / `BACKRUN_END_BLOCK` | fixture ±10 | ≤ 100 blocks per run; set both |
| `BACKRUN_BATCH_TOPOLOGY_PATH` | fixture pools | 2–20 explicit supported pools |
| `BACKRUN_BATCH_MAX_TRIGGERS` | 200 | 1–1000 |
| `BACKRUN_BATCH_MAX_ROUTES` | 32 | 1–64, exceeding it is an error, never silent truncation |
| `BACKRUN_BATCH_SIZING_SAMPLES` / `_REFINEMENTS` / `_FINALISTS` | 10 / 5 / 3 | |
| `BACKRUN_BATCH_MIN_AMOUNT_WETH` | max / 10⁶ | |

## Discovery study vs commissioning benchmark

Ranges chosen *because* they contain a known profitable block are a
**discovery study**. They show the mechanics work but say nothing about
frequency. The **commissioning benchmark** covers a contiguous period chosen in
advance, includes unprofitable and unsupported triggers, and counts technical
failures. The batch report states its coverage and sampling. Do not present a
discovery study as economics.

## What the replay gate checks

- ≥ 1 measured CAPITAL and ≥ 1 measured FLASH_LOAN execution;
- every successful execution: canonical receipts verified, same block,
  principal preserved;
- no unresolved technical errors (`ERROR` rows, block errors);
- reports from this executor version and artifact hash.
