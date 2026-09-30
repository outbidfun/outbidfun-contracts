// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ITokenRegistry} from "./interfaces/ITokenRegistry.sol";
import {IPonsLaunchFactory} from "./interfaces/IPonsLaunchFactory.sol";
import {IPonsV2LaunchFactory} from "./interfaces/IPonsV2.sol";

/// @title The coins PONS launched, as one registry
/// @notice Answers `isMemeCoinLegit` for every coin one of PONS's launch factories launched, so
///         the outbid market can take bids on them as ad spots (`OutbidMarket.externalRegistry`).
///         A coin is listed when a factory here says it launched it — asked on chain, at the
///         moment of the bid, never taken from a list someone wrote down.
///
///         PONS has more than one factory, of two kinds: `PonsLaunchFactory`, whose coins go
///         straight into Uniswap V3 pools and which launched almost all of them, and the V2
///         factory, whose coins start on a bonding curve (`IPonsV2`). Each answers
///         `getLaunchedToken` with a struct of its own; the kind says which to read. The owner
///         adds a factory PONS deploys later, and can take one off.
contract PonsTokenRegistry is ITokenRegistry, Ownable {
    enum Kind {
        Launch,
        V2
    }

    struct Factory {
        address factory;
        Kind kind;
    }

    /// @notice Most factories asked per bid: each is one call, and a bid pays for them.
    uint256 public constant MAX_FACTORIES = 8;

    Factory[] private _factories;

    event FactoryAdded(address indexed factory, Kind kind);
    event FactoryRemoved(address indexed factory);

    error ZeroAddress();
    error TooManyFactories();
    error AlreadyListed(address factory);
    error NotListed(address factory);

    constructor(address initialOwner, Factory[] memory factories_) Ownable(initialOwner) {
        for (uint256 i = 0; i < factories_.length; i++) {
            _add(factories_[i].factory, factories_[i].kind);
        }
    }

    /// @notice Every factory asked, in order.
    function factories() external view returns (Factory[] memory) {
        return _factories;
    }

    /// @inheritdoc ITokenRegistry
    /// @dev A factory that reverts, or answers in a shape its kind does not have, answers no; it
    ///      never fails the bid that asked.
    function isMemeCoinLegit(address memecoin) external view override returns (bool) {
        if (memecoin == address(0)) return false;
        uint256 count = _factories.length;
        for (uint256 i = 0; i < count; i++) {
            Factory storage entry = _factories[i];
            if (_launched(entry.factory, entry.kind, memecoin)) return true;
        }
        return false;
    }

    function addFactory(address factory, Kind kind) external onlyOwner {
        _add(factory, kind);
    }

    function removeFactory(address factory) external onlyOwner {
        uint256 count = _factories.length;
        for (uint256 i = 0; i < count; i++) {
            if (_factories[i].factory == factory) {
                _factories[i] = _factories[count - 1];
                _factories.pop();
                emit FactoryRemoved(factory);
                return;
            }
        }
        revert NotListed(factory);
    }

    function _add(address factory, Kind kind) private {
        if (factory == address(0)) revert ZeroAddress();
        if (_factories.length >= MAX_FACTORIES) revert TooManyFactories();
        for (uint256 i = 0; i < _factories.length; i++) {
            if (_factories[i].factory == factory) revert AlreadyListed(factory);
        }
        _factories.push(Factory({factory: factory, kind: kind}));
        emit FactoryAdded(factory, kind);
    }

    /// @dev Whether `factory` launched `token`. The call is made low level and its answer
    ///      measured before it is decoded, because a `try` cannot catch a reply of the wrong
    ///      shape: a struct is all fixed-size fields, so its encoding is exactly one word each.
    function _launched(address factory, Kind kind, address token) private view returns (bool) {
        bytes memory call = abi.encodeWithSelector(IPonsLaunchFactory.getLaunchedToken.selector, token);
        (bool ok, bytes memory reply) = factory.staticcall(call);
        if (!ok) return false;
        if (kind == Kind.Launch) {
            if (reply.length != 13 * 32) return false;
            IPonsLaunchFactory.LaunchedToken memory launch = abi.decode(reply, (IPonsLaunchFactory.LaunchedToken));
            return launch.exists && launch.token == token;
        }
        if (reply.length != 15 * 32) return false;
        IPonsV2LaunchFactory.LaunchedToken memory launched = abi.decode(reply, (IPonsV2LaunchFactory.LaunchedToken));
        return launched.exists && launched.token == token;
    }
}
