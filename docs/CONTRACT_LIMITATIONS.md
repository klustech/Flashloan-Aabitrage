# Smart Contract Limitations

This document outlines the architectural decisions and limitations of the `ArbitrageFlashloan.sol` contract, particularly regarding DEX integrations.

## Overview

The arbitrage contract supports multiple DEX types:
- Uniswap V2 (`DexType.UNISWAP_V2`)
- Uniswap V3 (`DexType.UNISWAP_V3`)
- SushiSwap (`DexType.SUSHISWAP`)
- Balancer V2 (`DexType.BALANCER`)
- Curve (`DexType.CURVE`)

Each DEX integration has specific characteristics and limitations.

---

## Uniswap V3: Single-Hop Only

### Current Implementation

The contract uses `exactInputSingle` for V3 swaps:

```solidity
function _swapV3(SwapStep memory step, uint256 amountIn) internal returns (uint256) {
    ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
        tokenIn: step.tokenIn,
        tokenOut: step.tokenOut,
        fee: step.v3Fee,
        recipient: address(this),
        deadline: block.timestamp,
        amountIn: amountIn,
        amountOutMinimum: step.minAmountOut,
        sqrtPriceLimitX96: 0
    });
    return ISwapRouter(step.router).exactInputSingle(params);
}
```

### Limitation

- **No `exactInputMultihop`**: The contract does not support V3's multi-hop routing within a single swap call.
- Multi-token routes through V3 pools must be broken into separate `SwapStep` entries.

### Design Rationale

This is **by design**, not a bug:

1. **Transparency**: Each hop is a separate `SwapStep`, making gas costs and slippage explicit
2. **Flexibility**: Routes can mix V2, V3, Balancer, and Curve pools freely
3. **Control**: Individual `minAmountOut` can be set per hop
4. **Simplicity**: Avoids complex path encoding

### Example: V3 Multi-Hop Route

Instead of a single V3 multi-hop call like:
```
DAI -> WETH -> USDC (one exactInput call with encoded path)
```

The bot sends two `SwapStep` entries:
```
SwapStep[0]: DAI -> WETH (V3, 3000 fee)
SwapStep[1]: WETH -> USDC (V3, 500 fee)
```

### Gas Implications

| Approach | Estimated Gas |
|----------|---------------|
| Single `exactInput` (multi-hop) | ~150,000 |
| Two `exactInputSingle` calls | ~200,000 |

The overhead is ~50k gas (~$2-3 at 30 Gwei), which is acceptable for most profitable arbitrage opportunities.

---

## Balancer V2: Single-Pool Swaps

### Current Implementation

The contract uses `IBalancerVault.swap()` for single-pool swaps:

```solidity
function _swapBalancer(SwapStep memory step, uint256 amountIn) internal returns (uint256) {
    IBalancerVault.SingleSwap memory singleSwap = IBalancerVault.SingleSwap({
        poolId: step.balancerPoolId,
        kind: IBalancerVault.SwapKind.GIVEN_IN,
        assetIn: IAsset(step.tokenIn),
        assetOut: IAsset(step.tokenOut),
        amount: amountIn,
        userData: ""
    });
    // ...
    return IBalancerVault(step.router).swap(singleSwap, funds, step.minAmountOut, block.timestamp);
}
```

### Limitation

- **No `batchSwap`**: The contract does not use Balancer's `batchSwap` function for multi-pool routes.
- Each Balancer hop requires a separate `SwapStep`.

### Design Rationale

1. **Consistency**: Same pattern as V3 - one swap per step
2. **Cross-DEX**: Balancer hops can be combined with other DEX types in a route
3. **Simplicity**: Avoids complex batch encoding and multi-pool coordination

### Example: Balancer Multi-Pool Route

Instead of a single `batchSwap`:
```
DAI -> BAL -> WETH (batchSwap with two poolIds)
```

The bot sends two `SwapStep` entries:
```
SwapStep[0]: DAI -> BAL (Balancer, poolId1)
SwapStep[1]: BAL -> WETH (Balancer, poolId2)
```

---

## Curve: Index-Based Swaps

### Current Implementation

Curve swaps use index-based token selection via `exchange`:

```solidity
function _swapCurve(SwapStep memory step, uint256 amountIn) internal returns (uint256) {
    return ICurvePool(step.router).exchange(
        step.curveI,
        step.curveJ,
        amountIn,
        step.minAmountOut
    );
}
```

### Characteristics

- **Index-Based**: Requires knowing token indices in the pool (0, 1, 2, etc.)
- **Pool-Specific**: Each Curve pool has different token orderings
- **No Multi-Pool**: Similar to Balancer, multi-pool routes require separate steps

### Important Notes

1. **Index Validation**: The off-chain bot must correctly map token addresses to pool indices
2. **Factory vs Registry**: Some pools use `exchange_underlying` for meta-pools
3. **Slippage**: Curve pools can have significant slippage on large trades

---

## SushiSwap: Same as Uniswap V2

SushiSwap uses the identical V2 router interface as Uniswap V2:

```solidity
function _swapV2(SwapStep memory step, uint256 amountIn) internal returns (uint256) {
    // Same logic for both UNISWAP_V2 and SUSHISWAP
    // ...
}
```

No specific limitations beyond standard V2 characteristics.

---

## Cross-DEX Route Construction

### Supported Pattern

The contract supports arbitrary combinations of DEX types in a single arbitrage:

```
[V2] DAI -> WETH (Uniswap V2)
[V3] WETH -> USDC (Uniswap V3, 500 fee)
[Balancer] USDC -> BAL (Balancer pool)
[Curve] BAL -> DAI (Curve pool)
```

### SwapStep Structure

Each hop is defined by a `SwapStep`:

```solidity
struct SwapStep {
    address tokenIn;
    address tokenOut;
    address router;
    DexType dexType;
    uint256 minAmountOut;
    uint24 v3Fee;           // Only for V3
    bytes32 balancerPoolId; // Only for Balancer
    int128 curveI;          // Only for Curve
    int128 curveJ;          // Only for Curve
}
```

---

## Gas Optimization Notes

### Current Overhead

| Route Type | Steps | Approximate Gas |
|------------|-------|-----------------|
| 2-hop V2 only | 2 | ~150,000 |
| 3-hop V2 only | 3 | ~200,000 |
| 2-hop V2 + V3 | 2 | ~160,000 |
| 3-hop mixed (V2/V3/Balancer) | 3 | ~300,000 |

### Potential Optimizations (Not Implemented)

1. **V3 Multi-Hop Encoding**: Use `exactInput` with packed path for pure V3 routes
2. **Balancer BatchSwap**: Batch multiple Balancer swaps into single call
3. **Assembly Optimization**: Direct calldata construction for critical paths

These optimizations were not implemented because:
- Increased code complexity
- Reduced auditability
- Marginal gas savings vs. flexibility loss

---

## Recommendations for Operators

### Route Selection

1. **Prefer V2 Pools**: Lower gas costs for comparable liquidity
2. **Minimize Hops**: Each hop adds ~60-100k gas
3. **Check Liquidity**: Ensure minimum liquidity to avoid slippage

### Profitability Threshold

Account for gas overhead when setting `MIN_PROFIT_DAI`:

```
Required Profit > Gas Cost + Protocol Fee + Safety Margin

Example at 30 Gwei, 3-hop route:
Gas: 300,000 * 30 Gwei * $3000 ETH = ~$27
Protocol Fee: 0.09% of flash loan
Safety Margin: 10%

MIN_PROFIT_DAI should be > $30 for 3-hop routes
```

### Monitoring

Track gas efficiency metrics:
- Average gas per successful trade
- Gas cost as percentage of profit
- Route type distribution

---

## Future Considerations

### Potential Enhancements

1. **V3 Multi-Hop Support**: Add optional `exactInput` for pure V3 routes
2. **Balancer batchSwap**: Add batch support for multi-Balancer routes
3. **Curve Meta-Pool Support**: Handle `exchange_underlying` automatically
4. **L2 Deployments**: Arbitrum, Optimism, Base with adapted gas settings

### Breaking Changes to Avoid

- Do not change `SwapStep` struct layout (affects calldata encoding)
- Do not change `DexType` enum ordering (affects existing integrations)
- Maintain backwards compatibility for existing route formats

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | Initial | V2, V3 (single), Balancer (single), Curve support |

---

## References

- [Uniswap V3 Router Docs](https://docs.uniswap.org/contracts/v3/reference/periphery/SwapRouter)
- [Balancer V2 Vault](https://docs.balancer.fi/reference/contracts/vault.html)
- [Curve Exchange Functions](https://curve.readthedocs.io/exchange-pools.html)
- [Aave V2 Flash Loans](https://docs.aave.com/developers/guides/flash-loans)
