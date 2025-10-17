// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title MockUniswapV2Router
/// @notice Minimal router stub that echoes swap parameters for testing.
contract MockUniswapV2Router {
    uint256 public lastAmountIn;
    uint256 public lastAmountOutMin;
    address public lastTokenIn;
    address public lastTokenOut;
    address public lastTo;

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        lastAmountIn = amountIn;
        lastAmountOutMin = amountOutMin;
        lastTo = to;
        if (path.length > 0) {
            lastTokenIn = path[0];
            lastTokenOut = path[path.length - 1];
        }

        amounts = new uint256[](path.length);
        if (path.length > 0) {
            amounts[0] = amountIn;
        }
    }
}
