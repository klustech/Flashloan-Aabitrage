// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Aave V2 Interfaces
interface ILendingPoolAddressesProvider {
    function getLendingPool() external view returns (address);
}
interface ILendingPool {
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata modes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

// Uniswap V2
interface IUniswapV2Router02 {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

// Uniswap V3
interface IUniswapV3Router {
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

// Balancer V2
interface IBalancerVault {
    enum SwapKind { GIVEN_IN, GIVEN_OUT }
    struct SingleSwap {
        bytes32 poolId;
        SwapKind kind;
        address tokenIn;
        address tokenOut;
        uint256 amount;
        bytes userData;
    }
    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address recipient;
        bool toInternalBalance;
    }
    function swap(
        SingleSwap calldata singleSwap,
        FundManagement calldata funds,
        uint256 limit,
        uint256 deadline
    ) external returns (uint256 amountCalculated);
}

// Curve (typical pool interface)
interface ICurvePool {
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy) external;
}

contract FlashloanExecutor {
    using SafeERC20 for IERC20;

    ILendingPoolAddressesProvider public immutable ADDRESSES_PROVIDER;
    address public owner;

    enum DexType { UNIV2, UNIV3, BALANCER, CURVE }

    struct SwapStep {
        DexType dex;
        address routerOrVault;      // Router for Uniswap, Vault for Balancer, Pool for Curve
        address tokenIn;
        address tokenOut;
        uint24 fee;                 // only for Uniswap V3
        bytes32 balancerPoolId;     // only for Balancer
        int128 curveIndexIn;        // only for Curve
        int128 curveIndexOut;       // only for Curve
        uint256 amountIn;           // amount to swap
        uint256 minAmountOut;       // slippage-protected minimum
        address[] uniPath;          // for Uniswap V2: token path
    }

    constructor(address _provider) {
        ADDRESSES_PROVIDER = ILendingPoolAddressesProvider(_provider);
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // Entry point for flashloan via Aave V2
    function initiateFlashLoan(
        address[] calldata assets,
        uint256[] calldata amounts,
        bytes calldata params
    ) external onlyOwner {
        address pool = ADDRESSES_PROVIDER.getLendingPool();
        uint256[] memory modes = new uint256[](assets.length);
        // 0 = no debt (flash), 1 = stable, 2 = variable
        for (uint256 i = 0; i < assets.length; i++) {
            modes[i] = 0;
        }
        ILendingPool(pool).flashLoan(
            address(this),
            assets,
            amounts,
            modes,
            address(this),
            params,
            0
        );
    }

    // Aave V2 callback
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        // Decode parameters: (SwapStep[] steps)
        SwapStep[] memory steps = abi.decode(params, (SwapStep[]));

        // Approve all tokens for DEXes/Vaults
        for (uint256 i = 0; i < steps.length; i++) {
            IERC20 tokenIn = IERC20(steps[i].tokenIn);
            address spender = _approveSpender(steps[i]);
            tokenIn.safeApprove(spender, 0);
            tokenIn.safeApprove(spender, steps[i].amountIn);
        }

        // Execute each hop in sequence
        for (uint256 i = 0; i < steps.length; i++) {
            SwapStep memory s = steps[i];
            if (s.dex == DexType.UNIV2) {
                IUniswapV2Router02 router = IUniswapV2Router02(s.routerOrVault);
                router.swapExactTokensForTokens(
                    s.amountIn,
                    s.minAmountOut,
                    s.uniPath,
                    address(this),
                    block.timestamp
                );
            } else if (s.dex == DexType.UNIV3) {
                IUniswapV3Router router = IUniswapV3Router(s.routerOrVault);
                IUniswapV3Router.ExactInputSingleParams memory p = IUniswapV3Router.ExactInputSingleParams({
                    tokenIn: s.tokenIn,
                    tokenOut: s.tokenOut,
                    fee: s.fee,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: s.amountIn,
                    amountOutMinimum: s.minAmountOut,
                    sqrtPriceLimitX96: 0
                });
                router.exactInputSingle(p);
            } else if (s.dex == DexType.BALANCER) {
                IBalancerVault vault = IBalancerVault(s.routerOrVault);
                IBalancerVault.SingleSwap memory singleSwap = IBalancerVault.SingleSwap({
                    poolId: s.balancerPoolId,
                    kind: IBalancerVault.SwapKind.GIVEN_IN,
                    tokenIn: s.tokenIn,
                    tokenOut: s.tokenOut,
                    amount: s.amountIn,
                    userData: ""
                });
                IBalancerVault.FundManagement memory funds = IBalancerVault.FundManagement({
                    sender: address(this),
                    fromInternalBalance: false,
                    recipient: address(this),
                    toInternalBalance: false
                });
                vault.swap(singleSwap, funds, s.minAmountOut, block.timestamp);
            } else if (s.dex == DexType.CURVE) {
                ICurvePool pool = ICurvePool(s.routerOrVault);
                pool.exchange(
                    s.curveIndexIn,
                    s.curveIndexOut,
                    s.amountIn,
                    s.minAmountOut
                );
            }
        }

        // Compute amounts owed to Aave
        for (uint256 i = 0; i < assets.length; i++) {
            uint256 amountOwing = amounts[i] + premiums[i];
            IERC20 asset = IERC20(assets[i]);
            asset.safeApprove(msg.sender, 0);
            asset.safeApprove(msg.sender, amountOwing);
        }

        return true;
    }

    function _approveSpender(SwapStep memory s) internal pure returns (address) {
        if (s.dex == DexType.UNIV2) {
            return s.routerOrVault;
        } else if (s.dex == DexType.UNIV3) {
            return s.routerOrVault;
        } else if (s.dex == DexType.BALANCER) {
            return s.routerOrVault;
        } else if (s.dex == DexType.CURVE) {
            return s.routerOrVault;
        }
        return address(0);
    }

    function withdrawERC20(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner, amount);
    }
}
