// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev A plain token with whatever decimals a test asks for, since the assets a coin can be
///      paired with do not all have eighteen: a dollar stablecoin has six.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name, string memory symbol, uint8 decimals_, uint256 amount) ERC20(name, symbol) {
        _decimals = decimals_;
        _mint(_msgSender(), amount);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @dev Tests hand balances out freely; nothing here is worth anything.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
