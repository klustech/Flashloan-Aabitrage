// contracts/ConnextAdapter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IConnext } from "@connext/interfaces/core/IConnext.sol";
import { IXReceiver } from "@connext/interfaces/core/IXReceiver.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ConnextAdapter {
    IConnext public immutable connext;
    uint32 public immutable destinationDomain;
    address public immutable destinationContract;

    constructor(
        address _connext,
        uint32 _destinationDomain,
        address _destinationContract
    ) {
        connext = IConnext(_connext);
        destinationDomain = _destinationDomain;
        destinationContract = _destinationContract;
    }

    function forwardArbitrage(
        address token,
        uint256 amount,
        uint256 relayerFee
    ) external payable {
        // Pull 'amount' from msg.sender into this contract
        require(IERC20(token).allowance(msg.sender, address(this)) >= amount, "Approve tokens");
        IERC20(token).transferFrom(msg.sender, address(this), amount);

        // Approve Connext to spend
        IERC20(token).approve(address(connext), amount);

        // Pack payload: who should receive on the destination chain, and how much
        bytes memory callData = abi.encode(msg.sender, amount);

        // Initiate cross‐chain transfer
        connext.xcall{ value: relayerFee }(
            destinationDomain,
            destinationContract,
            token,
            msg.sender,
            amount,
            0,
            callData
        );
    }

    function xReceive(
        bytes32,       // _transferId (ignored)
        uint256 amount,
        address asset,
        address,       // originSender (ignored)
        uint32,        // originDomain (ignored)
        bytes memory _payload
    ) external returns (bytes memory) {
        require(msg.sender == address(connext), "only connext");
        (address user, uint256 amt) = abi.decode(_payload, (address, uint256));
        IERC20(asset).transfer(user, amt);
        return "";
    }
}
