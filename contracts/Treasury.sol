// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title outbidfun.lol Treasury
/// @notice Receives protocol revenue (bids, protocol fees) and keeps
///         per-source accounting so the two economies stay separable.
contract Treasury is Ownable {
    using SafeERC20 for IERC20;

    /// @notice Cumulative ETH received from each sender (e.g. the OutbidMarket).
    mapping(address source => uint256 total) public receivedFrom;
    /// @notice Cumulative ETH received from all sources.
    uint256 public totalReceived;
    /// @notice Cumulative ETH withdrawn by the owner.
    uint256 public totalWithdrawn;

    event Received(address indexed source, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error TransferFailed();

    constructor(address initialOwner) Ownable(initialOwner) {}

    receive() external payable {
        receivedFrom[msg.sender] += msg.value;
        totalReceived += msg.value;
        emit Received(msg.sender, msg.value);
    }

    /// @notice Move ETH out of the treasury. Owner only.
    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        totalWithdrawn += amount;
        emit Withdrawn(to, amount);
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Move tokens out of the treasury, such as the coin side of pool fees. Owner only.
    function withdrawToken(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit TokenWithdrawn(address(token), to, amount);
        token.safeTransfer(to, amount);
    }
}
