// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test double for a treasury that refuses ETH.
contract RejectingReceiver {
    receive() external payable {
        revert("no thanks");
    }
}
