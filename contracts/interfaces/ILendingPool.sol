// contracts/interfaces/ILendingPool.sol
// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

interface ILendingPool {
    /**
     * @dev Allows smart contracts to access the liquidity of the pool within one transaction,
     * as long as the amount taken plus a fee is returned.
     */
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata modes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;
}
