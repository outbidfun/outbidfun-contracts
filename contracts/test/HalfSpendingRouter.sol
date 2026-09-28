// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice A router that spends half of what it is given, as a real one does when its pool runs
///         out before the amount, and pays out the minimum from a balance funded beforehand.
contract HalfSpendingRouter {
    using SafeERC20 for IERC20;

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256) {
        IERC20(address(bytes20(params.path[:20]))).safeTransferFrom(msg.sender, address(this), params.amountIn / 2);
        IERC20(address(bytes20(params.path[params.path.length - 20:]))).safeTransfer(
            params.recipient,
            params.amountOutMinimum
        );
        return params.amountOutMinimum;
    }
}
