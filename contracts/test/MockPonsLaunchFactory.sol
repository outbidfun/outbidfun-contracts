// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPonsLaunchFactory} from "../interfaces/IPonsLaunchFactory.sol";

/// @dev PONS's `PonsLaunchFactory` as the external-coin registry reads it: a launch's record, which
///      tests set. A token never set comes back zeroed, as the real factory's does.
contract MockPonsLaunchFactory is IPonsLaunchFactory {
    mapping(address token => LaunchedToken) private _launches;

    function setLaunched(address token, bool launched) external {
        LaunchedToken storage launch = _launches[token];
        launch.token = launched ? token : address(0);
        launch.supply = launched ? 1e27 : 0;
        launch.poolFee = launched ? 10_000 : 0;
        launch.exists = launched;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory) {
        return _launches[token];
    }
}
