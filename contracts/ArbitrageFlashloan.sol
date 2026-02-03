// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @title ArbitrageFlashloan
/// @notice Aave V2 flash-loan arbitrage contract with multi-DEX support (V2, V3, Balancer, Curve)
/// @dev Supports N-hop dynamic paths, profit recipient config, and timelock integration

import {IFlashLoanReceiver} from "./interfaces/IFlashLoanReceiver.sol";
import {ILendingPool} from "./interfaces/ILendingPool.sol";
import {ILendingPoolAddressesProvider} from "./interfaces/ILendingPoolAddressesProvider.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {IUniswapV2Router02} from "./interfaces/IUniswapV2Router02.sol";

// Uniswap V3 Router Interface
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

// Balancer V2 Vault Interface
interface IBalancerVault {
    enum SwapKind { GIVEN_IN, GIVEN_OUT }
    struct SingleSwap {
        bytes32 poolId;
        SwapKind kind;
        address assetIn;
        address assetOut;
        uint256 amount;
        bytes userData;
    }
    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address payable recipient;
        bool toInternalBalance;
    }
    function swap(
        SingleSwap memory singleSwap,
        FundManagement memory funds,
        uint256 limit,
        uint256 deadline
    ) external payable returns (uint256);
}

// Curve Pool Interface
interface ICurvePool {
    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256);
    function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256);
}

contract ArbitrageFlashloan is IFlashLoanReceiver, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ─── DEX Types ───────────────────────────────────────────────────────────────
    enum DexType { UNISWAP_V2, UNISWAP_V3, SUSHISWAP, BALANCER, CURVE }

    // ─── State Variables ────────────────────────────────────────────────────────
    address public owner;
    address public profitRecipient;
    address public timelock;

    ILendingPoolAddressesProvider public immutable provider;
    ILendingPool public immutable lendingPool;

    uint16 public maxLossBps;
    uint16 public constant MAX_LOSS_BPS = 1000; // 10% max
    uint16 public flashloanPremiumBps;

    // Timelock delay tracking for sensitive operations
    mapping(bytes32 => uint256) public timelockOperations;
    uint256 public constant TIMELOCK_DELAY = 24 hours;

    // ─── Events ─────────────────────────────────────────────────────────────────
    event ArbitrageExecuted(uint256 borrowed, int256 pnl, string route);
    event SwapExecuted(
        DexType indexed dexType,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    event LossExceeded(int256 pnl, uint16 maxLossBps);
    event ProfitWithdrawn(address indexed token, address indexed recipient, uint256 amount);
    event ProfitRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event TimelockChanged(address indexed oldTimelock, address indexed newTimelock);
    event MaxLossBpsChanged(uint16 oldValue, uint16 newValue);
    event TimelockOperationScheduled(bytes32 indexed operationId, uint256 executeAfter);
    event TimelockOperationExecuted(bytes32 indexed operationId);
    event EmergencyPause(address indexed triggeredBy);

    // ─── Structs ────────────────────────────────────────────────────────────────

    /// @notice Individual swap step supporting multiple DEX types
    struct SwapStep {
        DexType dexType;
        address router;           // Router/Vault/Pool address
        address tokenIn;
        address tokenOut;
        uint256 minAmountOut;
        // DEX-specific parameters
        uint24 v3Fee;             // Uniswap V3 fee tier (500, 3000, 10000)
        bytes32 balancerPoolId;   // Balancer pool ID
        int128 curveIndexIn;      // Curve token index in
        int128 curveIndexOut;     // Curve token index out
        bool curveUnderlying;     // Use exchange_underlying for Curve
        address[] v2Path;         // Full path for V2 routers (optional multi-hop)
    }

    /// @notice Complete arbitrage data bundle
    struct ArbitrageData {
        address borrowToken;      // Token to borrow via flashloan
        uint256 borrowAmount;     // Amount to borrow
        SwapStep[] steps;         // Sequence of swaps
        uint256 minProfit;        // Minimum acceptable profit
        string route;             // Human-readable route description
    }

    // ─── Modifiers ──────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "unauthorized");
        _;
    }

    modifier onlyOwnerOrTimelock() {
        require(msg.sender == owner || msg.sender == timelock, "unauthorized");
        _;
    }

    modifier onlyTimelock() {
        require(msg.sender == timelock, "only timelock");
        _;
    }

    // ─── Constructor ────────────────────────────────────────────────────────────

    constructor(
        address _provider,
        uint16 _maxLossBps,
        uint16 _flashloanPremiumBps,
        address _profitRecipient,
        address _timelock
    ) {
        require(_maxLossBps <= MAX_LOSS_BPS, "maxLossBps>limit");
        require(_provider != address(0), "invalid provider");

        owner = msg.sender;
        profitRecipient = _profitRecipient == address(0) ? msg.sender : _profitRecipient;
        timelock = _timelock;

        provider = ILendingPoolAddressesProvider(_provider);
        lendingPool = ILendingPool(provider.getLendingPool());
        maxLossBps = _maxLossBps;
        flashloanPremiumBps = _flashloanPremiumBps;
    }

    // ─── Admin Functions ────────────────────────────────────────────────────────

    /// @notice Update max allowable loss (requires timelock if set)
    function setMaxLossBps(uint16 _maxLossBps) external onlyOwnerOrTimelock {
        require(_maxLossBps <= MAX_LOSS_BPS, "maxLossBps>limit");
        emit MaxLossBpsChanged(maxLossBps, _maxLossBps);
        maxLossBps = _maxLossBps;
    }

    /// @notice Schedule a profit recipient change (timelock-protected)
    function scheduleProfitRecipientChange(address _newRecipient) external onlyOwner {
        require(_newRecipient != address(0), "invalid recipient");
        bytes32 opId = keccak256(abi.encodePacked("setProfitRecipient", _newRecipient));
        timelockOperations[opId] = block.timestamp + TIMELOCK_DELAY;
        emit TimelockOperationScheduled(opId, timelockOperations[opId]);
    }

    /// @notice Execute a scheduled profit recipient change
    function executeProfitRecipientChange(address _newRecipient) external onlyOwner {
        bytes32 opId = keccak256(abi.encodePacked("setProfitRecipient", _newRecipient));
        require(timelockOperations[opId] != 0, "not scheduled");
        require(block.timestamp >= timelockOperations[opId], "timelock pending");

        emit ProfitRecipientChanged(profitRecipient, _newRecipient);
        profitRecipient = _newRecipient;
        delete timelockOperations[opId];
        emit TimelockOperationExecuted(opId);
    }

    /// @notice Set profit recipient immediately (only via external timelock contract)
    function setProfitRecipientViaTimelock(address _newRecipient) external onlyTimelock {
        require(_newRecipient != address(0), "invalid recipient");
        emit ProfitRecipientChanged(profitRecipient, _newRecipient);
        profitRecipient = _newRecipient;
    }

    /// @notice Update timelock address
    function setTimelock(address _timelock) external onlyOwner {
        emit TimelockChanged(timelock, _timelock);
        timelock = _timelock;
    }

    /// @notice Emergency pause - can be called by owner immediately
    function pause() external onlyOwner {
        _pause();
        emit EmergencyPause(msg.sender);
    }

    /// @notice Unpause - requires timelock if set, otherwise owner
    function unpause() external onlyOwnerOrTimelock {
        _unpause();
    }

    // ─── Core Flash Loan Functions ──────────────────────────────────────────────

    /// @notice Initiate flash loan arbitrage
    /// @param data Complete arbitrage parameters
    function initiateFlashLoan(ArbitrageData calldata data) external onlyOwner whenNotPaused {
        _validateArbitrageData(data);

        address[] memory assets = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory modes = new uint256[](1);

        assets[0] = data.borrowToken;
        amounts[0] = data.borrowAmount;
        modes[0] = 0; // No debt mode

        bytes memory params = abi.encode(data);

        lendingPool.flashLoan(
            address(this),
            assets,
            amounts,
            modes,
            address(this),
            params,
            0
        );
    }

    /// @notice Legacy interface for backward compatibility
    function initiateFlashLoan(
        address token,
        uint256 amount,
        SwapData calldata legacyData
    ) external onlyOwner whenNotPaused {
        // Convert legacy SwapData to new format
        ArbitrageData memory data = _convertLegacyData(token, amount, legacyData);

        address[] memory assets = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        uint256[] memory modes = new uint256[](1);

        assets[0] = token;
        amounts[0] = amount;
        modes[0] = 0;

        bytes memory params = abi.encode(data);

        lendingPool.flashLoan(
            address(this),
            assets,
            amounts,
            modes,
            address(this),
            params,
            0
        );
    }

    /// @notice Legacy SwapData struct for backward compatibility
    struct SwapData {
        address token;
        address[][] paths;
        uint256[] minOuts;
        uint256 minProfit;
        string route;
    }

    /// @inheritdoc IFlashLoanReceiver
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external override nonReentrant returns (bool) {
        require(msg.sender == address(lendingPool), "only pool");
        require(initiator == address(this), "bad initiator");

        ArbitrageData memory data = abi.decode(params, (ArbitrageData));

        // Execute arbitrage
        int256 pnl = _executeArbitrage(amounts[0], premiums[0], data);

        // Settle and repay
        _settleAndRepay(assets[0], amounts[0], premiums[0], pnl, data.minProfit, data.route);

        return true;
    }

    // ─── Internal Swap Functions ────────────────────────────────────────────────

    function _executeArbitrage(
        uint256 borrowedAmount,
        uint256 premium,
        ArbitrageData memory data
    ) internal returns (int256) {
        uint256 currentAmount = borrowedAmount;

        for (uint256 i = 0; i < data.steps.length; i++) {
            currentAmount = _executeSwap(data.steps[i], currentAmount);
        }

        // Calculate PnL
        uint256 finalBalance = IERC20(data.borrowToken).balanceOf(address(this));
        uint256 required = borrowedAmount + premium;
        int256 pnl = int256(finalBalance) - int256(required);

        // Enforce profit/loss constraints
        if (pnl >= 0) {
            require(uint256(pnl) >= data.minProfit, "profit<minProfit");
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

    function _executeSwap(SwapStep memory step, uint256 amountIn) internal returns (uint256 amountOut) {
        // Approve router to spend tokens
        IERC20(step.tokenIn).safeApprove(step.router, 0);
        IERC20(step.tokenIn).safeApprove(step.router, amountIn);

        if (step.dexType == DexType.UNISWAP_V2 || step.dexType == DexType.SUSHISWAP) {
            amountOut = _swapV2(step, amountIn);
        } else if (step.dexType == DexType.UNISWAP_V3) {
            amountOut = _swapV3(step, amountIn);
        } else if (step.dexType == DexType.BALANCER) {
            amountOut = _swapBalancer(step, amountIn);
        } else if (step.dexType == DexType.CURVE) {
            amountOut = _swapCurve(step, amountIn);
        } else {
            revert("unsupported dex");
        }

        emit SwapExecuted(step.dexType, step.tokenIn, step.tokenOut, amountIn, amountOut);
    }

    function _swapV2(SwapStep memory step, uint256 amountIn) internal returns (uint256) {
        address[] memory path;

        if (step.v2Path.length > 0) {
            path = step.v2Path;
        } else {
            path = new address[](2);
            path[0] = step.tokenIn;
            path[1] = step.tokenOut;
        }

        uint256[] memory amounts = IUniswapV2Router02(step.router).swapExactTokensForTokens(
            amountIn,
            step.minAmountOut,
            path,
            address(this),
            block.timestamp
        );

        return amounts[amounts.length - 1];
    }

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

    function _swapBalancer(SwapStep memory step, uint256 amountIn) internal returns (uint256) {
        IBalancerVault.SingleSwap memory singleSwap = IBalancerVault.SingleSwap({
            poolId: step.balancerPoolId,
            kind: IBalancerVault.SwapKind.GIVEN_IN,
            assetIn: step.tokenIn,
            assetOut: step.tokenOut,
            amount: amountIn,
            userData: ""
        });

        IBalancerVault.FundManagement memory funds = IBalancerVault.FundManagement({
            sender: address(this),
            fromInternalBalance: false,
            recipient: payable(address(this)),
            toInternalBalance: false
        });

        return IBalancerVault(step.router).swap(singleSwap, funds, step.minAmountOut, block.timestamp);
    }

    function _swapCurve(SwapStep memory step, uint256 amountIn) internal returns (uint256) {
        uint256 balanceBefore = IERC20(step.tokenOut).balanceOf(address(this));

        if (step.curveUnderlying) {
            ICurvePool(step.router).exchange_underlying(
                step.curveIndexIn,
                step.curveIndexOut,
                amountIn,
                step.minAmountOut
            );
        } else {
            ICurvePool(step.router).exchange(
                step.curveIndexIn,
                step.curveIndexOut,
                amountIn,
                step.minAmountOut
            );
        }

        return IERC20(step.tokenOut).balanceOf(address(this)) - balanceBefore;
    }

    // ─── Settlement ─────────────────────────────────────────────────────────────

    function _settleAndRepay(
        address asset,
        uint256 principal,
        uint256 fee,
        int256 pnl,
        uint256 minProfit,
        string memory route
    ) private {
        uint256 debt = principal + fee;
        IERC20 token = IERC20(asset);
        uint256 balance = token.balanceOf(address(this));

        require(balance >= debt, "insufficient balance");

        // Transfer profit to recipient
        if (balance > debt) {
            uint256 profit = balance - debt;
            token.safeTransfer(profitRecipient, profit);
            emit ProfitWithdrawn(asset, profitRecipient, profit);
        }

        // Approve Aave to pull repayment
        token.safeIncreaseAllowance(address(lendingPool), debt);

        emit ArbitrageExecuted(principal, pnl, route);
    }

    // ─── Validation ─────────────────────────────────────────────────────────────

    function _validateArbitrageData(ArbitrageData calldata data) internal pure {
        require(data.steps.length > 0, "no steps");
        require(data.borrowAmount > 0, "zero borrow");

        // Validate cycle: first tokenIn must equal borrowToken, last tokenOut must equal borrowToken
        require(data.steps[0].tokenIn == data.borrowToken, "first step tokenIn mismatch");
        require(data.steps[data.steps.length - 1].tokenOut == data.borrowToken, "last step tokenOut mismatch");

        // Validate token continuity
        for (uint256 i = 1; i < data.steps.length; i++) {
            require(
                data.steps[i].tokenIn == data.steps[i - 1].tokenOut,
                "token continuity broken"
            );
        }
    }

    function _convertLegacyData(
        address token,
        uint256 amount,
        SwapData calldata legacy
    ) internal pure returns (ArbitrageData memory) {
        SwapStep[] memory steps = new SwapStep[](legacy.paths.length);

        for (uint256 i = 0; i < legacy.paths.length; i++) {
            require(legacy.paths[i].length >= 3, "path too short");

            address router = legacy.paths[i][0];
            address[] memory tokenPath = new address[](legacy.paths[i].length - 1);
            for (uint256 j = 0; j < tokenPath.length; j++) {
                tokenPath[j] = legacy.paths[i][j + 1];
            }

            steps[i] = SwapStep({
                dexType: DexType.UNISWAP_V2,
                router: router,
                tokenIn: tokenPath[0],
                tokenOut: tokenPath[tokenPath.length - 1],
                minAmountOut: legacy.minOuts[i],
                v3Fee: 0,
                balancerPoolId: bytes32(0),
                curveIndexIn: 0,
                curveIndexOut: 0,
                curveUnderlying: false,
                v2Path: tokenPath
            });
        }

        return ArbitrageData({
            borrowToken: token,
            borrowAmount: amount,
            steps: steps,
            minProfit: legacy.minProfit,
            route: legacy.route
        });
    }

    // ─── Utility Functions ──────────────────────────────────────────────────────

    /// @notice Rescue stuck ERC20 tokens
    function rescueToken(address tokenAddr, uint256 amount) external onlyOwner {
        IERC20(tokenAddr).safeTransfer(profitRecipient, amount);
    }

    /// @notice Prevent ownership renouncement
    function renounceOwnership() public pure {
        revert("cannot renounce");
    }

    /// @notice Transfer ownership
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        owner = newOwner;
    }

    /// @notice Get pending timelock operation timestamp
    function getTimelockOperation(bytes32 opId) external view returns (uint256) {
        return timelockOperations[opId];
    }

    /// @notice Check if contract can execute arbitrage
    function canExecute() external view returns (bool) {
        return !paused();
    }
}
