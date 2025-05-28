// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.20;

// ─── Local Interfaces ────────────────────────────────────────────────────────
import "./interfaces/ILendingPoolAddressesProvider.sol";
import "./interfaces/ILendingPool.sol";
import "./interfaces/IFlashLoanReceiver.sol";

// ─── External Interfaces ─────────────────────────────────────────────────────
import "@uniswap/v2-periphery/contracts/interfaces/IUniswapV2Router02.sol";

// ─── OpenZeppelin ────────────────────────────────────────────────────────────
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @title ArbitrageFlashloan
/// @notice Simple Aave‑V2 flash‑loan contract that performs three swaps (Uni → Sushi → Uni)
///         and repays the loan in the same transaction.  Includes runtime loss‑cap and
///         min‑profit guard‐rails.
contract ArbitrageFlashloan is Ownable, ReentrancyGuard, IFlashLoanReceiver {
    using SafeERC20 for IERC20;

    // ─── Immutable Config ────────────────────────────────────────────────────
    ILendingPoolAddressesProvider public immutable addressesProvider;
    ILendingPool                 public immutable lendingPool;
    IUniswapV2Router02           public immutable uniswapRouter;
    IUniswapV2Router02           public immutable sushiRouter;

    // ─── Risk Parameters ─────────────────────────────────────────────────────
    uint256 public maxLossBps = 100; // 1 %

    function setMaxLossBps(uint256 bps) external onlyOwner {
        require(bps <= 1_000, "too generous"); // ≤ 10 %
        maxLossBps = bps;
    }

    /// @dev Swap parameters bundled to avoid stack‑too‑deep.
    struct SwapData {
        address[] uniPath;
        address[] sushiPath;
        address[] thirdPath;
        uint256   minOutUni;
        uint256   minOutSushi;
        uint256   minOutThird;
        uint256   minProfit;
    }

    // ─── Events ──────────────────────────────────────────────────────────────
    event SwapExecuted(address dex, address[] path, uint256 amountIn, uint256 amountOut);
    event ArbitrageExecuted(uint256 borrowed, int256 pnl);
    event LossExceeded(uint256 loss);
    event ProfitWithdrawn(address token, uint256 amount);

    // ─── Constructor ─────────────────────────────────────────────────────────
    constructor(address _provider, address _uni, address _sushi) {
        require(_provider != address(0) && _uni != address(0) && _sushi != address(0), "zero addr");
        addressesProvider = ILendingPoolAddressesProvider(_provider);
        lendingPool       = ILendingPool(addressesProvider.getLendingPool());
        uniswapRouter     = IUniswapV2Router02(_uni);
        sushiRouter       = IUniswapV2Router02(_sushi);
    }

    // ─── Public Flash‑Loan Entry ─────────────────────────────────────────────
    function initiateFlashLoan(
        address  token,
        uint256  amount,
        SwapData calldata data
    ) external onlyOwner {
        // basic path sanity‑checks ------------------------------------------------
        require(data.uniPath.length   >= 2, "uni <2");
        require(data.sushiPath.length >= 2, "sushi <2");
        require(data.thirdPath.length >= 2, "third <2");
        require(token == data.uniPath[0],                       "uni start");
        require(token == data.sushiPath[data.sushiPath.length-1], "sushi end");
        require(token == data.thirdPath[data.thirdPath.length-1], "third end");

        address[]  memory assets  = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory modes   = new uint256[](1);
        assets[0]  = token;
        amounts[0] = amount;
        modes[0]   = 0; // no debt (full repayment)

        lendingPool.flashLoan(
            address(this),
            assets,
            amounts,
            modes,
            address(this),
            abi.encode(data),
            0
        );
    }

    // ─── Aave Callback ───────────────────────────────────────────────────────
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address         initiator,
        bytes   calldata params
    ) external override nonReentrant returns (bool) {
        require(msg.sender == address(lendingPool), "only pool");
        require(initiator  == address(this),        "bad initiator");

        SwapData memory d = abi.decode(params, (SwapData));
        int256 pnl = _performArb(amounts[0], premiums[0], d);

        _settleAndWithdraw(assets[0], amounts[0], premiums[0], pnl, d.minProfit);
        return true;
    }

    // ─── Internals ───────────────────────────────────────────────────────────
    function _performArb(uint256 amountIn, uint256 premium, SwapData memory d) internal returns (int256) {
        uint256 out = _swap(uniswapRouter, d.uniPath,   amountIn, d.minOutUni);
        out         = _swap(sushiRouter,  d.sushiPath,  out,      d.minOutSushi);
        out         = _swap(uniswapRouter, d.thirdPath, out,      d.minOutThird);

        int256 pnl = int256(out) - int256(amountIn + premium);
        require(pnl >= int256(d.minProfit), "minProfit");

        emit ArbitrageExecuted(amountIn, pnl);
        return pnl;
    }

    function _swap(IUniswapV2Router02 router, address[] memory path, uint256 amtIn, uint256 minOut) private returns (uint256 out) {
        IERC20(path[0]).safeApprove(address(router), 0); // reset first (gas‑safe after OZ 4.8)
        IERC20(path[0]).safeIncreaseAllowance(address(router), amtIn);
        uint256[] memory amts = router.swapExactTokensForTokens(amtIn, minOut, path, address(this), block.timestamp);
        out = amts[amts.length-1];
        emit SwapExecuted(address(router), path, amtIn, out);
    }

    /// @dev isolate repayment branch to avoid "stack too deep" in executeOperation
    function _settleAndWithdraw(
        address asset,
        uint256 principal,
        uint256 fee,
        int256  pnl,
        uint256 minProfit
    ) private {
        if (pnl < 0) {
            uint256 loss = uint256(-pnl);
            uint256 maxLoss = (principal * maxLossBps) / 10_000;
            if (loss > maxLoss) {
                emit LossExceeded(loss);
                revert("loss > cap");
            }
        }

        uint256 debt = principal + fee;
        IERC20 token = IERC20(asset);
        uint256 bal  = token.balanceOf(address(this));
        require(bal >= debt, "bal < debt");

        if (bal > debt) {
            uint256 profit = bal - debt;
            require(profit >= minProfit, "profit < minProfit");
            token.safeTransfer(owner(), profit);
            emit ProfitWithdrawn(asset, profit);
        }

        token.safeIncreaseAllowance(address(lendingPool), debt);
    }

    // ─── Admin Sweep ─────────────────────────────────────────────────────────
    function withdrawProfit(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "no funds");
        IERC20(token).safeTransfer(owner(), bal);
        emit ProfitWithdrawn(token, bal);
    }
}
