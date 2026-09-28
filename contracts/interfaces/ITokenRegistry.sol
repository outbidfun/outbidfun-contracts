// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The subset of CoinFactory the OutbidMarket uses to accept bids only
///         for coins launched on the platform.
interface ITokenRegistry {
    function isMemeCoinLegit(address memecoin) external view returns (bool);
}
