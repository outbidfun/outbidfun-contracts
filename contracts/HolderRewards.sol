// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @dev What the distributor needs from the fee escrow: its own balance there, and a way to take it.
interface IFeeEscrowBalance {
    function balanceOf(address recipient, address asset) external view returns (uint256);
    function claim(address asset) external returns (uint256);
}

/// @title A reward coin's holder distributor
/// @notice Shares out what a reward coin collects for its holders, in proportion to what each
///         holds. Two things arrive here: the coin's transfer fee, in the coin itself, and — when
///         the creator chose to share their fees with holders — every fee the creator would have
///         earned, in the asset the coin is priced in. Holders claim both whenever they like.
///
///         One of these is cloned for each reward coin at launch, and serves that coin alone.
///         The coin reports every holder's balance here as it changes, leaving out the accounts
///         that hold coins for the platform rather than for themselves: this contract, the
///         listing manager, the coin's pool, the fee escrow and the dead address.
///
///         Rewards are counted from what this contract holds, not from what anyone says they
///         sent: whatever has arrived since the last count is shared among the holders of that
///         moment, and the count runs before every change in who holds what, so nobody earns
///         from coins they did not hold when the reward came in. Until a million coins (a tenth
///         of a percent of the supply) are held, rewards wait here rather than go to a sliver of it.
///
///         Rewards that arrive in lumps are shared among whoever holds when they are counted: the
///         pool's fees, when the creator shares them, reach here only when someone calls
///         `CoinListingManager.collectFees` and `collectEscrow`. Calling both often keeps the
///         lumps small, and with them what a holder who buys just before could take.
contract HolderRewards {
    using SafeERC20 for IERC20;

    /// @dev Rewards per share are kept scaled up by this, so small rewards over a large supply
    ///      are not rounded away.
    uint256 private constant MAGNITUDE = 2 ** 128;
    /// @notice Rewards are shared only while at least this many coins are held: a million, a
    ///         tenth of a percent of the supply. Below it they wait. The floor is what bounds the
    ///         per-share figure: a reward shared among a sliver of supply scales it up by the
    ///         sliver's smallness, and coins sent round and round could climb it until a large
    ///         share change overflowed — graduation's among them. At a million coins that takes
    ///         the whole supply sent round hundreds of millions of times, each time through a fee.
    uint256 public constant MIN_TOTAL_SHARES = 1_000_000e18;

    /// @notice The coin whose holders this pays, and the asset that coin is priced in.
    address public coin;
    address public asset;
    address public feeEscrow;

    /// @notice Each holder's counted balance, and the sum of them.
    mapping(address account => uint256) public sharesOf;
    uint256 public totalShares;

    struct Ledger {
        /// @dev Rewards per share so far, times MAGNITUDE.
        uint256 perShare;
        /// @dev What this contract holds of the token that is already counted: owed to holders,
        ///      or the rounding left over from sharing it.
        uint256 accounted;
    }

    mapping(address token => Ledger) private _ledger;
    mapping(address token => mapping(address account => int256)) private _corrections;
    /// @notice What each holder has claimed of each reward token.
    mapping(address token => mapping(address account => uint256)) public withdrawn;
    /// @notice Everything ever shared out of each reward token.
    mapping(address token => uint256) public totalDistributed;

    event RewardsDistributed(address indexed token, uint256 amount);
    event RewardsClaimed(address indexed account, address indexed token, uint256 amount);

    error AlreadyInitialized();
    error ZeroAddress();
    error NotCoin();

    /// @notice Binds a fresh clone to its coin. The launch that clones it calls this at once.
    function initialize(address coin_, address asset_, address feeEscrow_) external {
        if (coin != address(0)) revert AlreadyInitialized();
        if (coin_ == address(0) || asset_ == address(0) || feeEscrow_ == address(0)) revert ZeroAddress();
        coin = coin_;
        asset = asset_;
        feeEscrow = feeEscrow_;
    }

    /// @notice The coin reports two holders' new balances after a transfer, counting any reward
    ///         that arrived first. A zero address is skipped: that is how the coin leaves out a
    ///         mint's sender, a burn's recipient and the accounts that do not share.
    function updateShares(address a, uint256 sharesA, address b, uint256 sharesB) external {
        if (msg.sender != coin) revert NotCoin();
        _accrue(coin);
        _accrue(asset);
        if (a != address(0)) _setShares(a, sharesA);
        if (b != address(0)) _setShares(b, sharesB);
    }

    /// @notice Counts whatever has arrived. Anyone may call; every transfer of the coin does.
    function sync() external {
        _accrue(coin);
        _accrue(asset);
    }

    /// @notice Takes in the fees credited to this contract in the escrow — the creator's share
    ///         of the graduated pool's swap fees, when the creator shares their fees with
    ///         holders — and counts them. Anyone may call.
    function collectEscrow() external {
        _takeFromEscrow(coin);
        _takeFromEscrow(asset);
        _accrue(coin);
        _accrue(asset);
    }

    /// @notice Pays the caller everything they have earned, in both reward tokens.
    function claim() external returns (uint256 coinAmount, uint256 assetAmount) {
        _accrue(coin);
        _accrue(asset);
        assetAmount = _withdraw(asset, msg.sender);
        coinAmount = _withdraw(coin, msg.sender);
    }

    /// @notice What `account` could claim right now, counting rewards that have arrived but not
    ///         yet been counted.
    function claimable(address account) external view returns (uint256 coinAmount, uint256 assetAmount) {
        coinAmount = _claimable(coin, account, _pendingPerShare(coin));
        assetAmount = _claimable(asset, account, _pendingPerShare(asset));
    }

    function _takeFromEscrow(address token) private {
        IFeeEscrowBalance escrow = IFeeEscrowBalance(feeEscrow);
        if (escrow.balanceOf(address(this), token) > 0) escrow.claim(token);
    }

    /// @dev Shares out what has arrived since the last count among today's holders.
    function _accrue(address token) private {
        Ledger storage ledger = _ledger[token];
        uint256 held = IERC20(token).balanceOf(address(this));
        uint256 accounted = ledger.accounted;
        if (held <= accounted) return;
        uint256 total = totalShares;
        if (total < MIN_TOTAL_SHARES) return;
        uint256 amount = held - accounted;
        ledger.perShare += (amount * MAGNITUDE) / total;
        ledger.accounted = held;
        totalDistributed[token] += amount;
        emit RewardsDistributed(token, amount);
    }

    /// @dev The per-share figure `_accrue` would reach now, without writing it.
    function _pendingPerShare(address token) private view returns (uint256 perShare) {
        Ledger storage ledger = _ledger[token];
        perShare = ledger.perShare;
        uint256 held = IERC20(token).balanceOf(address(this));
        uint256 total = totalShares;
        if (held > ledger.accounted && total >= MIN_TOTAL_SHARES) {
            perShare += ((held - ledger.accounted) * MAGNITUDE) / total;
        }
    }

    function _claimable(address token, address account, uint256 perShare) private view returns (uint256) {
        int256 earned = SafeCast.toInt256(perShare * sharesOf[account]) + _corrections[token][account];
        if (earned <= 0) return 0;
        uint256 total = uint256(earned) / MAGNITUDE;
        uint256 taken = withdrawn[token][account];
        return total > taken ? total - taken : 0;
    }

    /// @dev A change of shares leaves what the holder has already earned where it was: the
    ///      correction absorbs the per-share figure times the change.
    function _setShares(address account, uint256 shares) private {
        uint256 previous = sharesOf[account];
        if (shares == previous) return;
        address coin_ = coin;
        address asset_ = asset;
        if (shares > previous) {
            uint256 added = shares - previous;
            totalShares += added;
            _corrections[coin_][account] -= SafeCast.toInt256(_ledger[coin_].perShare * added);
            _corrections[asset_][account] -= SafeCast.toInt256(_ledger[asset_].perShare * added);
        } else {
            uint256 removed = previous - shares;
            totalShares -= removed;
            _corrections[coin_][account] += SafeCast.toInt256(_ledger[coin_].perShare * removed);
            _corrections[asset_][account] += SafeCast.toInt256(_ledger[asset_].perShare * removed);
        }
        sharesOf[account] = shares;
    }

    /// @dev Pays out before the transfer is made: a coin claim runs through the coin, which calls
    ///      back into `updateShares`, and by then this claim is already on the books.
    function _withdraw(address token, address account) private returns (uint256 amount) {
        amount = _claimable(token, account, _ledger[token].perShare);
        if (amount == 0) return 0;
        withdrawn[token][account] += amount;
        _ledger[token].accounted -= amount;
        emit RewardsClaimed(account, token, amount);
        IERC20(token).safeTransfer(account, amount);
    }
}
