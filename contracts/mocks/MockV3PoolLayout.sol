// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @dev Reproduces the UniswapV3Pool storage layout (slot0 in slot 0, liquidity
///      in slot 4) so MEV-Share log-derived state writes can be exercised.
contract MockV3PoolLayout {
    struct Slot0 {
        uint160 sqrtPriceX96;
        int24 tick;
        uint16 observationIndex;
        uint16 observationCardinality;
        uint16 observationCardinalityNext;
        uint8 feeProtocol;
        bool unlocked;
    }
    struct ProtocolFees {
        uint128 token0;
        uint128 token1;
    }

    Slot0 public slot0;
    uint256 public feeGrowthGlobal0X128;
    uint256 public feeGrowthGlobal1X128;
    ProtocolFees public protocolFees;
    uint128 public liquidity;

    constructor(uint160 sqrtPriceX96, int24 tick, uint128 _liquidity) {
        slot0 = Slot0(sqrtPriceX96, tick, 7, 9, 11, 0, true);
        feeGrowthGlobal0X128 = 123;
        liquidity = _liquidity;
    }
}
