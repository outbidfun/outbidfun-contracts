// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Test double for a coin on its curve, as the outbid market sees one: priced in
///      `reserveToken`, open (`cap` above zero), and selling `coinsPerUnit` coins for each raw
///      unit of the reserve paid. Lets the board be tested at a scale real launches would make
///      slow.
contract MockBiddableCoin is ERC20 {
    using SafeERC20 for IERC20;

    address public immutable reserveToken;
    uint256 public immutable coinsPerUnit;
    address public listingManager;
    uint96 public cap = type(uint96).max;

    constructor(address reserveToken_, uint256 coinsPerUnit_) ERC20("Mock Coin", "MOCK") {
        reserveToken = reserveToken_;
        coinsPerUnit = coinsPerUnit_;
    }

    function buy(uint256 amountIn, uint256 minAmount) external {
        IERC20(reserveToken).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amount = amountIn * coinsPerUnit;
        require(amount >= minAmount, "Insufficient output token amount");
        _mint(msg.sender, amount);
    }
}
