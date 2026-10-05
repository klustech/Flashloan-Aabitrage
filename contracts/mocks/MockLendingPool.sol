// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IFlashLoanReceiver} from "../interfaces/IFlashLoanReceiver.sol";

/// @title MockLendingPool
/// @notice Minimal lending pool stub that simulates an Aave flash-loan for testing.
contract MockLendingPool {
    uint16 public premiumBps;
    event FlashLoan(address indexed target, address indexed initiator, address indexed asset,
        uint256 amount, uint256 premium, uint16 referralCode);

    constructor(uint16 _premiumBps) {
        premiumBps = _premiumBps;
    }

    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata,
        address,
        bytes calldata params,
        uint16
    ) external {
        require(assets.length == 1 && amounts.length == 1, "single asset only");
        // Delegate to a small-signature helper to stay within stack limits.
        _runFlash(receiverAddress, assets[0], amounts[0], params);
    }

    function _runFlash(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params
    ) internal {
        uint256 premium = (amount * premiumBps) / 10000;
        require(IERC20(asset).transfer(receiver, amount), "flash send failed");

        address[] memory a = new address[](1);
        uint256[] memory amt = new uint256[](1);
        uint256[] memory prem = new uint256[](1);
        a[0] = asset;
        amt[0] = amount;
        prem[0] = premium;

        require(
            IFlashLoanReceiver(receiver).executeOperation(a, amt, prem, receiver, params),
            "executeOperation failed"
        );
        require(
            IERC20(asset).transferFrom(receiver, address(this), amount + premium),
            "repay failed"
        );
        emit FlashLoan(receiver, receiver, asset, amount, premium, 0);
    }
}
