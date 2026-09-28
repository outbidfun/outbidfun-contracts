// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPonsV2LaunchFactory} from "../interfaces/IPonsV2.sol";

/// @dev PONS's factory as the buyback venue reads it: a launch's record, the PoolManager and the
///      hook. Tests set the record, and move its phase to walk a launch through graduation.
contract MockPonsFactory is IPonsV2LaunchFactory {
    address public immutable override poolManager;
    address public immutable override memeHook;
    mapping(address token => LaunchedToken) private _launches;

    constructor(address poolManager_, address memeHook_) {
        poolManager = poolManager_;
        memeHook = memeHook_;
    }

    function setLaunch(address token, address curve, address pairToken, uint24 poolFee, int24 tickSpacing) external {
        LaunchedToken storage launch = _launches[token];
        launch.token = token;
        launch.curve = curve;
        launch.pairToken = pairToken;
        launch.graduationThreshold = 4.2 ether;
        launch.poolFee = poolFee;
        launch.tickSpacing = tickSpacing;
        launch.exists = true;
    }

    function setPhase(address token, uint8 phase) external {
        _launches[token].phase = phase;
    }

    function getLaunchedToken(address token) external view override returns (LaunchedToken memory) {
        return _launches[token];
    }
}
