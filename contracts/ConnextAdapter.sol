// contracts/ConnextAdapter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IConnext } from "@connext/interfaces/core/IConnext.sol";
import { IXReceiver } from "@connext/interfaces/core/IXReceiver.sol";
import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract ConnextAdapter {
    using SafeERC20 for IERC20;

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
        IERC20 tokenContract = IERC20(token);
        require(tokenContract.allowance(msg.sender, address(this)) >= amount, "Approve tokens");
        tokenContract.safeTransferFrom(msg.sender, address(this), amount);

        // Approve Connext to spend
        tokenContract.safeApprove(address(connext), 0);
        tokenContract.safeApprove(address(connext), amount);

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
        IERC20(asset).safeTransfer(user, amt);
        return "";
    }
}
