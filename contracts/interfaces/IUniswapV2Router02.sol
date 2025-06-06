// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @dev Standard Uniswap V2 Router02 interface (only the functions we actually call added).
interface IUniswapV2Router02 {
    // --- liquidity-related functions (unchanged) ---
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint amountADesired,
        uint amountBDesired,
        uint amountAMin,
        uint amountBMin,
        address to,
        uint deadline
    ) external returns (
        uint amountA,
        uint amountB,
        uint liquidity
    );

    // --- Approval helper (we rarely need it) ---
    function approve(address spender, uint value) external returns (bool);

    // --- SWAP functions we need to make swaps work ---

    /// @notice Swaps exactly `amountIn` of tokenIn for as many tokenOut as possible,
    ///         through the given `path` of token addresses, sending results to `to`.
    /// @param amountIn     how many tokens we send in (msg.sender must have approved this contract)
    /// @param amountOutMin the minimum amount of output tokens we require (slippage control)
    /// @param path         array of token addresses; path[0] is tokenIn, path[last] is tokenOut
    /// @param to           the address receiving the final output tokens
    /// @param deadline     Unix timestamp after which this transaction reverts
    /// @return amounts     array of output amounts at each hop; last element is the final `tokenOut` amount
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    /// @notice Given an `amountIn` and `path`, returns the amounts out at each hop (for quoting).
    function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts);
}
