// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The PONS V2 launchpad as the buyback venue reads it (ponsfamily.com, Robinhood Chain;
///         source: github.com/ponsdotdev/pons-labs, contractsV2). A launch trades on its bonding
///         curve until the curve fills, then in a full-range Uniswap V4 pool behind PONS's hook.
/// @dev    `LaunchedToken` is the factory's struct field for field — checked against the live
///         factory at 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e — with the phase enum as its
///         uint8. `pairToken` zero means a native-ether launch.
interface IPonsV2LaunchFactory {
    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase;
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    function poolManager() external view returns (address);
    function memeHook() external view returns (address);
}

interface IPonsV2BondingCurve {
    function graduated() external view returns (bool);
    function sellableTokens() external view returns (uint256);
    /// @dev Payable for a native launch (`quoteIn` must equal the value), pulled by
    ///      `transferFrom` otherwise. A buy past the curve's allocation is filled to it and the
    ///      rest refunded to the caller; `minTokensOut` then bounds the price, not the quantity.
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut);
}
