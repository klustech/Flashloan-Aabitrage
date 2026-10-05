// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @title ArbitrageFlashloan
/// @notice Multi-DEX arbitrage executor supporting Aave V2 flash liquidity and pre-funded capital
/// @dev Supports N-hop dynamic paths and adaptive funding entrypoints.
///      Authority is split: `admin` (intended to be a multisig-controlled
///      timelock) governs configuration and funds; `executors` (hot bot keys)
///      may only run profit-or-revert arbitrage through admin-approved routers
///      and trigger an emergency pause. An executor can never be the admin.

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
    enum DexType { UNISWAP_V2, UNISWAP_V3, SUSHISWAP, BALANCER, CURVE, PANCAKE_V3 }

    // ─── State Variables ────────────────────────────────────────────────────────
    address public admin;
    address public pendingAdmin;
    address public profitRecipient;
    mapping(address => bool) public executors;
    mapping(address => bool) public approvedRouters;

    ILendingPoolAddressesProvider public immutable provider;
    ILendingPool public immutable lendingPool;
    uint256 public constant executorVersion = 4;
    bool private loanActive;
    bool private callbackCompleted;
    bytes32 private activeDataHash;
    uint256 private balanceBeforeLoan;

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
    event ProfitWithdrawn(address indexed token, address indexed recipient, uint256 amount);
    event ProfitRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event ExecutorSet(address indexed account, bool allowed);
    event RouterSet(address indexed router, bool allowed);
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

    modifier onlyAdmin() {
        require(msg.sender == admin, "unauthorized");
        _;
    }

    modifier onlyExecutor() {
        require(executors[msg.sender], "unauthorized");
        _;
    }

    modifier onlyExecutorOrAdmin() {
        require(executors[msg.sender] || msg.sender == admin, "unauthorized");
        _;
    }

    // ─── Constructor ────────────────────────────────────────────────────────────

    constructor(
        address _provider,
        address _profitRecipient,
        address _admin,
        address _executor,
        address[] memory _routers
    ) {
        require(_provider != address(0), "invalid provider");
        require(_profitRecipient != address(0), "invalid recipient");
        require(_admin != address(0), "invalid admin");
        require(_executor != address(0) && _executor != _admin, "invalid executor");

        admin = _admin;
        profitRecipient = _profitRecipient;
        executors[_executor] = true;
        emit AdminTransferred(address(0), _admin);
        emit ExecutorSet(_executor, true);
        for (uint256 i = 0; i < _routers.length; i++) {
            require(_routers[i] != address(0), "zero router");
            approvedRouters[_routers[i]] = true;
            emit RouterSet(_routers[i], true);
        }

        provider = ILendingPoolAddressesProvider(_provider);
        lendingPool = ILendingPool(provider.getLendingPool());
    }

    // ─── Admin Functions ────────────────────────────────────────────────────────

    /// @notice Schedule a profit recipient change (24h delay on top of the admin's own timelock)
    function scheduleProfitRecipientChange(address _newRecipient) external onlyAdmin {
        require(_newRecipient != address(0), "invalid recipient");
        bytes32 opId = keccak256(abi.encodePacked("setProfitRecipient", _newRecipient));
        timelockOperations[opId] = block.timestamp + TIMELOCK_DELAY;
        emit TimelockOperationScheduled(opId, timelockOperations[opId]);
    }

    /// @notice Execute a scheduled profit recipient change
    function executeProfitRecipientChange(address _newRecipient) external onlyAdmin {
        bytes32 opId = keccak256(abi.encodePacked("setProfitRecipient", _newRecipient));
        require(timelockOperations[opId] != 0, "not scheduled");
        require(block.timestamp >= timelockOperations[opId], "timelock pending");

        emit ProfitRecipientChanged(profitRecipient, _newRecipient);
        profitRecipient = _newRecipient;
        delete timelockOperations[opId];
        emit TimelockOperationExecuted(opId);
    }

    /// @notice Grant or revoke the hot executor role. The admin can never hold it.
    function setExecutor(address account, bool allowed) external onlyAdmin {
        require(account != address(0) && account != admin && account != pendingAdmin, "invalid executor");
        executors[account] = allowed;
        emit ExecutorSet(account, allowed);
    }

    /// @notice Approve or revoke a router/vault/pool that swap steps may call.
    function setRouter(address router, bool allowed) external onlyAdmin {
        require(router != address(0), "zero router");
        approvedRouters[router] = allowed;
        emit RouterSet(router, allowed);
    }

    /// @notice Start a two-step admin handover. Executors cannot become admin.
    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0) && !executors[newAdmin], "invalid admin");
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    /// @notice Complete the admin handover from the pending admin.
    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "unauthorized");
        require(!executors[msg.sender], "invalid admin");
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    /// @notice Emergency pause - an executor or the admin can stop trading immediately
    function pause() external onlyExecutorOrAdmin {
        _pause();
        emit EmergencyPause(msg.sender);
    }

    /// @notice Resuming trading is a governance decision
    function unpause() external onlyAdmin {
        _unpause();
    }

    // ─── Core Flash Loan Functions ──────────────────────────────────────────────

    /// @notice Initiate flash loan arbitrage
    /// @param data Complete arbitrage parameters
    function initiateFlashLoan(ArbitrageData calldata data) external onlyExecutor whenNotPaused {
        require(!loanActive, "loan active");
        _validateArbitrageData(data);
        balanceBeforeLoan = IERC20(data.borrowToken).balanceOf(address(this));
        loanActive = true;
        callbackCompleted = false;
        activeDataHash = keccak256(abi.encode(data));

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
        require(callbackCompleted, "callback missing");
        loanActive = false;
        activeDataHash = bytes32(0);
    }

    /// @notice Execute an arbitrage route with capital already held by this contract.
    /// @dev The starting capital remains in the executor; only realized profit is transferred.
    // Reviewed: the starting balance is read before the swaps and compared after
    // them by design (profit-or-revert). This function is nonReentrant and
    // executor-only, and swaps reach only governance-approved routers; a
    // reentrant transfer could only add tokens, never pass a losing route.
    // slither-disable-next-line reentrancy-balance
    function executeCapitalArbitrage(ArbitrageData calldata data)
        external
        onlyExecutor
        whenNotPaused
        nonReentrant
    {
        require(!loanActive, "loan active");
        _validateArbitrageData(data);

        IERC20 token = IERC20(data.borrowToken);
        uint256 startingBalance = token.balanceOf(address(this));
        require(startingBalance >= data.borrowAmount, "insufficient capital");

        uint256 currentAmount = data.borrowAmount;
        for (uint256 i = 0; i < data.steps.length; i++) {
            currentAmount = _executeSwap(data.steps[i], currentAmount);
        }

        uint256 finalBalance = token.balanceOf(address(this));
        require(finalBalance >= startingBalance + data.minProfit, "profit<minProfit");

        uint256 profit = finalBalance - startingBalance;
        if (profit > 0) {
            token.safeTransfer(profitRecipient, profit);
            emit ProfitWithdrawn(data.borrowToken, profitRecipient, profit);
        }
        emit ArbitrageExecuted(data.borrowAmount, int256(profit), data.route);
    }

    /// @inheritdoc IFlashLoanReceiver
    // Reviewed: callbackCompleted is written after the swaps, but this function is
    // nonReentrant, callable only by the lending pool for this contract's own
    // active loan, and initiateFlashLoan refuses to start while loanActive.
    // slither-disable-next-line reentrancy-eth
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external override nonReentrant whenNotPaused returns (bool) {
        require(msg.sender == address(lendingPool), "only pool");
        require(initiator == address(this), "bad initiator");
        require(loanActive && !callbackCompleted, "unexpected callback");
        require(assets.length == 1 && amounts.length == 1 && premiums.length == 1, "single asset only");
        require(keccak256(params) == activeDataHash, "callback data mismatch");

        ArbitrageData memory data = abi.decode(params, (ArbitrageData));
        require(assets[0] == data.borrowToken && amounts[0] == data.borrowAmount, "callback asset mismatch");

        // Execute arbitrage
        int256 pnl = _executeArbitrage(amounts[0], premiums[0], data);

        // Settle and repay
        _settleAndRepay(assets[0], amounts[0], premiums[0], pnl, data.route);
        callbackCompleted = true;

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

        // Arbitrage is profit-or-revert: the final balance must cover principal +
        // premium + minProfit, otherwise the whole transaction reverts. This makes
        // a net loss impossible (the contract holds no buffer to absorb one).
        uint256 finalBalance = IERC20(data.borrowToken).balanceOf(address(this));
        uint256 required = borrowedAmount + premium;
        require(finalBalance >= balanceBeforeLoan + required + data.minProfit, "profit<minProfit");

        return int256(finalBalance - balanceBeforeLoan - required);
    }

    // Reviewed: the output is deliberately measured as a balance delta around the
    // external swap so a router cannot misreport it. Every caller is
    // nonReentrant or loan-guarded, and the final profit check is on balances.
    // slither-disable-next-line reentrancy-balance
    function _executeSwap(SwapStep memory step, uint256 amountIn) internal returns (uint256 amountOut) {
        uint256 outputBefore = IERC20(step.tokenOut).balanceOf(address(this));
        // Approve router to spend tokens
        IERC20(step.tokenIn).safeApprove(step.router, 0);
        IERC20(step.tokenIn).safeApprove(step.router, amountIn);

        if (step.dexType == DexType.UNISWAP_V2 || step.dexType == DexType.SUSHISWAP) {
            amountOut = _swapV2(step, amountIn);
        } else if (step.dexType == DexType.UNISWAP_V3 || step.dexType == DexType.PANCAKE_V3) {
            amountOut = _swapV3(step, amountIn);
        } else if (step.dexType == DexType.BALANCER) {
            amountOut = _swapBalancer(step, amountIn);
        } else if (step.dexType == DexType.CURVE) {
            amountOut = _swapCurve(step, amountIn);
        } else {
            revert("unsupported dex");
        }
        amountOut = IERC20(step.tokenOut).balanceOf(address(this)) - outputBefore;
        require(amountOut >= step.minAmountOut, "swap output below minimum");
        IERC20(step.tokenIn).safeApprove(step.router, 0);

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
        string memory route
    ) private {
        uint256 debt = principal + fee;
        IERC20 token = IERC20(asset);
        uint256 balance = token.balanceOf(address(this));

        require(balance >= debt, "insufficient balance");

        // Transfer profit to recipient
        if (pnl > 0) {
            uint256 profit = uint256(pnl);
            token.safeTransfer(profitRecipient, profit);
            emit ProfitWithdrawn(asset, profitRecipient, profit);
        }

        // Approve Aave to pull repayment
        token.safeIncreaseAllowance(address(lendingPool), debt);

        emit ArbitrageExecuted(principal, pnl, route);
    }

    // ─── Validation ─────────────────────────────────────────────────────────────

    function _validateArbitrageData(ArbitrageData calldata data) internal view {
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
        require(data.borrowToken != address(0), "zero borrow token");
        for (uint256 i = 0; i < data.steps.length; i++) {
            SwapStep calldata step = data.steps[i];
            require(approvedRouters[step.router], "router not approved");
            require(step.tokenIn != address(0) && step.tokenOut != address(0) && step.tokenIn != step.tokenOut, "invalid swap tokens");
            require(step.minAmountOut > 0, "zero minimum output");
            if (step.dexType == DexType.UNISWAP_V3 || step.dexType == DexType.PANCAKE_V3) require(step.v3Fee > 0, "missing v3 fee");
            if (step.dexType == DexType.BALANCER) require(step.balancerPoolId != bytes32(0), "missing pool id");
            if (step.dexType == DexType.CURVE) require(step.curveIndexIn >= 0 && step.curveIndexOut >= 0 && step.curveIndexIn != step.curveIndexOut, "invalid curve indices");
            if (step.v2Path.length > 0) {
                require(step.v2Path.length >= 2 && step.v2Path[0] == step.tokenIn && step.v2Path[step.v2Path.length - 1] == step.tokenOut, "v2 path mismatch");
            }
        }
    }

    // ─── Utility Functions ──────────────────────────────────────────────────────

    /// @notice Return held tokens to the profit recipient (governance only)
    function rescueToken(address tokenAddr, uint256 amount) external onlyAdmin {
        IERC20(tokenAddr).safeTransfer(profitRecipient, amount);
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
