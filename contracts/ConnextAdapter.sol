// contracts/ConnextAdapter.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IConnext, IXReceiver } from "./interfaces/IConnext.sol";
import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ConnextAdapter
/// @notice Forwards arbitrage profit cross-chain via Connext and receives it on
/// the destination chain. xReceive is authenticated against a configured trusted
/// origin (sender + domain) to prevent anyone from draining the adapter through
/// a crafted permissionless xcall.
contract ConnextAdapter is IXReceiver {
    using SafeERC20 for IERC20;

    IConnext public immutable connext;
    uint32 public immutable destinationDomain;
    address public immutable destinationContract;
    address public owner;
    address public pendingOwner;

    // Trusted inbound origin for xReceive (the adapter on the source chain).
    // Both must be set before xReceive will accept any transfer (fail-closed).
    address public trustedOriginSender;
    uint32 public trustedOriginDomain;

    // Default cross-chain slippage tolerance (BPS) applied to forwarded profit.
    uint256 public constant DEFAULT_SLIPPAGE_BPS = 300; // 3%

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TrustedOriginUpdated(address indexed originSender, uint32 originDomain);
    event ArbitrageForwarded(address indexed token, uint256 amount, address indexed recipient, bytes32 transferId);
    event CrossChainReceived(address indexed asset, uint256 amount, address indexed recipient);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "ConnextAdapter: not owner");
        _;
    }

    constructor(
        address _connext,
        uint32 _destinationDomain,
        address _destinationContract
    ) {
        require(_connext != address(0), "ConnextAdapter: zero connext");
        connext = IConnext(_connext);
        destinationDomain = _destinationDomain;
        destinationContract = _destinationContract;
        owner = msg.sender;
    }

    /// @notice Start a two-step ownership handover; `newOwner` must call acceptOwnership.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ConnextAdapter: zero address");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Complete the ownership handover from the pending owner.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "ConnextAdapter: not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Configure the trusted inbound origin used to authenticate xReceive.
    /// @param _originSender Address of the adapter on the source chain.
    /// @param _originDomain Connext domain id of the source chain.
    function setTrustedOrigin(address _originSender, uint32 _originDomain) external onlyOwner {
        require(_originSender != address(0), "ConnextAdapter: zero origin");
        trustedOriginSender = _originSender;
        trustedOriginDomain = _originDomain;
        emit TrustedOriginUpdated(_originSender, _originDomain);
    }

    /// @notice Pull `amount` of `token` from the owner and forward it to the
    /// configured destination chain. `msg.value` must equal `relayerFee` exactly
    /// so no native currency is left stranded in the adapter.
    function forwardArbitrage(
        address token,
        uint256 amount,
        uint256 relayerFee
    ) external payable onlyOwner returns (bytes32 transferId) {
        require(destinationContract != address(0), "ConnextAdapter: no destination");
        require(amount > 0, "ConnextAdapter: zero amount");
        require(msg.value == relayerFee, "ConnextAdapter: fee mismatch");

        IERC20 tokenContract = IERC20(token);
        tokenContract.safeTransferFrom(msg.sender, address(this), amount);

        tokenContract.safeApprove(address(connext), 0);
        tokenContract.safeApprove(address(connext), amount);

        // Recipient on the destination chain is encoded in the payload.
        bytes memory callData = abi.encode(msg.sender);

        transferId = connext.xcall{ value: relayerFee }(
            destinationDomain,
            destinationContract,
            token,
            msg.sender,
            amount,
            DEFAULT_SLIPPAGE_BPS,
            callData
        );

        emit ArbitrageForwarded(token, amount, msg.sender, transferId);
    }

    /// @notice Recover ERC-20 tokens left in the adapter, e.g. a destination-side
    /// transfer that landed here without executing xReceive.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "ConnextAdapter: zero recipient");
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    /// @notice Recover native currency held by the adapter.
    function rescueNative(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "ConnextAdapter: zero recipient");
        (bool ok, ) = to.call{ value: amount }("");
        require(ok, "ConnextAdapter: native transfer failed");
        emit Rescued(address(0), to, amount);
    }

    /// @inheritdoc IXReceiver
    function xReceive(
        bytes32,                // _transferId (unused)
        uint256 _amount,
        address _asset,
        address _originSender,
        uint32 _origin,
        bytes memory _payload
    ) external override returns (bytes memory) {
        require(msg.sender == address(connext), "ConnextAdapter: only connext");
        require(trustedOriginSender != address(0), "ConnextAdapter: origin not set");
        require(_originSender == trustedOriginSender, "ConnextAdapter: bad origin sender");
        require(_origin == trustedOriginDomain, "ConnextAdapter: bad origin domain");

        address recipient = abi.decode(_payload, (address));
        require(recipient != address(0), "ConnextAdapter: zero recipient");

        // Transfer the amount actually received (not a value trusted from the payload).
        IERC20(_asset).safeTransfer(recipient, _amount);
        emit CrossChainReceived(_asset, _amount, recipient);
        return "";
    }
}
