// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITokenRegistry} from "../interfaces/ITokenRegistry.sol";

/// @dev Test double for the CoinFactory registry check.
contract MockTokenRegistry is ITokenRegistry {
    mapping(address => bool) public legit;

    function setLegit(address token, bool value) external {
        legit[token] = value;
    }

    function isMemeCoinLegit(address token) external view returns (bool) {
        return legit[token];
    }
}
