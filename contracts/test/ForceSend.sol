// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test double: pushes ETH into a contract without going through any function of it. A
///      contract that self-destructs in the transaction that created it still hands its balance
///      to the target after EIP-6780, which is exactly the path the review used (AUDIT-2 G-04).
contract ForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
