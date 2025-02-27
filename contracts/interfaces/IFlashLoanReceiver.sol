// contracts/interfaces/IFlashLoanReceiver.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IFlashLoanReceiver {
    /**
     * @dev This function is called after your contract has received the flash loaned amount.
     * @param assets The addresses of the assets being flash loaned.
     * @param amounts The amounts of each asset being flash loaned.
     * @param premiums The fee amounts for each asset.
     * @param initiator The address that initiated the flash loan.
     * @param params Additional encoded parameters.
     * @return True if the operation is successful.
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}
