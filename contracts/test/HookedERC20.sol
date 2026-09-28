// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ITokenReceivedHook {
    function onTokenReceived(address from, uint256 amount) external;
}

/// @dev Test double for a reserve token that calls its recipient on every transfer, the way an
///      ERC777 or a hooked stablecoin would. It is how a contract seller gets a turn while the
///      curve is paying it, which is the shape audit F-08 was about; with a plain token that
///      moment never comes.
contract HookedERC20 is ERC20 {
    constructor(string memory name, string memory symbol, uint256 amount) ERC20(name, symbol) {
        _mint(_msgSender(), amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to.code.length > 0) {
            // Swallowed: a recipient that does not want to know is not a failed transfer.
            try ITokenReceivedHook(to).onTokenReceived(from, value) {} catch {}
        }
    }
}
