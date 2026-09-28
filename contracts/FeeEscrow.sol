// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title outbidfun.lol fee escrow
/// @notice Where a creator's share of trading fees waits until they claim it.
///
///         Fees are not pushed to a creator's wallet as they are earned. A creator's address is
///         whatever they gave at launch, and a transfer to it can fail for reasons nothing here
///         controls — a stablecoin that has blacklisted it, a contract that refuses tokens — and
///         a failing transfer inside a trade would stop everyone else trading. So every trade
///         credits a balance here instead, per recipient and per asset, and the recipient
///         withdraws whenever they like. A creator paid in three assets has three balances.
///
///         Crediting is open to anyone, because the caller pays: the tokens are pulled from the
///         caller, and what actually arrived is what is credited.
contract FeeEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice What `recipient` can withdraw of `asset`.
    mapping(address recipient => mapping(address asset => uint256)) public balanceOf;

    event Credited(address indexed recipient, address indexed asset, uint256 amount, address indexed source);
    event Claimed(address indexed recipient, address indexed asset, uint256 amount, address to);

    error ZeroAddress();
    error NothingToClaim();

    /// @notice Pulls `amount` of `asset` from the caller and credits it to `recipient`.
    function credit(address recipient, address asset, uint256 amount) external nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) return;
        IERC20 token = IERC20(asset);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        balanceOf[recipient][asset] += received;
        emit Credited(recipient, asset, received, msg.sender);
    }

    /// @notice Withdraws everything the caller is owed of `asset`.
    function claim(address asset) external returns (uint256) {
        return claimTo(asset, msg.sender);
    }

    /// @notice Withdraws everything the caller is owed of `asset`, to `to`.
    function claimTo(address asset, address to) public nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = balanceOf[msg.sender][asset];
        if (amount == 0) revert NothingToClaim();
        balanceOf[msg.sender][asset] = 0;
        emit Claimed(msg.sender, asset, amount, to);
        IERC20(asset).safeTransfer(to, amount);
    }
}
