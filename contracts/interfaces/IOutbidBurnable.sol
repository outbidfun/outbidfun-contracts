// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice OUTBID as the buyback sees it: an ERC20 that can burn its own balance.
interface IOutbidBurnable is IERC20 {
    function burn(uint256 amount) external;
}
