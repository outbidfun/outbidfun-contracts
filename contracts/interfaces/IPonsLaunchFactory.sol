// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The PONS launch factory as the external-coin registry reads it (ponsfamily.com,
///         Robinhood Chain), the factory most PONS coins come from: `PonsLaunchFactory`, verified
///         at 0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB, whose launches trade in Uniswap V3 pools.
///         The factories at 0x0c37a24F5D23A486FA692d1500881d698B1F77a4 and (behind a proxy)
///         0xF4fC0CD27fC8EcF17E55eE4c3f7201897dF3eb75 answer the same call with the same struct.
/// @dev    `LaunchedToken` is the factory's struct field for field, checked against the verified
///         source on 30 September 2026. A token the factory did not launch comes back zeroed,
///         `exists` false.
interface IPonsLaunchFactory {
    struct LaunchedToken {
        address token;
        address deployer;
        address pairedToken;
        address positionManager;
        uint256 positionId;
        uint256 dexId;
        uint256 launchConfigId;
        uint256 restrictionsEndBlock;
        uint256 supply;
        bool isToken0;
        uint24 poolFee;
        bool exists;
        uint256 initialBuyAmount;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
}
