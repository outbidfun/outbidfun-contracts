// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Where the buyback vault buys $OUTBID. The vault knows what it spends and what it
///         must receive; the venue knows the market. Keeping them apart lets the market change
///         (a curve that graduates into a pool, a route that moves) without touching the vault
///         that holds the revenue.
interface IBuybackVenue {
    /// @notice Buy `token` with up to `amountIn` of `assetIn` (address zero is ether, sent as
    ///         the call's value; a token is pulled from the caller), deliver what it bought to
    ///         `recipient`, and return anything it did not spend to the caller.
    /// @return bought What the venue believes it delivered. The vault trusts only its own
    ///         balance, and checks it against `minOut` itself.
    function buy(address assetIn, uint256 amountIn, address token, uint256 minOut, address recipient)
        external
        payable
        returns (uint256 bought);
}
