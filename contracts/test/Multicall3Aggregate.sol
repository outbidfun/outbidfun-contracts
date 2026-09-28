// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Multicall3's `aggregate3` and nothing else, with the same ABI and behaviour: each call
///         made in turn, its failure reported rather than raised where `allowFailure` is set. The
///         swap page sends its quotes through the real one, at the same address on every chain it
///         is on, Robinhood Chain's included; a test places this at that address so the page's own
///         code runs unchanged against a Hardhat network.
contract Multicall3Aggregate {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData) {
        returnData = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory data) = calls[i].target.call(calls[i].callData);
            require(success || calls[i].allowFailure, "Multicall3: call failed");
            returnData[i] = Result(success, data);
        }
    }
}
