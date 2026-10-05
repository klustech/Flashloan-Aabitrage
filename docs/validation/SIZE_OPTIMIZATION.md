# Size, gas, builder, liquidity and funding gates

Inputs are the measured sweep and batch reports. Each gate runs the real
`BackrunTransactionBuilder.prepare` decision, not a re-implementation.

```bash
npm run backrun:validate:economics   # all six gates
npm run backrun:validate:size        # or one at a time
npm run backrun:validate:gas
```

| Gate | Method | Pass |
|---|---|---|
| Size | Net vs amount curve per funding mode and priority-fee level from the sweep; the engine's chosen size comes from the batch for the same trigger | Wherever some size is profitable: the chosen size nets ≥ 95% of the best measured size (interpolated if it is between grid points); the optimum is not at the grid edge, where larger sizes quote-rejected as unprofitable count as the falling side (else extend `BACKRUN_SWEEP_AMOUNTS_WETH`). Fee levels with no profitable size are reported, not judged |
| Gas | Base fee ×0.5–×10, gas usage ×1.0–×1.5 against each measured row | No accepted decision whose realised net (actual gas × min(base + priority, maxFee)) is below the minimum. Usage above the signed limit reverts, which costs gas but never principal |
| Builder | Surplus after flash fee and gas at builder shares 0–95% | No accepted decision at configured shares ≤ 50% nets below minimum; reports the maximum competitive share |
| Liquidity | Output haircuts 10–250 bps | Net decreases monotonically; rows below the floor are rejected or revert |
| Funding parity | Pairs of CAPITAL/FLASH_LOAN rows with the same trigger, block and amount | Equal gross; CAPITAL fee 0; FLASH fee > 0; `capitalNet − flashNet = flashFee + Δgas × price` |

## Limitation: stale quotes inside one historical block

Thinning real pools inside a canonical replay changes the trigger's own
receipts, and storage cannot be written between two transactions of one
mined block. The stale-quote case is therefore covered by the executor's
on-chain profit floor (adversarial contract test, rates 1095/1080/1000/990 per
1000 against a 9-token floor) plus the analytic output-haircut gate above.
