# Funding and profitability

`BACKRUN_FUNDING_MODE` is `adaptive`, `capital` or `flashloan`. Adaptive prepares
both paths for the candidate and keeps the comparison on the row
(`fundingComparisons`).

For each path, after the trigger, on the fork:

```text
gasLimit         = executor estimate × 1.2              (≤ MAX_SINGLE_TRADE_GAS)
maxFee           = base fee + builder tip               (≤ GAS_PRICE_CEILING_GWEI; tip ≤ MAX_BUILDER_SHARE_BPS of profit, ≤ 5 gwei)
cost             = gasLimit × maxFee                    (in the borrow token)
expectedNet      = gross − funding cost − cost          (funding cost: 0 for CAPITAL, Aave premium for FLASH_LOAN)
accept           ⇔ expectedNet ≥ BACKRUN_MIN_PROFIT_<TOKEN>
on-chain floor   = minimum + cost                       (profit-or-revert in the executor)
```

Principal never leaves the executor's control: CAPITAL rows must preserve the
executor balance, and FLASH_LOAN repays within the same transaction.
Validation checks this decision under gas, builder and liquidity stress and
checks funding parity between the two paths
([SIZE_OPTIMIZATION.md](../validation/SIZE_OPTIMIZATION.md)).
