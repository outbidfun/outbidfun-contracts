// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title The outbid market's address
/// @notice OpenZeppelin's ERC-1967 proxy, unchanged, under a name of its own: the one address the
///         board, its bids and everything that reads them (the site, the subgraph, DefiLlama) use,
///         whichever `OutbidMarket` implementation is behind it. The implementation is UUPS:
///         upgrading is its own `upgradeToAndCall`, open to the market's owner alone.
contract OutbidMarketProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data) ERC1967Proxy(implementation, data) {}
}
