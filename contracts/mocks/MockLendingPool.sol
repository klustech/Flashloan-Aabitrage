// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IFlashLoanReceiver} from "../interfaces/IFlashLoanReceiver.sol";

/// @title MockLendingPool
/// @notice Minimal lending pool stub that simulates an Aave flash-loan for testing.
contract MockLendingPool {
    uint16 public premiumBps;

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
        require(assets.length == 1, "only single asset");
        require(amounts.length == 1, "amounts mismatch");

        address asset = assets[0];
        uint256 amount = amounts[0];
        IERC20 token = IERC20(asset);

        uint256 premium = (amount * premiumBps) / 10000;

        require(token.transfer(receiverAddress, amount), "flash send failed");

        address[] memory singleAsset = new address[](1);
        uint256[] memory singleAmount = new uint256[](1);
        uint256[] memory singlePremium = new uint256[](1);

        singleAsset[0] = asset;
        singleAmount[0] = amount;
        singlePremium[0] = premium;

        bool success = IFlashLoanReceiver(receiverAddress).executeOperation(
            singleAsset,
            singleAmount,
            singlePremium,
            address(this),
            params
        );
        require(success, "executeOperation failed");

        require(
            token.transferFrom(receiverAddress, address(this), amount + premium),
            "repay failed"
        );
    }
}
