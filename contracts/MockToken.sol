// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract MockToken is ERC20, Ownable {
    constructor(address initialOwner) ERC20("MockToken", "MKT") Ownable(initialOwner) {
        // Mint an initial supply of 1,000,000 MockTokens to the initialOwner
        _mint(initialOwner, 1000000 * 10 ** decimals());
    }

    // Optional: Additional functionalities
}
