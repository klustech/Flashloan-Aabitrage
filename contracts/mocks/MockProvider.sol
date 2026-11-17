// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice A minimal AddressesProvider stub that always returns the same lending pool address.
contract MockProvider {
    address public pool;

    constructor(address _pool) {
        pool = _pool;
    }

    function getLendingPool() external view returns (address) {
        return pool;
    }
}
