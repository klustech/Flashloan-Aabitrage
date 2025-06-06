// contracts/ArbitrageTimelock.sol
// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/governance/TimelockController.sol";

contract ArbitrageTimelock is TimelockController {
    /**
     * @param minDelay   Minimum delay (in seconds) before an operation can be executed
     * @param proposers  Addresses granted PROPOSER_ROLE
     * @param executors  Addresses granted EXECUTOR_ROLE
     * @param admin      Address granted TIMELOCK_ADMIN_ROLE
     */
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    )
        TimelockController(
            minDelay,      // delay
            proposers,     // proposers
            executors,     // executors
            admin          // explicit admin
        )
    {}
}
