// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IXReceiver } from "../interfaces/IConnext.sol";

/// @dev Test double for the Connext Amarok entrypoint: pulls the bridged asset,
/// records the last call and can deliver an xReceive callback.
contract MockConnext {
    bytes32 public constant TRANSFER_ID = keccak256("mock-transfer");
    uint32 public lastDestination;
    address public lastTo;
    uint256 public lastAmount;
    uint256 public lastFee;

    function xcall(
        uint32 _destination,
        address _to,
        address _asset,
        address,
        uint256 _amount,
        uint256,
        bytes calldata
    ) external payable returns (bytes32) {
        IERC20(_asset).transferFrom(msg.sender, address(this), _amount);
        lastDestination = _destination;
        lastTo = _to;
        lastAmount = _amount;
        lastFee = msg.value;
        return TRANSFER_ID;
    }

    function deliver(
        address receiver,
        address asset,
        uint256 amount,
        address originSender,
        uint32 origin,
        bytes calldata payload
    ) external {
        IERC20(asset).transfer(receiver, amount);
        IXReceiver(receiver).xReceive(TRANSFER_ID, amount, asset, originSender, origin, payload);
    }
}
