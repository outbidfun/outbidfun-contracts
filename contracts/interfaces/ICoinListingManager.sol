// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice What the listing manager needs from a coin: the asset it is priced in, and the fee
///         terms its pool's earnings are shared out on.
interface ICoinReserve {
    function reserveToken() external view returns (address);
    function creatorFeeRecipient() external view returns (address);
    function protocolShareBps() external view returns (uint16);
}

/// @notice What a Coin needs from the listing manager to graduate.
interface ICoinListingManager {
    /// @notice Receives the protocol's share of every fee.
    function treasury() external view returns (address);

    /// @notice The Uniswap V3 pool a coin graduated into, or the zero address while it is
    ///         still on the curve. Nobody but the manager can create one, so there is
    ///         nothing to pre-seed.
    function poolOf(address coin) external view returns (address);

    /// @notice How many coin units the coin must mint to this contract so that, together with
    ///         `cap` of its reserve token, they form the graduation position at `price`: the
    ///         reserve token per whole coin, scaled to 1e18 whatever the token's own decimals.
    function tokensForListing(address coin, uint256 cap, uint256 price) external view returns (uint256);

    /// @notice Called by the coin once it has minted `amountToken` here and sent `amountQuote`
    ///         of its reserve token. Opens the pool at `price` and locks the liquidity.
    function listMemeCoin(uint256 amountToken, uint256 amountQuote, uint256 price) external;
}

/// @notice The escrow the creator's fees are credited to.
interface IFeeEscrow {
    function credit(address recipient, address asset, uint256 amount) external;
}
