// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @title USDTLikeToken
/// @notice ERC20-like token that mimics the allowance restrictions of USDT
///         requiring an allowance to be zeroed out before it can be set again.
contract USDTLikeToken {
    string public constant name = "USDT Like";
    string public constant symbol = "USDTL";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    error AllowanceNeedsReset();
    error InsufficientBalance();
    error AllowanceTooLow();

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }

    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool) {
        uint256 currentAllowance = _allowances[sender][msg.sender];
        if (currentAllowance < amount) revert AllowanceTooLow();
        unchecked {
            _allowances[sender][msg.sender] = currentAllowance - amount;
        }
        _transfer(sender, recipient, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (_allowances[msg.sender][spender] != 0 && amount != 0) revert AllowanceNeedsReset();
        _allowances[msg.sender][spender] = amount;
        return true;
    }

    function mint(address account, uint256 amount) external {
        _balances[account] += amount;
        totalSupply += amount;
    }

    function _transfer(address sender, address recipient, uint256 amount) internal {
        uint256 senderBalance = _balances[sender];
        if (senderBalance < amount) revert InsufficientBalance();
        unchecked {
            _balances[sender] = senderBalance - amount;
            _balances[recipient] += amount;
        }
    }
}
