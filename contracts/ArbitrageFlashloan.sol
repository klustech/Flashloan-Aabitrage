// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @title ArbitrageFlashloan
/// @notice Aave V2 flash-loan arbitrage contract (N-hop dynamic path). Emits route in event.
import {IFlashLoanReceiver} from "./interfaces/IFlashLoanReceiver.sol";
import {ILendingPool} from "./interfaces/ILendingPool.sol";
import {ILendingPoolAddressesProvider} from "./interfaces/ILendingPoolAddressesProvider.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {IUniswapV2Router02} from "./interfaces/IUniswapV2Router02.sol";

contract ArbitrageFlashloan is IFlashLoanReceiver, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ─── State Variables ────────────────────────────────────────────────────────
    address public owner;
    ILendingPoolAddressesProvider public immutable provider;
    ILendingPool public immutable lendingPool;
    uint16 public maxLossBps;            // e.g. 1000 = 10%
    uint16 public constant MAX_LOSS_BPS = 1000;
    uint16 public flashloanPremiumBps;    // e.g. 9 for Aave V2

    /// @notice Emitted after a successful arbitrage execution
    event ArbitrageExecuted(uint256 borrowed, int256 pnl, string route);

    /// @notice Emitted on each individual swap step
    event SwapExecuted(
        address indexed router,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    /// @notice Emitted if the computed loss exceeds the allowed cap
    event LossExceeded(int256 pnl, uint16 maxLossBps);

    /// @notice Emitted when leftover profits are withdrawn by owner
    event ProfitWithdrawn(address indexed token, uint256 amount);

    constructor(address _provider, uint16 _maxLossBps, uint16 _flashloanPremiumBps) {
        require(_maxLossBps <= MAX_LOSS_BPS, "maxLossBps>limit");
        owner = msg.sender;
        provider = ILendingPoolAddressesProvider(_provider);
        lendingPool = ILendingPool(provider.getLendingPool());
        maxLossBps = _maxLossBps;
        flashloanPremiumBps = _flashloanPremiumBps;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "unauthorized");
        _;
    }

    /// @notice Bundle of N swap paths + slippage data + minProfit + route string
    struct SwapData {
        address token;             // The token to borrow (e.g. DAI)
        address[][] paths;         // Each path: [router, tokenIn, ..., tokenOut]
        uint256[]  minOuts;        // Slippage-protected min amounts for each path
        uint256    minProfit;      // Minimal profit required in borrowed token
        string     route;          // Human-readable route "DAI→WETH→USDC→DAI"
    }

    /// @notice Owner can update the max allowable loss in bps
    function setMaxLossBps(uint16 _maxLossBps) external onlyOwner {
        require(_maxLossBps <= MAX_LOSS_BPS, "maxLossBps>limit");
        maxLossBps = _maxLossBps;
    }

    /// @notice Owner can pause the contract (circuit breaker)
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Owner can unpause the contract
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Initiate an Aave V2 flashloan with given SwapData
     * @param token The ERC20 token to borrow (must match data.token)
     * @param amount The amount of token to borrow
     * @param data The SwapData struct, which includes all paths/minOuts/minProfit and the route string
     */
    function initiateFlashLoan(
        address token,
        uint256 amount,
        SwapData calldata data
    ) external onlyOwner whenNotPaused {
        // Sanity-checks for dynamic paths
        require(data.paths.length > 0, "no paths provided");
        require(data.paths.length == data.minOuts.length, "paths/minOuts mismatch");
        // Ensure each path has at least [router, tokenIn, tokenOut]
        for (uint256 i = 0; i < data.paths.length; i++) {
            require(data.paths[i].length >= 3, "each path <3");
        }
        // Ensure borrowed token matches first tokenIn and final tokenOut
        require(token == data.paths[0][1], "token!=firstIn");
        address[] memory lastPath = data.paths[data.paths.length - 1];
        require(token == lastPath[lastPath.length - 1], "token!=lastOut");

        // ─── Declare the Aave flash-loan arrays ───────────────────────────────────
        address[] memory assets = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory modes = new uint256[](1);

        assets[0]  = token;
        amounts[0] = amount;
        modes[0]   = 0; // 0 = no debt (full flash)

        // Encode the SwapData so executeOperation decodes it
        bytes memory params = abi.encode(data);

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

    /// @inheritdoc IFlashLoanReceiver
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external override nonReentrant returns (bool) {
        // Safety checks
        require(msg.sender == address(lendingPool), "only pool");
        require(initiator == address(this), "bad initiator");

        // Decode SwapData, including route string
        SwapData memory sd = abi.decode(params, (SwapData));

        // Perform the N-hop arbitrage sequence
        int256 pnl = _performArb(amounts[0], premiums[0], sd);

        // After swaps, settle and repay Aave
        _settleAndWithdraw(assets[0], amounts[0], premiums[0], pnl, sd.minProfit, sd.route);
        return true;
    }

    /// @dev Internal function that executes the N-hop swap logic; returns pnl
    function _performArb(
        uint256 amountIn,
        uint256 premium,
        SwapData memory sd
    ) internal returns (int256) {
        // Execute each path in sequence
        for (uint256 i = 0; i < sd.paths.length; i++) {
            _swap(sd.paths[i], sd.minOuts[i]);
        }

        // Compute profit-and-loss: (finalBalance − (borrowed + premium))
        uint256 finalBal = IERC20(sd.token).balanceOf(address(this));
        uint256 required = amountIn + premium;
        int256 pnl = int256(finalBal) - int256(required);

        // Enforce minProfit or maxLoss
        if (pnl >= 0) {
            require(uint256(pnl) >= sd.minProfit, "profit<minProfit");
        } else {
            uint256 lossAbs = uint256(-pnl);
            uint256 maxLossAllowed = (required * maxLossBps) / 10000;
            if (lossAbs > maxLossAllowed) {
                emit LossExceeded(pnl, maxLossBps);
                revert("loss>cap");
            }
        }

        return pnl;
    }

    /// @dev Internal helper to perform a single swap on a given router
    /// @param path [router, tokenIn, ..., tokenOut]
    /// @param minOut minimum acceptable amountOut
    function _swap(address[] memory path, uint256 minOut) internal returns (uint256) {
        require(path.length >= 3, "path too short");
        address routerAddr = path[0];

        // Extract token path (remove router address)
        address[] memory tokenPath = new address[](path.length - 1);
        for (uint i = 0; i < tokenPath.length; i++) {
            tokenPath[i] = path[i+1];
        }

        address tokenIn = tokenPath[0];
        address tokenOut = tokenPath[tokenPath.length - 1];
        uint256 amountIn = IERC20(tokenIn).balanceOf(address(this));

        // Approve router to spend tokenIn
        IERC20(tokenIn).safeApprove(routerAddr, 0);
        IERC20(tokenIn).safeApprove(routerAddr, amountIn);

        // Perform the swapExactTokensForTokens
        uint256[] memory amounts = IUniswapV2Router02(routerAddr).swapExactTokensForTokens(
            amountIn,
            minOut,
            tokenPath,
            address(this),
            block.timestamp
        );
        uint256 outAmt = amounts[amounts.length - 1];

        emit SwapExecuted(routerAddr, tokenIn, tokenOut, amountIn, outAmt);
        return outAmt;
    }

    /// @dev After _performArb, this repays Aave and emits the final event (with route)
    function _settleAndWithdraw(
        address asset,
        uint256 principal,
        uint256 fee,
        int256 pnl,
        uint256 minProfit,
        string memory route
    ) private {
        // 1) If pnl < 0, ensure within loss cap (already checked); if >0, ensure ≥ minProfit (already checked)
        // 2) Repay Aave: principal + fee
        uint256 debt = principal + fee;
        IERC20 token = IERC20(asset);
        uint256 bal = token.balanceOf(address(this));
        require(bal >= debt, "bal<debt");

        if (bal > debt) {
            uint256 profit = bal - debt;
            // Already checked profit ≥ minProfit in _performArb()
            token.safeTransfer(owner, profit);
            emit ProfitWithdrawn(asset, profit);
        }

        // Approve Aave’s LendingPool to pull back repayment
        token.safeIncreaseAllowance(address(lendingPool), debt);

        // 3) Emit final event, including the route string
        emit ArbitrageExecuted(principal, pnl, route);
    }

    /// @notice Owner can withdraw any leftover ERC20 tokens
    function rescueToken(address tokenAddr, uint256 amount) external onlyOwner {
        IERC20(tokenAddr).safeTransfer(owner, amount);
    }

    /// @notice Prevent accidental renouncement of ownership
    function renounceOwnership() public pure {
        revert("cannot renounceOwnership");
    }

    /// @notice Transfer control to a new owner
    /// @param newOwner Address of the new owner
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "new owner zero");
        owner = newOwner;
    }
}
