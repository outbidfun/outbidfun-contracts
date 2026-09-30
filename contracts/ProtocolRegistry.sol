// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ProtocolRegistry
 * @notice The one address that says which contracts are outbidfun.lol's, so that everything
 *         reading the protocol from outside — DefiLlama's adapters, the subgraph — follows a
 *         redeploy without a change of its own: a new launchpad, market or trade router is
 *         registered here, and every reader finds it.
 *
 *         Contracts are listed by kind — a short name, such as `TradeRouter`, as a bytes32 of its
 *         ASCII, so the kind reads as a word on any explorer — each with the block it was deployed
 *         in, where a reader starts looking for its events. A kind lists every contract of its
 *         kind the protocol has had, the current one last: those a newer one replaced keep their
 *         history, and a reader counting fees or reserves needs them all.
 *
 *         It is append-only on purpose. The owner can add a contract, once, and never remove one
 *         or change what it says: every entry is an event, and what a reader was once told stays
 *         true. It holds no funds and no approvals, and it is not upgradeable, so its address is
 *         permanent.
 *
 *         A deployment block is taken as given, not checked against `block.number`: on an
 *         Arbitrum chain such as Robinhood Chain that is the parent chain's block, far below the
 *         chain's own, which is the one readers look for logs by. `scripts/register-contracts.ts`
 *         checks each against the chain's own head before sending it.
 */
contract ProtocolRegistry is Ownable {
    /// @notice A contract, and the block it was deployed in.
    struct Entry {
        address target;
        uint64 fromBlock;
    }

    mapping(bytes32 kind => Entry[]) private _entries;
    /// @notice The kind each contract is registered as; zero for one that is not.
    mapping(address target => bytes32 kind) public kindOf;
    /// @dev Every kind with at least one entry, in the order each was first used.
    bytes32[] private _kinds;

    event Registered(bytes32 indexed kind, address indexed target, uint256 fromBlock);

    error NoKind();
    error NoCode(address target);
    error AlreadyRegistered(address target, bytes32 kind);
    error LengthMismatch();

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Lists `target`, deployed in block `fromBlock`, as a contract of `kind`.
    function register(bytes32 kind, address target, uint64 fromBlock) public onlyOwner {
        if (kind == bytes32(0)) revert NoKind();
        if (target.code.length == 0) revert NoCode(target);
        if (kindOf[target] != bytes32(0)) revert AlreadyRegistered(target, kindOf[target]);
        if (_entries[kind].length == 0) _kinds.push(kind);
        _entries[kind].push(Entry({target: target, fromBlock: fromBlock}));
        kindOf[target] = kind;
        emit Registered(kind, target, fromBlock);
    }

    /// @notice `register` for several contracts at once, in order.
    function registerMany(bytes32[] calldata kinds_, address[] calldata targets, uint64[] calldata fromBlocks) external onlyOwner {
        if (kinds_.length != targets.length || targets.length != fromBlocks.length) revert LengthMismatch();
        for (uint256 i; i < targets.length; ++i) register(kinds_[i], targets[i], fromBlocks[i]);
    }

    /// @notice Every contract of `kind`, each with the block it was deployed in, the first registered first.
    function entries(bytes32 kind) external view returns (Entry[] memory) {
        return _entries[kind];
    }

    /// @notice Every contract of `kind`, the first registered first.
    function addresses(bytes32 kind) external view returns (address[] memory list) {
        Entry[] storage all = _entries[kind];
        list = new address[](all.length);
        for (uint256 i; i < all.length; ++i) list[i] = all[i].target;
    }

    /// @notice The most recently registered contract of `kind`: the current one; zero where there is none.
    function latest(bytes32 kind) external view returns (address) {
        Entry[] storage all = _entries[kind];
        return all.length == 0 ? address(0) : all[all.length - 1].target;
    }

    /// @notice How many contracts of `kind` are registered.
    function count(bytes32 kind) external view returns (uint256) {
        return _entries[kind].length;
    }

    /// @notice Every kind with at least one contract, in the order each was first used.
    function kinds() external view returns (bytes32[] memory) {
        return _kinds;
    }
}
