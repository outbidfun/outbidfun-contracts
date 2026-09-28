// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test double for the shape audit F-09 used: a contract that answers `coinIndex()` with
///      an index the factory never issued.
contract FakeCoin {
    function coinIndex() external pure returns (uint32) {
        return type(uint32).max;
    }
}
