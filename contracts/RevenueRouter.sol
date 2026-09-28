// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title outbidfun.lol Revenue Router
/// @notice The one door protocol revenue comes in by, and the split it leaves by: 80% to the
///         OUTBID buyback, 20% to operations (tokenomics §10, after PONS's model).
///
///         Revenue is the protocol's share of every trading fee, every launch fee and every bid,
///         and it arrives in whatever asset it was paid in: ether from bids and launches, and
///         from a coin's curve or pool whatever that coin is priced in — wrapped ether, a
///         dollar, a tokenised share — and, from pool fees, the coin itself. Ether and tokens
///         alike are plain transfers, so nothing that pays the protocol needs to know this
///         contract exists: the factory, the listing manager and every coin pay the address the
///         listing manager calls its treasury, and the outbid market pays its payout address.
///         Point both here.
///
///         The split is kept per asset, because a dollar and an ether do not add. Splitting is a
///         separate step from receiving, so one `allocate` can cover many small payments, and
///         every movement is observable on chain rather than reconstructed from a spreadsheet.
contract RevenueRouter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    /// @notice The asset key for ether. Every other asset is its token contract.
    address public constant ETHER = address(0);

    /// @notice The buyback vault, and the wallet operations are paid to.
    address payable public buyback;
    address payable public operations;

    /// @notice The split, in basis points of every asset that arrives. They sum to `BPS`.
    uint256 public buybackBps;
    uint256 public operationsBps;

    /// @notice Split but not yet released to its destination, per asset.
    mapping(address asset => uint256 amount) public buybackBalance;
    mapping(address asset => uint256 amount) public operationsBalance;

    /// @notice Lifetime totals per asset, for the transparency dashboard (§44).
    mapping(address asset => uint256 amount) public totalReceived;
    mapping(address asset => uint256 amount) public totalAllocatedToBuyback;
    mapping(address asset => uint256 amount) public totalAllocatedToOperations;

    /// @dev Ether that arrived through `receive()` and has not been split. Ether can also be
    ///      pushed in without it, and tokens always arrive silently; `pending` counts all of
    ///      it, and `allocate` counts the difference as received then (audit G-04).
    uint256 private _etherSeen;

    /// @notice Ether that came in by the door. A token's arrival is its own transfer log.
    event RevenueReceived(address indexed source, address indexed asset, uint256 amount);
    event Allocated(address indexed asset, uint256 toBuyback, uint256 toOperations);
    event Released(address indexed asset, address indexed destination, uint256 amount);
    event ReleaseFailed(address indexed asset, address indexed destination, uint256 amount);
    event SplitUpdated(uint256 buybackBps, uint256 operationsBps);
    event DestinationsUpdated(address buyback, address operations);

    error ZeroAddress();
    error InvalidSplit(uint256 total);
    error NothingToAllocate(address asset);
    error NothingToRelease(address asset);
    error TransferFailed(address asset, address destination);

    constructor(
        address initialOwner,
        address payable buyback_,
        address payable operations_,
        uint256 buybackBps_,
        uint256 operationsBps_
    ) Ownable(initialOwner) {
        _setDestinations(buyback_, operations_);
        _setSplit(buybackBps_, operationsBps_);
    }

    /// @notice Any plain ether transfer counts as revenue.
    receive() external payable {
        _receive();
    }

    /// @notice Explicit entry point for callers that prefer a named function (§31).
    function receiveRevenue() external payable {
        _receive();
    }

    function _receive() private {
        _etherSeen += msg.value;
        totalReceived[ETHER] += msg.value;
        emit RevenueReceived(msg.sender, ETHER, msg.value);
    }

    // ---------------------------------------------------------------- views

    /// @notice Everything the router holds of `asset`, split or not.
    function held(address asset) public view returns (uint256) {
        return asset == ETHER ? address(this).balance : IERC20(asset).balanceOf(address(this));
    }

    /// @notice Received but not yet split: every unit of `asset` the router holds that has not
    ///         been assigned to a destination, however it arrived.
    function pending(address asset) public view returns (uint256) {
        return held(asset) - buybackBalance[asset] - operationsBalance[asset];
    }

    // ---------------------------------------------------------------- split

    /// @notice Split everything pending in `asset` by the configured shares. Permissionless:
    ///         the destinations are fixed, so anyone may trigger the accounting. Guarded like
    ///         `release`: a destination paid during a release could otherwise call this and split
    ///         the other destination's money a second time (AUDIT-3 H-03).
    function allocate(address asset) public nonReentrant {
        _allocate(asset);
    }

    function _allocate(address asset) private {
        uint256 amount = pending(asset);
        if (amount == 0) revert NothingToAllocate(asset);

        // What arrived without passing `receive()` — every token, and ether that was forced
        // in — was never counted as received. Count it now, so the lifetime total and the
        // allocations agree (audit G-04). Only ether announces it: a token's arrival already
        // has its own transfer log, with a sender this contract cannot see.
        uint256 unseen = asset == ETHER ? amount - _etherSeen : amount;
        if (asset == ETHER) {
            _etherSeen = 0;
            if (unseen > 0) emit RevenueReceived(address(0), ETHER, unseen);
        }
        totalReceived[asset] += unseen;

        uint256 toOperations = (amount * operationsBps) / BPS;
        // The buyback takes the remainder, so rounding dust never gets stranded.
        uint256 toBuyback = amount - toOperations;

        buybackBalance[asset] += toBuyback;
        operationsBalance[asset] += toOperations;
        totalAllocatedToBuyback[asset] += toBuyback;
        totalAllocatedToOperations[asset] += toOperations;

        emit Allocated(asset, toBuyback, toOperations);
    }

    /// @notice Send each allocated share of `asset` to its destination. Permissionless.
    ///
    ///         Both balances are cleared before either is paid, so a destination whose
    ///         `receive()` calls back in cannot be paid its share twice out of revenue that
    ///         belongs elsewhere (audit F-03). The guard is the second lock on the same door.
    ///
    ///         A destination that refuses its ether keeps its share allocated and does not hold
    ///         up the other (audit F-16). The owner re-points it and releases again. A token
    ///         cannot be refused, only reverted by the token itself, which reverts the release.
    function release(address asset) public nonReentrant {
        _releaseAll(asset);
    }

    function _releaseAll(address asset) private {
        uint256 toBuyback = buybackBalance[asset];
        uint256 toOperations = operationsBalance[asset];
        if (toBuyback + toOperations == 0) revert NothingToRelease(asset);

        buybackBalance[asset] = 0;
        operationsBalance[asset] = 0;

        uint256 released;
        address payable firstRefused;
        if (_release(asset, buyback, toBuyback)) released += toBuyback;
        else (buybackBalance[asset], firstRefused) = (toBuyback, buyback);
        if (_release(asset, operations, toOperations)) released += toOperations;
        else (operationsBalance[asset], firstRefused) = (toOperations, firstRefused == address(0) ? operations : firstRefused);

        // Nothing got through at all: say so, naming who refused first (audit G-08).
        if (released == 0) revert TransferFailed(asset, firstRefused);
    }

    /// @notice Split and pay out one asset in one call, under one guard.
    function allocateAndRelease(address asset) external nonReentrant {
        _allocate(asset);
        _releaseAll(asset);
    }

    function _release(address asset, address payable destination, uint256 amount) private returns (bool) {
        if (amount == 0) return true;
        if (asset == ETHER) {
            (bool ok, ) = destination.call{value: amount}("");
            if (ok) emit Released(asset, destination, amount);
            else emit ReleaseFailed(asset, destination, amount);
            return ok;
        }
        IERC20(asset).safeTransfer(destination, amount);
        emit Released(asset, destination, amount);
        return true;
    }

    // ---------------------------------------------------------------- admin

    function setSplit(uint256 buybackBps_, uint256 operationsBps_) external onlyOwner {
        _setSplit(buybackBps_, operationsBps_);
    }

    function setDestinations(address payable buyback_, address payable operations_) external onlyOwner {
        _setDestinations(buyback_, operations_);
    }

    function _setSplit(uint256 buybackBps_, uint256 operationsBps_) private {
        uint256 total = buybackBps_ + operationsBps_;
        if (total != BPS) revert InvalidSplit(total);
        buybackBps = buybackBps_;
        operationsBps = operationsBps_;
        emit SplitUpdated(buybackBps_, operationsBps_);
    }

    function _setDestinations(address payable buyback_, address payable operations_) private {
        if (buyback_ == address(0) || operations_ == address(0)) revert ZeroAddress();
        buyback = buyback_;
        operations = operations_;
        emit DestinationsUpdated(buyback_, operations_);
    }
}
