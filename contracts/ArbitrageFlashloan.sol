// contracts/ArbitrageFlashloan.sol
// SPDX-License-Identifier: GPL-3.0-or-later

pragma solidity ^0.8.0;
pragma experimental ABIEncoderV2;

// Import local, updated interfaces instead of the original Aave v2 versions
import "./interfaces/ILendingPoolAddressesProvider.sol";
import "./interfaces/ILendingPool.sol";
import "./interfaces/IFlashLoanReceiver.sol";

// Uniswap V2 Router Interface
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";

// OpenZeppelin Libraries
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ArbitrageFlashloan
 * @notice Executes flashloan-based arbitrage using Uniswap and SushiSwap, with dynamic slippage and minimum profit checks.
 */
contract ArbitrageFlashloan is Ownable, IFlashLoanReceiver {
    using SafeERC20 for IERC20;

    ILendingPoolAddressesProvider public addressesProvider;
    ILendingPool public lendingPool;

    IUniswapV2Router02 public uniswapRouter;
    IUniswapV2Router02 public sushiSwapRouter;

    // Maximum allowable loss threshold (in DAI)
    uint256 public constant MAX_LOSS_THRESHOLD = 100 ether;

    struct SwapData {
        address[] uniswapPath;
        address[] sushiPath;
        address[] thirdPath;
        uint256 minOutUni;
        uint256 minOutSushi;
        uint256 minOutThird;
        uint256 minProfit;
    }

    event ArbitrageExecuted(uint256 borrowAmount, int256 profit, string route);
    event ProfitWithdrawn(address token, uint256 amount);
    event LossExceeded(uint256 loss);
    event SwapExecuted(
        address dex,
        address[] path,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(
        address _addressesProvider,
        address _uniswapRouter,
        address _sushiSwapRouter
    ) {
        require(_addressesProvider != address(0), "Invalid AddressesProvider");
        require(_uniswapRouter != address(0), "Invalid Uniswap Router");
        require(_sushiSwapRouter != address(0), "Invalid SushiSwap Router");

        addressesProvider = ILendingPoolAddressesProvider(_addressesProvider);
        lendingPool = ILendingPool(addressesProvider.getLendingPool());
        uniswapRouter = IUniswapV2Router02(_uniswapRouter);
        sushiSwapRouter = IUniswapV2Router02(_sushiSwapRouter);
    }

    /**
     * @notice Initiates a flashloan from Aave, specifying swap paths and minimum outputs.
     */
    function initiateFlashLoan(
        address tokenToBorrow,
        uint256 amountToBorrow,
        SwapData calldata swapData
    ) external onlyOwner {
        require(swapData.uniswapPath.length >= 2, "Uniswap path too short");
        require(swapData.sushiPath.length >= 2, "SushiSwap path too short");
        require(swapData.thirdPath.length >= 2, "Third path too short");

        // Validate that tokenToBorrow matches the specified paths
        require(tokenToBorrow == swapData.uniswapPath[0], "Mismatch in Uniswap path start");
        require(tokenToBorrow == swapData.sushiPath[swapData.sushiPath.length - 1], "Mismatch in SushiSwap path end");
        require(tokenToBorrow == swapData.thirdPath[swapData.thirdPath.length - 1], "Mismatch in Third path end");

        address[] memory assets = new address[](1);
        assets[0] = tokenToBorrow;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amountToBorrow;

        uint256[] memory modes = new uint256[](1);
        modes[0] = 0; // No debt mode

        bytes memory params = abi.encode(swapData);

        lendingPool.flashLoan(
            address(this),
            assets,
            amounts,
            modes,
            address(this),
            params,
            0 // referralCode
        );
    }

    /**
     * @notice This function is called after the flash loan is received.
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    )
        external
        override
        returns (bool)
    {
        require(msg.sender == address(lendingPool), "Caller must be LendingPool");
        require(initiator == address(this), "Initiator must be this contract");

        SwapData memory swapData = abi.decode(params, (SwapData));

        // Perform the arbitrage using the flattened swap chain helper
        int256 profit = _performArbitrageFlattened(amounts[0], premiums[0], swapData);

        if (profit < 0) {
            uint256 loss = uint256(-profit);
            if (loss > MAX_LOSS_THRESHOLD) {
                emit LossExceeded(loss);
                revert("Loss exceeded threshold");
            }
        }

        uint256 totalDebt = amounts[0] + premiums[0];
        // Automatic Profit Withdrawal
        address tokenAddress = assets[0];
        IERC20 token = IERC20(tokenAddress);
        uint256 currentBalance = token.balanceOf(address(this));
        require(currentBalance >= totalDebt, "Insufficient funds for repayment");
        uint256 profitAmount = currentBalance - totalDebt;
        if (profitAmount > 0) {
            token.safeTransfer(owner(), profitAmount);
            emit ProfitWithdrawn(tokenAddress, profitAmount);
        }
        token.safeApprove(address(lendingPool), totalDebt);
        return true;
    }

    /**
     * @dev Helper function to perform the swap chain in a flattened manner.
     * This reduces the number of local variables to alleviate stack depth issues.
     */
    function _performArbitrageFlattened(
        uint256 amountIn,
        uint256 premium,
        SwapData memory swapData
    ) internal returns (int256) {
        uint256 result = _swapTokens(uniswapRouter, swapData.uniswapPath, amountIn, swapData.minOutUni);
        result = _swapTokens(sushiSwapRouter, swapData.sushiPath, result, swapData.minOutSushi);
        result = _swapTokens(uniswapRouter, swapData.thirdPath, result, swapData.minOutThird);
        int256 profit = int256(result) - int256(amountIn + premium);
        if (profit < int256(swapData.minProfit)) {
            revert("Final profit below required threshold");
        }
        emit ArbitrageExecuted(amountIn, profit, "Uniswap->SushiSwap->Uniswap");
        return profit;
    }

    /**
     * @dev Helper function to perform token swaps.
     */
    function _swapTokens(
        IUniswapV2Router02 router,
        address[] memory path,
        uint256 amountIn,
        uint256 minAmountOut
    ) internal returns (uint256) {
        // Approve router to spend tokens
        IERC20(path[0]).safeApprove(address(router), amountIn);
        uint256[] memory amounts = router.swapExactTokensForTokens(
            amountIn,
            minAmountOut,
            path,
            address(this),
            block.timestamp
        );
        uint256 actualOut = amounts[amounts.length - 1];
        emit SwapExecuted(address(router), path, amountIn, actualOut);
        return actualOut;
    }

    /**
     * @notice Withdraws profit (ERC20 tokens) from the contract.
     */
    function withdrawProfit(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No profit to withdraw");
        IERC20(token).safeTransfer(owner(), balance);
        emit ProfitWithdrawn(token, balance);
    }
}
