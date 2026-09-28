// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITokenRegistry} from "./interfaces/ITokenRegistry.sol";

/// @title Two launchpads, one registry
/// @notice Answers `isMemeCoinLegit` for the coins of two CoinFactories, so that the outbid
///         market, which holds one registry, keeps taking bids on the coins of a factory that a
///         newer one replaced. A coin is legitimate if either factory launched it. Both are set
///         once, at deployment; a third factory is another one of these, with this as one side.
contract TokenRegistryUnion is ITokenRegistry {
    ITokenRegistry public immutable first;
    ITokenRegistry public immutable second;

    error ZeroAddress();

    constructor(ITokenRegistry first_, ITokenRegistry second_) {
        if (address(first_) == address(0) || address(second_) == address(0)) revert ZeroAddress();
        first = first_;
        second = second_;
    }

    /// @inheritdoc ITokenRegistry
    function isMemeCoinLegit(address memecoin) external view override returns (bool) {
        return first.isMemeCoinLegit(memecoin) || second.isMemeCoinLegit(memecoin);
    }
}
