// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockUniswapV2Router
/// @notice Minimal router stub that performs deterministic swaps for testing.
contract MockUniswapV2Router {
    struct Rate {
        uint256 numerator;
        uint256 denominator;
    }

    mapping(address => mapping(address => Rate)) public rates;

    function setRate(
        address tokenIn,
        address tokenOut,
        uint256 numerator,
        uint256 denominator
    ) external {
        require(denominator != 0, "denominator=0");
        rates[tokenIn][tokenOut] = Rate({numerator: numerator, denominator: denominator});
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        require(path.length >= 2, "path too short");

        // Pull the input tokens
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;

        uint256 runningAmount = amountIn;
        for (uint256 i = 1; i < path.length; i++) {
            Rate memory rate = rates[path[i - 1]][path[i]];
            require(rate.denominator != 0, "rate unset");
            runningAmount = (runningAmount * rate.numerator) / rate.denominator;
            amounts[i] = runningAmount;
        }

        require(runningAmount >= amountOutMin, "slippage");

        IERC20(path[path.length - 1]).transfer(to, runningAmount);
    }
}
