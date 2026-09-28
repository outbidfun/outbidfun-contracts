// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev What the outbid market needs of `SwapExecutor`: its trade, as the swap page routes it,
///      and the call that runs one. The structs match the executor's field for field, so a trade
///      encoded here is the executor's own.
interface ISwapExecutor {
    struct Step {
        address router;
        bytes path;
    }

    struct Leg {
        uint256 amountIn;
        uint256 minOut;
        Step[] steps;
    }

    struct Trade {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address recipient;
        uint256 deadline;
        Leg[] legs;
    }

    function execute(Trade calldata trade) external payable returns (uint256 amountOut);
}
