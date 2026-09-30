// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICoinListingManager} from "./interfaces/ICoinListingManager.sol";
import {ITokenRegistry} from "./interfaces/ITokenRegistry.sol";
import {ISwapExecutor} from "./interfaces/ISwapExecutor.sol";
import {IUniswapV3PoolMinimal, IWETH9Minimal} from "./interfaces/IUniswapV3Minimal.sol";
import {
    BalanceDeltaV4,
    IPoolManagerV4,
    IUnlockCallbackV4,
    PoolKeyV4,
    SwapParamsV4
} from "./interfaces/IUniswapV4Minimal.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

/// @dev What the market needs of a launched coin: what it is priced in, whether its curve is
///      still open, where its pool would be, and the curve's own buy.
interface IBiddableCoin {
    function reserveToken() external view returns (address);
    function listingManager() external view returns (address);
    function cap() external view returns (uint96);
    function buy(uint256 amountIn, uint256 minAmount) external;
    function graduate() external;
}

/// @dev What the market needs of the $OUTBID buyback vault: whether it has a token to buy yet,
///      and its buy-and-burn for a bid's share.
interface IOutbidBuybackVault {
    function enabled() external view returns (bool);
    function buyNow(address assetIn, uint256 amountIn, uint256 minOutbidOut) external returns (uint256 bought);
}

/// @title outbidfun.lol Outbid
/// @notice Pay USDG to raise a coin's position on the Outbid board. Any coin the launchpad launched
///         can be bid on, whatever it is priced in. A bid is split the moment it lands:
///
///           - `burnBps` (75%) buys the coin itself — on its bonding curve, or in its pool once it
///             has graduated — and sends every coin bought to the dead address, in the same
///             transaction. A coin priced in something other than USDG is bought with that asset:
///             the share is first swapped USDG to it through the swap page's executor, along the
///             route the bidder's page chose (`bidVia`). The bidder's `minCoinsOut` bounds the
///             price of the whole of it;
///           - `buybackBps` (20%) buys $OUTBID and burns it, in the same transaction, once the
///             buyback vault has a token to buy; the bidder's `minOutbidOut` bounds the price.
///             Until then it goes to the vault, in USDG, for the vault to spend later;
///           - `treasuryBps` (5%) goes to the treasury, in USDG.
///
///         A bidder who holds something else can pay with it. `bidVia` swaps it to USDG through
///         the swap page's executor, along whatever route across the chain's AMMs the page found
///         best; `bidWith` swaps ether, wrapped ether or a token the owner has routed through the
///         market's own Uniswap V4 route. Either way it happens in the same transaction, the USDG
///         it brought is checked against the bidder's minimum, and that is bid. Rank is `totalBid` descending, the USDG bid stated at eighteen decimals; ties go to
///         the earlier position. Nothing is refunded, and a coin's bid never decreases when
///         another coin outbids it.
///
///         A bid is any amount from `minBid` up: it adds to the coin's total and ranks where that
///         total puts it. Only `outbid`, and a `takeTop` bid, insist on the top spot.
///
///         A coin launched elsewhere — on PONS, by `externalRegistry` — can be bid on as an ad spot
///         on the board. None of its bid goes into that coin: `externalBuybackBps` (80%) goes to
///         the $OUTBID buyback, as the buyback share does above, and `externalTreasuryBps` (20%)
///         to the treasury.
///
///         The market sits behind an ERC-1967 proxy (UUPS): one address for the board and its
///         history, whatever the code behind it. Only the owner can upgrade it
///         (`_authorizeUpgrade`). State is laid out in order, with `__gap` kept at the end for
///         what a later version adds; OpenZeppelin's own state is in its ERC-7201 namespaces,
///         and its reentrancy guard keeps its flag in one too.
contract OutbidMarket is OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuard, IUnlockCallbackV4 {
    using SafeERC20 for IERC20;
    using BalanceDeltaV4 for int256;

    struct Position {
        uint256 totalBid; // cumulative USDG bid on this coin, at 18 decimals
        uint64 firstBidAt; // timestamp of the first bid; earlier wins ties
        uint64 lastBidAt;
        address lastBidder;
    }

    /// @dev One swap into USDG with the PoolManager, through `path` pool by pool. `quote` runs
    ///      the swap only to measure it, and reverts with the answer instead of settling.
    struct SwapOp {
        bool quote;
        PoolKeyV4[] path;
        address currencyIn;
        uint256 amountIn;
    }

    /// @notice What a bid pays with, for `bidVia`: the asset (ether as the zero address), how much,
    ///         the least USDG it must bring, and the executor legs that swap it — none for USDG.
    struct Payment {
        address asset;
        uint256 amount;
        uint256 minUsdg;
        ISwapExecutor.Leg[] legs;
    }

    /// @notice One share of a burn swap, for a coin priced in something other than USDG: its part
    ///         of the burn share in basis points, and the executor steps that swap it. Shares, not
    ///         amounts, because the USDG a bid brings is known only once it lands.
    struct BurnLeg {
        uint16 shareBps;
        ISwapExecutor.Step[] steps;
    }

    uint256 private constant BPS = 10_000;
    address private constant NATIVE = address(0);
    /// @notice Where the coins a bid buys are sent. Coins have no burn of their own; nothing can
    ///         ever move them from here.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice Longest board `getTopTokens` will sort. Its selection sort is O(limit * n), and
    ///         past this it stops fitting in an `eth_call` (audit F-05). Rank longer boards off
    ///         chain from `BidPlaced`, or page through `getPositions`.
    uint256 public constant MAX_TOP_TOKENS = 50;

    /// @notice Most pools a route passes through on its way to USDG.
    uint256 public constant MAX_ROUTE_HOPS = 3;

    /// @notice What every bid is paid in. Set once, at initialization.
    IERC20 public usdg;
    /// @notice Wrapped ether: paid in, it is unwrapped and swapped as ether.
    address public weth;
    /// @notice The Uniswap V4 PoolManager other assets are swapped to USDG through.
    IPoolManagerV4 public poolManager;
    /// @dev 10^(18 − USDG's decimals): a USDG amount times this is the board's unit.
    uint256 private _scale;

    /// @notice The launchpad: only coins it launched can be bid on.
    ITokenRegistry public registry;
    /// @notice Receives the buyback share of every bid: the $OUTBID buyback vault.
    address public buyback;
    /// @notice Receives the treasury share of every bid.
    address public treasury;

    /// @notice How a bid is split, in basis points; the three add up to 10,000.
    uint16 public burnBps;
    uint16 public buybackBps;
    uint16 public treasuryBps;

    /// @notice Smallest accepted bid, in USDG at 18 decimals.
    uint256 public minBid;
    /// @notice How far above the current top bid a bid must land to take the top spot, in USDG at
    ///         18 decimals. A fixed step rather than a percentage, so the cost of taking #1 is the
    ///         same whether the leader has bid 1,000 USDG or 100,000.
    uint256 public outbidIncrement;

    /// @notice Token holding the top spot (earlier position wins ties).
    address public topToken;
    /// @notice True until the first bid lands, or the owner closes it: while open, the owner may
    ///         carry the board over from the market this one replaces (`migrate`). Once closed it
    ///         never opens again, so no position can be written except by a bid.
    bool public migrationOpen;

    address[] private _tokens;
    mapping(address token => Position) private _positions;
    mapping(address token => uint256 indexPlusOne) private _tokenIndex;
    /// @dev The V4 pools each asset is swapped to USDG through, in order; ether is keyed as the
    ///      zero address.
    mapping(address assetIn => PoolKeyV4[]) private _routes;
    /// @dev The V3 pool a bid is buying in right now; the only caller its callback will pay.
    address private _swapping;
    /// @notice The swap page's executor (`SwapExecutor`), through which `bidVia` swaps a payment to
    ///         USDG, and a burn share to the asset a coin is priced in. It calls only routers its
    ///         owner listed; unset, `bidVia` takes USDG for coins priced in USDG only.
    ISwapExecutor public executor;
    /// @notice Coins launched elsewhere that may be bid on as an ad spot (`PonsTokenRegistry`):
    ///         unset, only the launchpad's own.
    ITokenRegistry public externalRegistry;
    /// @notice How an external coin's bid is split, in basis points; the two add up to 10,000.
    uint16 public externalBuybackBps;
    uint16 public externalTreasuryBps;

    /// @dev Room for what a later version adds, so its state lands after all of this.
    uint256[45] private __gap;

    event BidPlaced(
        address indexed token,
        address indexed bidder,
        address indexed asset,
        uint256 amount,
        uint256 value,
        uint256 totalBid,
        uint256 timestamp
    );
    /// @notice Where a bid went: what bought the coin and how many coins it burned, and the two
    ///         shares paid on.
    event BidSettled(
        address indexed token,
        address indexed asset,
        uint256 burnSpent,
        uint256 coinsBurned,
        uint256 toBuyback,
        uint256 toTreasury
    );
    /// @notice A bid paid in something other than USDG, and the USDG it was swapped to.
    event PaidWith(address indexed bidder, address indexed assetIn, uint256 amountIn, uint256 usdgOut);
    event TopSpotChanged(address indexed token, address indexed previousTop, uint256 totalBid);
    event DestinationsUpdated(address indexed buyback, address indexed treasury);
    event SplitUpdated(uint16 burnBps, uint16 buybackBps, uint16 treasuryBps);
    event RouteSet(address indexed assetIn, PoolKeyV4[] path);
    event RouteCleared(address indexed assetIn);
    event RegistryUpdated(address indexed registry);
    event MinBidUpdated(uint256 minBid);
    event OutbidIncrementUpdated(uint256 outbidIncrement);
    /// @notice A bid's buyback share could not buy $OUTBID just then, so it went to the vault in
    ///         USDG for the keeper to spend, and the bid went through.
    event BuybackDeferred(uint256 amount);
    event ExecutorUpdated(address indexed executor);
    /// @notice A position carried over from the market this one replaces, as it stood there.
    event PositionMigrated(address indexed token, uint256 totalBid, uint64 firstBidAt, uint64 lastBidAt, address lastBidder);
    event MigrationEnded();
    event ExternalRegistryUpdated(address indexed registry);
    event ExternalSplitUpdated(uint16 buybackBps, uint16 treasuryBps);
    /// @notice A burn share swapped from USDG to `asset`, the coin's own, before buying the coin.
    event BurnRouted(address indexed token, address indexed asset, uint256 usdgIn, uint256 assetOut);

    error ZeroAddress();
    error NoRegistry();
    error TokenNotRegistered(address token);
    error BidTooLow(uint256 required, uint256 provided);
    error InvalidIncrement(uint256 increment);
    error InvalidSplit(uint256 total);
    error NotTradable(address token);
    error ExcessiveSlippage(uint256 minimum, uint256 received);
    error InsufficientUsdg(uint256 minimum, uint256 received);
    error NoRoute(address assetIn);
    error BadRoute(address assetIn);
    error WrongValue(uint256 expected, uint256 sent);
    error RefundFailed();
    error QuoteResult(uint256 usdgOut);
    error ShallowRoute(address currency);
    error UnexpectedCaller(address caller);
    error NoExecutor();
    error NoBurnRoute(address asset);
    error ShortTransfer(address asset);
    error MigrationOver();
    error BadMigration();
    error NotBurnable(address token);

    /// @dev The implementation is never used on its own: only through a proxy, initialized there.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Sets the market up behind its proxy, once: the deployer's arguments, as the
    ///         constructor took them before the market was upgradeable. External coins start split
    ///         80 / 20 and unlisted until `setExternalRegistry`.
    function initialize(
        address initialOwner,
        IERC20Metadata usdg_,
        address weth_,
        IPoolManagerV4 poolManager_,
        address buyback_,
        address treasury_,
        uint256 minBid_,
        uint256 outbidIncrement_
    ) external initializer {
        __Ownable_init(initialOwner);
        if (address(usdg_) == address(0) || weth_ == address(0)) revert ZeroAddress();
        uint8 decimals = usdg_.decimals();
        require(decimals <= 18, "Too many decimals");
        usdg = IERC20(address(usdg_));
        weth = weth_;
        // Zero leaves the market taking USDG only, with nothing to swap through.
        poolManager = poolManager_;
        _scale = 10 ** (18 - decimals);
        _setDestinations(buyback_, treasury_);
        _setSplit(7_500, 2_000, 500);
        _setExternalSplit(8_000, 2_000);
        _setMinBid(minBid_);
        _setOutbidIncrement(outbidIncrement_);
        migrationOpen = true;
    }

    /// @dev Only the owner replaces the code behind the proxy.
    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Only wrapped ether unwrapping on the way to a swap sends ether here, and the executor
    ///         returning what a payment's swap left unspent.
    receive() external payable {
        if (msg.sender != weth && msg.sender != address(executor)) revert UnexpectedCaller(msg.sender);
    }

    // ---------------------------------------------------------------- views

    /// @notice Cumulative USDG bid on `token`, at 18 decimals: its current bid.
    function getTotalBid(address token) external view returns (uint256) {
        return _positions[token].totalBid;
    }

    function getPosition(address token) external view returns (Position memory) {
        return _positions[token];
    }

    /// @notice Number of tokens holding a position.
    function tokenCount() external view returns (uint256) {
        return _tokens.length;
    }

    function tokenAt(uint256 index) external view returns (address) {
        return _tokens[index];
    }

    /// @notice True when a bid's buyback share buys $OUTBID and burns it in the bid: `buyback` is
    ///         a vault whose token is set. The treasury, or any address that is not a vault,
    ///         answers nothing and is paid instead.
    function buybackLive() public view returns (bool) {
        address vault = buyback;
        if (vault.code.length == 0) return false;
        (bool ok, bytes memory data) = vault.staticcall(abi.encodeCall(IOutbidBuybackVault.enabled, ()));
        return ok && data.length == 32 && abi.decode(data, (bool));
    }

    /// @notice The V4 pools `assetIn` is swapped to USDG through, in order (ether is the zero
    ///         address); empty when there is no route.
    function routeOf(address assetIn) external view returns (PoolKeyV4[] memory) {
        return _routes[assetIn];
    }

    /// @notice The next bid, in USDG at 18 decimals: what `token` must add in one transaction to
    ///         hold the top spot. For a challenger this is `topBid + outbidIncrement` less
    ///         whatever it has already bid, so only the difference is charged; for the current
    ///         holder it is the amount to defend. Never below `minBid`.
    function getNextBid(address token) public view returns (uint256) {
        // The step is over the current leader. With no leader there is nothing to step over,
        // and the first position costs the minimum bid.
        uint256 target = topToken == address(0) ? 0 : _positions[topToken].totalBid + outbidIncrement;
        uint256 bidSoFar = _positions[token].totalBid;
        uint256 needed = target > bidSoFar ? target - bidSoFar : 0;
        return needed > minBid ? needed : minBid;
    }

    /// @notice The next bid in USDG's own units: what to pay `outbid`.
    function getNextBidAmount(address token) external view returns (address asset, uint256 amount) {
        asset = address(usdg);
        amount = Math.ceilDiv(getNextBid(token), _scale);
    }

    /// @notice The `limit` highest positions, top spot first, at most `MAX_TOP_TOKENS`.
    ///         O(limit * n); intended for off-chain reads and as the reference ordering for
    ///         indexers. A `limit` above the cap is clamped rather than rejected, so a caller
    ///         asking for "everything" gets the board rather than an out-of-gas error.
    function getTopTokens(uint256 limit) external view returns (address[] memory) {
        uint256 n = _tokens.length;
        if (limit > n) limit = n;
        if (limit > MAX_TOP_TOKENS) limit = MAX_TOP_TOKENS;

        address[] memory pool = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            pool[i] = _tokens[i];
        }

        for (uint256 i = 0; i < limit; i++) {
            uint256 best = i;
            for (uint256 j = i + 1; j < n; j++) {
                if (_ranksAbove(pool[j], pool[best])) best = j;
            }
            if (best != i) (pool[i], pool[best]) = (pool[best], pool[i]);
        }

        address[] memory result = new address[](limit);
        for (uint256 i = 0; i < limit; i++) {
            result[i] = pool[i];
        }
        return result;
    }

    /// @notice A page of positions in registration order, unsorted. The whole board can be
    ///         read in fixed-size calls and ranked off chain, which is what an indexer wants
    ///         and what `getTopTokens` cannot do past `MAX_TOP_TOKENS` (audit F-05).
    function getPositions(
        uint256 offset,
        uint256 count
    ) external view returns (address[] memory tokens, Position[] memory positions) {
        uint256 n = _tokens.length;
        uint256 size = offset >= n ? 0 : n - offset;
        if (size > count) size = count;

        tokens = new address[](size);
        positions = new Position[](size);
        for (uint256 i = 0; i < size; i++) {
            tokens[i] = _tokens[offset + i];
            positions[i] = _positions[tokens[i]];
        }
    }

    /// @notice The USDG `amountIn` of `assetIn` would swap to right now, through its route. Not a
    ///         view — the PoolManager only swaps inside a session — so call it with `eth_call`: it
    ///         runs the swap, reverts with the answer, and moves nothing.
    function quoteUsdg(address assetIn, uint256 amountIn) external returns (uint256 usdgOut) {
        address currencyIn = assetIn == weth ? NATIVE : assetIn;
        if (currencyIn == address(usdg)) return amountIn;
        PoolKeyV4[] memory path = _routeFor(currencyIn);
        try poolManager.unlock(abi.encode(SwapOp({quote: true, path: path, currencyIn: currencyIn, amountIn: amountIn}))) {
            // A quote always reverts; reaching here would mean the PoolManager did not call back.
            revert UnexpectedCaller(address(poolManager));
        } catch (bytes memory reason) {
            bytes4 selector;
            assembly {
                selector := mload(add(reason, 32))
            }
            if (reason.length != 36 || selector != QuoteResult.selector) {
                assembly {
                    revert(add(reason, 32), mload(reason))
                }
            }
            assembly {
                usdgOut := mload(add(reason, 36))
            }
        }
    }

    // -------------------------------------------------------------- bidding

    /// @notice Bid `amount` of USDG, approved to this contract, on a coin priced in USDG (a coin
    ///         priced in anything else needs a burn route: `bidVia`). Any bid of at least `minBid`
    ///         is accepted; rank follows from the total bid.
    /// @param minCoinsOut The fewest coins the burn share must buy, or the bid reverts.
    /// @param minOutbidOut The least $OUTBID the buyback share must buy once the vault buys in the
    ///        bid; required then, and ignored while the share still goes to the vault.
    /// @return coinsBurned The coins the burn share bought and burned.
    /// @return outbidBurned The $OUTBID the buyback share bought and burned; zero until live.
    function bid(address token, uint256 amount, uint256 minCoinsOut, uint256 minOutbidOut)
        external
        nonReentrant
        returns (uint256 coinsBurned, uint256 outbidBurned)
    {
        bool external_ = _check(token);
        return _bid(token, external_, _pullUsdg(amount), minCoinsOut, minOutbidOut, false, new BurnLeg[](0));
    }

    /// @notice Bid that must take, or for the current holder defend, the top spot at execution
    ///         time. Reverts with `BidTooLow` if someone raised the bar between quoting
    ///         `getNextBidAmount` and the transaction landing.
    function outbid(address token, uint256 amount, uint256 minCoinsOut, uint256 minOutbidOut)
        external
        nonReentrant
        returns (uint256 coinsBurned, uint256 outbidBurned)
    {
        bool external_ = _check(token);
        return _bid(token, external_, _pullUsdg(amount), minCoinsOut, minOutbidOut, true, new BurnLeg[](0));
    }

    /// @notice Bid with something other than USDG: ether (the zero address, sent as value),
    ///         wrapped ether, or a token the owner has routed. It is swapped to USDG through its
    ///         V4 route — one pool, or several in a row — in this transaction, the USDG it brings is checked against `minUsdg`, and
    ///         that USDG is bid — as `outbid` when `takeTop`, else as `bid`. Anything the swap
    ///         could not use is returned.
    function bidWith(
        address token,
        address assetIn,
        uint256 amountIn,
        uint256 minUsdg,
        uint256 minCoinsOut,
        uint256 minOutbidOut,
        bool takeTop
    ) external payable nonReentrant returns (uint256 coinsBurned, uint256 outbidBurned) {
        bool external_ = _check(token);
        uint256 received = _payWith(assetIn, amountIn, minUsdg);
        return _bid(token, external_, received, minCoinsOut, minOutbidOut, takeTop, new BurnLeg[](0));
    }

    /// @notice Bid on any coin with anything, routed by the swap page's DEX aggregator: `payment`
    ///         is swapped to USDG through the executor along its legs (none for USDG), checked
    ///         against its `minUsdg`, and bid — as `outbid` when `takeTop`, else as `bid`. For a
    ///         coin priced in something other than USDG, `burnRoute` swaps the burn share from USDG
    ///         to that asset first, share by share. `minCoinsOut` bounds the whole way to the coin.
    ///         Anything the payment's swap could not use is returned.
    function bidVia(
        address token,
        Payment calldata payment,
        BurnLeg[] calldata burnRoute,
        uint256 minCoinsOut,
        uint256 minOutbidOut,
        bool takeTop
    ) external payable nonReentrant returns (uint256 coinsBurned, uint256 outbidBurned) {
        bool external_ = _check(token);
        uint256 received = _payVia(payment);
        return _bid(token, external_, received, minCoinsOut, minOutbidOut, takeTop, burnRoute);
    }

    /// @dev A coin the launchpad launched.
    ///      Or one launched elsewhere that `externalRegistry` lists, bid on as an ad spot: then
    ///      `external_` is true. The launchpad's own registry is asked first, so a coin both would
    ///      claim is always the launchpad's.
    function _check(address token) private view returns (bool external_) {
        if (token == address(0)) revert ZeroAddress();
        ITokenRegistry _registry = registry;
        ITokenRegistry _external = externalRegistry;
        if (address(_registry) == address(0) && address(_external) == address(0)) revert NoRegistry();
        // An address with no code is never a coin, whatever a registry says of it, and no
        // registry is asked anything about it.
        if (token.code.length == 0) revert TokenNotRegistered(token);
        if (address(_registry) != address(0) && _registry.isMemeCoinLegit(token)) return false;
        if (address(_external) != address(0) && _external.isMemeCoinLegit(token)) return true;
        revert TokenNotRegistered(token);
    }

    /// @dev Measured rather than trusted, so a transfer that takes a cut cannot rank a bid for
    ///      money that never arrived.
    function _pullUsdg(uint256 amount) private returns (uint256) {
        uint256 before = usdg.balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        return usdg.balanceOf(address(this)) - before;
    }

    function _bid(
        address token,
        bool external_,
        uint256 amount,
        uint256 minCoinsOut,
        uint256 minOutbidOut,
        bool mustTop,
        BurnLeg[] memory burnRoute
    ) private returns (uint256 coinsBurned, uint256 outbidBurned) {
        // The first bid ends the migration: from here, only bids write the board.
        if (migrationOpen) _endMigration();
        uint256 value = amount * _scale;
        uint256 required = mustTop ? getNextBid(token) : minBid;
        if (value < required || value == 0) revert BidTooLow(required, value);

        Position storage position = _positions[token];
        if (position.firstBidAt == 0) {
            position.firstBidAt = uint64(block.timestamp);
            _tokens.push(token);
            _tokenIndex[token] = _tokens.length;
        }
        position.totalBid += value;
        position.lastBidAt = uint64(block.timestamp);
        position.lastBidder = msg.sender;
        emit BidPlaced(token, msg.sender, address(usdg), amount, value, position.totalBid, block.timestamp);

        address currentTop = topToken;
        // The same ordering the board uses, so the two can never name different tokens as #1
        // when totals tie (audit F-04).
        if (token != currentTop && _ranksAbove(token, currentTop)) {
            topToken = token;
            emit TopSpotChanged(token, currentTop, position.totalBid);
        }

        return _settle(token, external_, amount, minCoinsOut, minOutbidOut, burnRoute);
    }

    /// @dev Spends the burn share on the coin, burning what it buys, and the buyback share on
    ///      $OUTBID (or pays it to the vault), and pays the treasury. Rounding dust stays with the
    ///      burn share. An external coin has no burn share: its bid is the buyback's and the
    ///      treasury's alone, the dust the buyback's, and it takes no burn route.
    function _settle(
        address token,
        bool external_,
        uint256 amount,
        uint256 minCoinsOut,
        uint256 minOutbidOut,
        BurnLeg[] memory burnRoute
    ) private returns (uint256 coinsBurned, uint256 outbidBurned) {
        uint256 toBuyback;
        uint256 toTreasury;
        uint256 toBurn;
        if (external_) {
            if (burnRoute.length != 0) revert NotBurnable(token);
            toTreasury = (amount * externalTreasuryBps) / BPS;
            toBuyback = amount - toTreasury;
        } else {
            toBuyback = (amount * buybackBps) / BPS;
            toTreasury = (amount * treasuryBps) / BPS;
            toBurn = amount - toBuyback - toTreasury;
        }

        uint256 burnSpent;
        if (toBurn > 0) (burnSpent, coinsBurned) = _buyAndBurn(token, toBurn, burnRoute);
        if (coinsBurned < minCoinsOut) revert ExcessiveSlippage(minCoinsOut, coinsBurned);

        if (toBuyback > 0) outbidBurned = _payBuyback(toBuyback, minOutbidOut);
        if (toTreasury > 0) usdg.safeTransfer(treasury, toTreasury);
        emit BidSettled(token, address(usdg), burnSpent, coinsBurned, toBuyback, toTreasury);
    }

    /// @dev The buyback share: spent on $OUTBID and burned in this bid once the vault has a token
    ///      to buy, and paid to `buyback` until then — the vault, or the treasury before the vault
    ///      exists. The vault checks `minOutbidOut` and spends no more than its cap now.
    function _payBuyback(uint256 amount, uint256 minOutbidOut) private returns (uint256 outbidBurned) {
        address vault = buyback;
        if (!buybackLive()) {
            usdg.safeTransfer(vault, amount);
            return 0;
        }
        // The buy runs in a market the protocol does not control: PONS between its curve and its
        // pool, a missing route, a curve's last part-fill. None of that is the bidder's doing, so
        // none of it may fail the bid: the share goes to the vault in USDG instead, as it did
        // before the vault was live, and waits for the keeper (AUDIT-3 H-01). The bidder's
        // minimum bounds the price when a buy happens; when none does, there is nothing to bound.
        usdg.forceApprove(vault, amount);
        try IOutbidBuybackVault(vault).buyNow(address(usdg), amount, minOutbidOut) returns (uint256 burned) {
            outbidBurned = burned;
        } catch {
            usdg.forceApprove(vault, 0);
            usdg.safeTransfer(vault, amount);
            emit BuybackDeferred(amount);
            return 0;
        }
        usdg.forceApprove(vault, 0);
    }

    /// @dev Buys `token` with `amount` of USDG wherever it trades — its curve while that is open,
    ///      its pool after — and sends every coin bought to the dead address. A buy that fills the
    ///      curve graduates the coin inside it, and the curve hands back what it could not take;
    ///      that remainder buys in the pool the graduation just opened. A coin priced in another
    ///      asset is bought with that asset, swapped from the USDG along `burnRoute` first.
    ///      `spent` is the USDG that went, either way.
    function _buyAndBurn(address token, uint256 amount, BurnLeg[] memory burnRoute)
        private
        returns (uint256 spent, uint256 coins)
    {
        IBiddableCoin coin = IBiddableCoin(token);
        IERC20 asset = IERC20(coin.reserveToken());
        uint256 usdgBefore = usdg.balanceOf(address(this));
        uint256 coinsBefore = IERC20(token).balanceOf(address(this));
        if (address(asset) != address(usdg)) amount = _swapBurnShare(token, address(asset), amount, burnRoute);
        uint256 assetBefore = asset.balanceOf(address(this));

        // A curve pushed full from outside refuses buys until something graduates it. Do that
        // first, so the bid buys in the pool it opens rather than failing (AUDIT-3 H-04).
        uint256 capNow = coin.cap();
        if (capNow != 0 && asset.balanceOf(token) >= capNow) coin.graduate();

        uint256 remaining = amount;
        if (coin.cap() != 0) {
            asset.forceApprove(token, amount);
            coin.buy(amount, 0);
            asset.forceApprove(token, 0);
            // What the curve did not take came back: the change from a buy that filled it.
            remaining = amount - (assetBefore - asset.balanceOf(address(this)));
        }
        if (remaining > 0) {
            address pool = ICoinListingManager(coin.listingManager()).poolOf(token);
            if (pool == address(0)) revert NotTradable(token);
            _swapInV3(pool, address(asset), token, remaining);
        }

        spent = usdgBefore - usdg.balanceOf(address(this));
        coins = IERC20(token).balanceOf(address(this)) - coinsBefore;
        if (coins > 0) IERC20(token).safeTransfer(DEAD, coins);
    }

    /// @dev Swaps `amount` of USDG to `asset` through the executor, one leg per share of
    ///      `burnRoute`, and returns what it brought. Each leg's minimum is nothing: the bidder's
    ///      `minCoinsOut` bounds the whole way to the coin. USDG a pool could not take comes back
    ///      from the executor and goes to the treasury, so nothing stays here.
    function _swapBurnShare(address token, address asset, uint256 amount, BurnLeg[] memory burnRoute)
        private
        returns (uint256 received)
    {
        if (burnRoute.length == 0) revert NoBurnRoute(asset);
        ISwapExecutor ex = executor;
        if (address(ex) == address(0)) revert NoExecutor();
        ISwapExecutor.Leg[] memory legs = new ISwapExecutor.Leg[](burnRoute.length);
        uint256 shares;
        uint256 given;
        for (uint256 i = 0; i < burnRoute.length; i++) {
            if (burnRoute[i].shareBps == 0) revert NoBurnRoute(asset);
            shares += burnRoute[i].shareBps;
            // The last leg takes the rounding, so the legs add up to the whole share.
            uint256 legIn = i == burnRoute.length - 1 ? amount - given : (amount * burnRoute[i].shareBps) / BPS;
            given += legIn;
            legs[i] = ISwapExecutor.Leg({amountIn: legIn, minOut: 0, steps: burnRoute[i].steps});
        }
        if (shares != BPS) revert InvalidSplit(shares);

        uint256 assetBefore = IERC20(asset).balanceOf(address(this));
        uint256 usdgBefore = usdg.balanceOf(address(this));
        usdg.forceApprove(address(ex), amount);
        ex.execute(
            ISwapExecutor.Trade({
                tokenIn: address(usdg),
                tokenOut: asset,
                amountIn: amount,
                minAmountOut: 0,
                recipient: address(this),
                deadline: block.timestamp,
                legs: legs
            })
        );
        usdg.forceApprove(address(ex), 0);
        received = IERC20(asset).balanceOf(address(this)) - assetBefore;
        uint256 used = usdgBefore - usdg.balanceOf(address(this));
        if (used < amount) usdg.safeTransfer(treasury, amount - used);
        emit BurnRouted(token, asset, used, received);
    }

    function _swapInV3(address pool, address tokenIn, address tokenOut, uint256 amountIn) private {
        bool zeroForOne = tokenIn < tokenOut;
        _swapping = pool;
        IUniswapV3PoolMinimal(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? PoolMath.MIN_SQRT_RATIO + 1 : PoolMath.MAX_SQRT_RATIO - 1,
            abi.encode(tokenIn)
        );
        _swapping = address(0);
    }

    /// @dev Pays the V3 pool a bid is buying in, and only that pool, only its input side.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address pool = _swapping;
        if (pool == address(0) || msg.sender != pool) revert UnexpectedCaller(msg.sender);
        int256 owed = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (owed <= 0) revert UnexpectedCaller(msg.sender);
        address tokenIn = abi.decode(data, (address));
        IERC20(tokenIn).safeTransfer(pool, uint256(owed));
    }

    // ------------------------------------------------------ paying with other

    /// @dev Takes the payment from the bidder, swaps it to USDG through the executor along its legs,
    ///      returns what the swap could not use, and gives back the USDG it brought — at least
    ///      `minUsdg`, which the executor enforces and this checks again. USDG itself is taken as
    ///      it is. A token that arrives short of what was sent, taxed on transfer, is refused: the
    ///      legs were routed for the whole amount.
    function _payVia(Payment calldata payment) private returns (uint256 received) {
        if (payment.asset == address(usdg)) {
            if (msg.value != 0) revert WrongValue(0, msg.value);
            received = _pullUsdg(payment.amount);
            if (received < payment.minUsdg) revert InsufficientUsdg(payment.minUsdg, received);
            return received;
        }
        ISwapExecutor ex = executor;
        if (address(ex) == address(0)) revert NoExecutor();

        uint256 value;
        uint256 heldBefore;
        if (payment.asset == NATIVE) {
            if (msg.value != payment.amount) revert WrongValue(payment.amount, msg.value);
            value = payment.amount;
            heldBefore = address(this).balance - value;
        } else {
            if (msg.value != 0) revert WrongValue(0, msg.value);
            IERC20 asset = IERC20(payment.asset);
            heldBefore = asset.balanceOf(address(this));
            asset.safeTransferFrom(msg.sender, address(this), payment.amount);
            if (asset.balanceOf(address(this)) - heldBefore != payment.amount) revert ShortTransfer(payment.asset);
            asset.forceApprove(address(ex), payment.amount);
        }

        uint256 usdgBefore = usdg.balanceOf(address(this));
        ex.execute{value: value}(
            ISwapExecutor.Trade({
                tokenIn: payment.asset,
                tokenOut: address(usdg),
                amountIn: payment.amount,
                minAmountOut: payment.minUsdg,
                recipient: address(this),
                deadline: block.timestamp,
                legs: payment.legs
            })
        );
        received = usdg.balanceOf(address(this)) - usdgBefore;
        if (received < payment.minUsdg) revert InsufficientUsdg(payment.minUsdg, received);

        // What the swap left unspent came back from the executor as it was paid, ether as ether and
        // a token (wrapped ether included) as itself; it goes back to the bidder the same way.
        uint256 unspent;
        if (payment.asset == NATIVE) {
            unspent = address(this).balance - heldBefore;
            if (unspent > 0) {
                (bool ok, ) = payable(msg.sender).call{value: unspent}("");
                if (!ok) revert RefundFailed();
            }
        } else {
            IERC20(payment.asset).forceApprove(address(ex), 0);
            unspent = IERC20(payment.asset).balanceOf(address(this)) - heldBefore;
            if (unspent > 0) IERC20(payment.asset).safeTransfer(msg.sender, unspent);
        }
        emit PaidWith(msg.sender, payment.asset, payment.amount - unspent, received);
    }

    /// @dev Takes `amountIn` of `assetIn` from the bidder, swaps it to USDG through its route,
    ///      returns what the swap could not use, and gives back the USDG it brought — at least
    ///      `minUsdg`.
    function _payWith(address assetIn, uint256 amountIn, uint256 minUsdg) private returns (uint256 received) {
        if (assetIn == address(usdg)) {
            if (msg.value != 0) revert WrongValue(0, msg.value);
            received = _pullUsdg(amountIn);
            if (received < minUsdg) revert InsufficientUsdg(minUsdg, received);
            return received;
        }

        address currencyIn = assetIn;
        uint256 amount = amountIn;
        if (assetIn == NATIVE) {
            if (msg.value != amountIn) revert WrongValue(amountIn, msg.value);
        } else {
            if (msg.value != 0) revert WrongValue(0, msg.value);
            uint256 before = IERC20(assetIn).balanceOf(address(this));
            IERC20(assetIn).safeTransferFrom(msg.sender, address(this), amountIn);
            amount = IERC20(assetIn).balanceOf(address(this)) - before;
            // Wrapped ether is swapped as ether, through ether's route.
            if (assetIn == weth) {
                IWETH9Minimal(weth).withdraw(amount);
                currencyIn = NATIVE;
            }
        }

        PoolKeyV4[] memory path = _routeFor(currencyIn);
        uint256 usdgBefore = usdg.balanceOf(address(this));
        bytes memory result = poolManager.unlock(
            abi.encode(SwapOp({quote: false, path: path, currencyIn: currencyIn, amountIn: amount}))
        );
        uint256 used = abi.decode(result, (uint256));
        received = usdg.balanceOf(address(this)) - usdgBefore;
        if (received < minUsdg) revert InsufficientUsdg(minUsdg, received);
        if (amount > used) _refund(assetIn, amount - used);
        emit PaidWith(msg.sender, assetIn, amount, received);
    }

    /// @notice The PoolManager's session: an exact-input swap into USDG through each pool of the
    ///         route in turn, then the settlement — or, for a quote, the answer as a revert and
    ///         nothing settled. Each pool's output is the next one's whole input, so what passes
    ///         between them nets to nothing, and only the first input and the USDG out are settled.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert UnexpectedCaller(msg.sender);
        SwapOp memory op = abi.decode(data, (SwapOp));

        address currency = op.currencyIn;
        uint256 amount = op.amountIn;
        uint256 used;
        for (uint256 i = 0; i < op.path.length; i++) {
            (uint256 spent, uint256 out, address next) = _swapV4(op.path[i], currency, amount);
            // The first pool may leave some of the input, which goes back to the bidder; a pool
            // further on that cannot take all it is handed would leave a debt no one settles.
            if (i == 0) used = spent;
            else if (spent != amount) revert ShallowRoute(currency);
            currency = next;
            amount = out;
        }
        if (op.quote) revert QuoteResult(amount);

        if (op.currencyIn == NATIVE) {
            poolManager.settle{value: used}();
        } else {
            poolManager.sync(op.currencyIn);
            IERC20(op.currencyIn).safeTransfer(address(poolManager), used);
            poolManager.settle();
        }
        poolManager.take(address(usdg), address(this), amount);
        return abi.encode(used);
    }

    /// @dev One exact-input swap of `amountIn` of `currencyIn` in `key`'s pool: what it took, what
    ///      it gave, and in which currency.
    function _swapV4(PoolKeyV4 memory key, address currencyIn, uint256 amountIn)
        private
        returns (uint256 spent, uint256 out, address currencyOut)
    {
        bool zeroForOne = currencyIn == key.currency0;
        int256 delta = poolManager.swap(
            key,
            SwapParamsV4({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? BalanceDeltaV4.MIN_SQRT_PRICE + 1 : BalanceDeltaV4.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 inDelta, int128 outDelta) = zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        spent = uint256(uint128(-inDelta));
        out = uint256(uint128(outDelta));
        currencyOut = zeroForOne ? key.currency1 : key.currency0;
    }

    function _routeFor(address currencyIn) private view returns (PoolKeyV4[] memory path) {
        if (address(poolManager) == address(0)) revert NoRoute(currencyIn);
        path = _routes[currencyIn];
        if (path.length == 0) revert NoRoute(currencyIn);
    }

    /// @dev Returns what a swap did not use, in what the bidder paid with. Wrapped ether was
    ///      unwrapped for the swap, so it is wrapped again before it goes back.
    function _refund(address assetIn, uint256 amount) private {
        if (assetIn == NATIVE) {
            (bool ok, ) = payable(msg.sender).call{value: amount}("");
            if (!ok) revert RefundFailed();
        } else if (assetIn == weth) {
            IWETH9Minimal(weth).deposit{value: amount}();
            IERC20(weth).safeTransfer(msg.sender, amount);
        } else {
            IERC20(assetIn).safeTransfer(msg.sender, amount);
        }
    }

    /// @dev Strict ordering: higher bid, then earlier first bid, then earlier registration.
    function _ranksAbove(address a, address b) private view returns (bool) {
        Position storage pa = _positions[a];
        Position storage pb = _positions[b];
        if (pa.totalBid != pb.totalBid) return pa.totalBid > pb.totalBid;
        if (pa.firstBidAt != pb.firstBidAt) return pa.firstBidAt < pb.firstBidAt;
        return _tokenIndex[a] < _tokenIndex[b];
    }

    // ---------------------------------------------------------------- admin

    /// @notice Set to the CoinFactory: only coins it launched can be bid on.
    function setRegistry(ITokenRegistry registry_) external onlyOwner {
        registry = registry_;
        emit RegistryUpdated(address(registry_));
    }

    function setDestinations(address buyback_, address treasury_) external onlyOwner {
        _setDestinations(buyback_, treasury_);
    }

    /// @notice Carries positions over from the market this one replaces, before any bid: each
    ///         token's cumulative bid, first and last bid times and last bidder, exactly as they
    ///         stood there, in the order given, which is the order ties break by. A token given
    ///         again is overwritten in place, so a board re-read after the old market was frozen
    ///         can be applied again. The top spot is recomputed across the whole board.
    function migrate(address[] calldata tokens, Position[] calldata positions) external onlyOwner {
        if (!migrationOpen) revert MigrationOver();
        if (tokens.length != positions.length) revert BadMigration();
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            Position calldata position = positions[i];
            if (token == address(0) || position.totalBid == 0 || position.firstBidAt == 0) revert BadMigration();
            if (_tokenIndex[token] == 0) {
                _tokens.push(token);
                _tokenIndex[token] = _tokens.length;
            }
            _positions[token] = position;
            emit PositionMigrated(token, position.totalBid, position.firstBidAt, position.lastBidAt, position.lastBidder);
        }
        address top = _tokens.length > 0 ? _tokens[0] : address(0);
        for (uint256 i = 1; i < _tokens.length; i++) {
            if (_ranksAbove(_tokens[i], top)) top = _tokens[i];
        }
        topToken = top;
    }

    /// @notice Ends the migration for good, before the first bid would.
    function closeMigration() external onlyOwner {
        if (!migrationOpen) revert MigrationOver();
        _endMigration();
    }

    function _endMigration() private {
        migrationOpen = false;
        emit MigrationEnded();
    }

    /// @notice Set to the swap page's `SwapExecutor`, whose listed routers `bidVia` swaps through;
    ///         the zero address turns routed bids off.
    function setExecutor(ISwapExecutor executor_) external onlyOwner {
        executor = executor_;
        emit ExecutorUpdated(address(executor_));
    }

    function setSplit(uint16 burnBps_, uint16 buybackBps_, uint16 treasuryBps_) external onlyOwner {
        _setSplit(burnBps_, buybackBps_, treasuryBps_);
    }

    /// @notice Set to the registry of coins launched elsewhere that may be bid on
    ///         (`PonsTokenRegistry`); the zero address takes the launchpad's own coins only.
    function setExternalRegistry(ITokenRegistry registry_) external onlyOwner {
        externalRegistry = registry_;
        emit ExternalRegistryUpdated(address(registry_));
    }

    /// @notice How an external coin's bid is split between the $OUTBID buyback and the treasury.
    function setExternalSplit(uint16 buybackBps_, uint16 treasuryBps_) external onlyOwner {
        _setExternalSplit(buybackBps_, treasuryBps_);
    }

    /// @notice Name the V4 pools `assetIn` is swapped to USDG through, in order: one pool pairing
    ///         it with USDG, or up to `MAX_ROUTE_HOPS` stepping to USDG through other currencies —
    ///         a share to ether, say, then ether to USDG. Ether is the zero address, paid in or on
    ///         the way; wrapped ether uses ether's route. USDG comes only at the end, and nothing
    ///         steps back through `assetIn`: either would leave a balance the settlement misses.
    function setRoute(address assetIn, PoolKeyV4[] calldata path) external onlyOwner {
        if (assetIn == address(usdg) || assetIn == weth) revert BadRoute(assetIn);
        if (path.length == 0 || path.length > MAX_ROUTE_HOPS) revert BadRoute(assetIn);
        address currency = assetIn;
        for (uint256 i = 0; i < path.length; i++) {
            PoolKeyV4 calldata key = path[i];
            if (key.currency0 >= key.currency1) revert BadRoute(assetIn);
            address next;
            if (key.currency0 == currency) next = key.currency1;
            else if (key.currency1 == currency) next = key.currency0;
            else revert BadRoute(assetIn);
            if ((next == address(usdg)) != (i == path.length - 1) || next == assetIn) revert BadRoute(assetIn);
            currency = next;
        }
        delete _routes[assetIn];
        for (uint256 i = 0; i < path.length; i++) {
            _routes[assetIn].push(path[i]);
        }
        emit RouteSet(assetIn, path);
    }

    function clearRoute(address assetIn) external onlyOwner {
        delete _routes[assetIn];
        emit RouteCleared(assetIn);
    }

    function setMinBid(uint256 minBid_) external onlyOwner {
        _setMinBid(minBid_);
    }

    function setOutbidIncrement(uint256 increment) external onlyOwner {
        _setOutbidIncrement(increment);
    }

    function _setDestinations(address buyback_, address treasury_) private {
        if (buyback_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        buyback = buyback_;
        treasury = treasury_;
        emit DestinationsUpdated(buyback_, treasury_);
    }

    function _setSplit(uint16 burnBps_, uint16 buybackBps_, uint16 treasuryBps_) private {
        uint256 total = uint256(burnBps_) + buybackBps_ + treasuryBps_;
        if (total != BPS) revert InvalidSplit(total);
        burnBps = burnBps_;
        buybackBps = buybackBps_;
        treasuryBps = treasuryBps_;
        emit SplitUpdated(burnBps_, buybackBps_, treasuryBps_);
    }

    function _setExternalSplit(uint16 buybackBps_, uint16 treasuryBps_) private {
        uint256 total = uint256(buybackBps_) + treasuryBps_;
        if (total != BPS) revert InvalidSplit(total);
        externalBuybackBps = buybackBps_;
        externalTreasuryBps = treasuryBps_;
        emit ExternalSplitUpdated(buybackBps_, treasuryBps_);
    }

    function _setMinBid(uint256 minBid_) private {
        minBid = minBid_;
        emit MinBidUpdated(minBid_);
    }

    function _setOutbidIncrement(uint256 increment) private {
        // Zero would let a bid of nothing take the top spot from a tie.
        if (increment == 0) revert InvalidIncrement(increment);
        outbidIncrement = increment;
        emit OutbidIncrementUpdated(increment);
    }
}
