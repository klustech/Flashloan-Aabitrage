// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Minimal local copy of the Connext Amarok interfaces actually used by
// ConnextAdapter, vendored so the project compiles without the optional
// connext interfaces npm dependency.

interface IConnext {
    function xcall(
        uint32 _destination,
        address _to,
        address _asset,
        address _delegate,
        uint256 _amount,
        uint256 _slippage,
        bytes calldata _callData
    ) external payable returns (bytes32);
}

interface IXReceiver {
    function xReceive(
        bytes32 _transferId,
        uint256 _amount,
        address _asset,
        address _originSender,
        uint32 _origin,
        bytes memory _callData
    ) external returns (bytes memory);
}
