// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @dev Reproduces the UniswapV2Pair storage layout (reserves packed in slot 8)
///      so MEV-Share log-derived state writes can be exercised on a real EVM.
contract MockV2PairLayout {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bytes32 public DOMAIN_SEPARATOR;
    mapping(address => uint256) public nonces;
    address public factory;
    address public token0;
    address public token1;
    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    constructor(address _token0, address _token1, uint112 _reserve0, uint112 _reserve1) {
        token0 = _token0;
        token1 = _token1;
        reserve0 = _reserve0;
        reserve1 = _reserve1;
        blockTimestampLast = uint32(block.timestamp);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }
}
