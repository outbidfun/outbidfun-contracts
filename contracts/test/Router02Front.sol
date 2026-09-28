// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPeripheryRouter} from "../SwapExecutor.sol";

/// @notice SwapRouter02's `exactInput` — no deadline in the params — in front of a v3-periphery
///         SwapRouter, so tests can send an executor step the way Uniswap's router on Robinhood
///         Chain is called, against the Hardhat network's own pools.
contract Router02Front {
    using SafeERC20 for IERC20;

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    IPeripheryRouter public immutable router;

    constructor(IPeripheryRouter router_) {
        router = router_;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256) {
        IERC20 tokenIn = IERC20(address(bytes20(params.path[:20])));
        tokenIn.safeTransferFrom(msg.sender, address(this), params.amountIn);
        tokenIn.forceApprove(address(router), params.amountIn);
        return
            router.exactInput(
                IPeripheryRouter.ExactInputParams({
                    path: params.path,
                    recipient: params.recipient,
                    deadline: block.timestamp,
                    amountIn: params.amountIn,
                    amountOutMinimum: params.amountOutMinimum
                })
            );
    }
}
