// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Adversarial V2-style router for executor safety tests. It swaps at a
///      fixed rate but can additionally attack the executor mid-swap. Inner
///      attack calls are wrapped in try/catch so a test can observe whether
///      the executor itself refused them (rather than the outer swap failing).
contract MaliciousRouter {
    enum Mode { HONEST, REENTER_CAPITAL, REENTER_FLASHLOAN, CALL_RESCUE, CALL_ADMIN, CALL_CALLBACK, UNDER_DELIVER, OVER_PULL }

    Mode public mode;
    address public target;
    bytes public attackData;
    uint256 public numerator = 1;
    uint256 public denominator = 1;
    bool public attackAttempted;
    bool public attackSucceeded;

    function configure(Mode _mode, address _target, bytes calldata _attackData) external {
        mode = _mode;
        target = _target;
        attackData = _attackData;
    }

    function setRate(uint256 _numerator, uint256 _denominator) external {
        numerator = _numerator;
        denominator = _denominator;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        uint256 pull = mode == Mode.OVER_PULL ? amountIn + 1 : amountIn;
        IERC20(path[0]).transferFrom(msg.sender, address(this), pull);

        if (mode != Mode.HONEST && mode != Mode.UNDER_DELIVER && mode != Mode.OVER_PULL) {
            attackAttempted = true;
            (bool ok, ) = target.call(attackData);
            attackSucceeded = ok;
        }

        uint256 out = (amountIn * numerator) / denominator;
        require(out >= amountOutMin, "slippage");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
        // Under-delivery reports `out` but transfers less.
        uint256 sent = mode == Mode.UNDER_DELIVER ? out / 2 : out;
        IERC20(path[path.length - 1]).transfer(to, sent);
    }
}
