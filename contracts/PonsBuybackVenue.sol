// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBuybackVenue} from "./interfaces/IBuybackVenue.sol";
import {IPonsV2BondingCurve, IPonsV2LaunchFactory} from "./interfaces/IPonsV2.sol";
import {
    BalanceDeltaV4,
    IPoolManagerV4,
    IUnlockCallbackV4,
    PoolKeyV4,
    SwapParamsV4
} from "./interfaces/IUniswapV4Minimal.sol";

/// @title Buyback venue for a token launched on PONS
/// @notice Buys a PONS V2 launch wherever it trades: on its bonding curve until the curve fills,
///         then in the full-range Uniswap V4 pool PONS graduates it into. Which one is read from
///         PONS on every buy, so the vault never has to be told the token graduated.
///
///         A launch trades in its pair asset — ether, or a token such as USDG. Revenue arrives in
///         other assets too, mostly ether, so an asset that is not the pair is first swapped into
///         it through a Uniswap V4 pool the owner names for that asset (`setRoute`), on the same
///         PoolManager PONS uses. In the pool phase both swaps happen in one session and only the
///         net amounts move; on the curve the route's output is spent on the curve straight
///         after.
///
///         The venue holds nothing between calls. What a buy does not spend — the curve's refund
///         on the last fill, or dust from a route — goes back to the caller.
///
///         It sets no price limit of its own. The caller's `minOut` is the bound: it reaches the
///         curve as its price bound, and the vault checks what actually arrived against it.
contract PonsBuybackVenue is IBuybackVenue, IUnlockCallbackV4, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BalanceDeltaV4 for int256;

    /// @dev PONS's `GraduationPhase.PoolCreated`.
    uint8 private constant PHASE_POOL_CREATED = 2;
    address private constant NATIVE = address(0);

    IPonsV2LaunchFactory public immutable pons;
    IPoolManagerV4 public immutable poolManager;
    /// @notice The hook every PONS pool is keyed with.
    address public immutable hook;

    /// @dev The V4 pool an asset is swapped through into a launch's pair asset.
    mapping(address assetIn => PoolKeyV4) private _routes;

    /// @dev One session with the PoolManager: an optional hop into the pair, an optional hop
    ///      from the pair into the launch token, and who receives the last output.
    struct Plan {
        address assetIn;
        uint256 amountIn;
        bool viaRoute;
        PoolKeyV4 route;
        bool viaPons;
        PoolKeyV4 ponsPool;
        address recipient;
    }

    event RouteSet(address indexed assetIn, address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks);
    event RouteCleared(address indexed assetIn);

    error ZeroAddress();
    error WrongValue(uint256 expected, uint256 sent);
    error NotLaunched(address token);
    error NotTradable(address token, uint8 phase);
    error NoRoute(address assetIn, address pair);
    error BadRoute(address assetIn);
    error UnexpectedCaller(address caller);
    error RefundFailed();

    constructor(address initialOwner, IPonsV2LaunchFactory pons_) Ownable(initialOwner) {
        if (address(pons_) == address(0)) revert ZeroAddress();
        pons = pons_;
        poolManager = IPoolManagerV4(pons_.poolManager());
        hook = pons_.memeHook();
        if (address(poolManager) == address(0) || hook == address(0)) revert ZeroAddress();
    }

    /// @notice Curve refunds and ether taken from the PoolManager land here on the way through.
    receive() external payable {}

    // ---------------------------------------------------------------- views

    /// @notice The V4 pool `assetIn` is swapped through into a pair; an empty key when unset.
    function routeOf(address assetIn) external view returns (PoolKeyV4 memory) {
        return _routes[assetIn];
    }

    // ------------------------------------------------------------------ buy

    /// @inheritdoc IBuybackVenue
    function buy(address assetIn, uint256 amountIn, address token, uint256 minOut, address recipient)
        external
        payable
        nonReentrant
        returns (uint256 bought)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (assetIn == NATIVE) {
            if (msg.value != amountIn) revert WrongValue(amountIn, msg.value);
        } else {
            if (msg.value != 0) revert WrongValue(0, msg.value);
            IERC20(assetIn).safeTransferFrom(msg.sender, address(this), amountIn);
        }

        IPonsV2LaunchFactory.LaunchedToken memory launch = pons.getLaunchedToken(token);
        if (!launch.exists || launch.token != token) revert NotLaunched(token);
        address pair = launch.pairToken;
        IPonsV2BondingCurve curve = IPonsV2BondingCurve(launch.curve);

        if (!curve.graduated() && curve.sellableTokens() > 0) {
            // The curve takes only its pair asset, so anything else is swapped into it first.
            uint256 pairIn = amountIn;
            if (assetIn != pair) {
                Plan memory hop = _plan(assetIn, amountIn, pair);
                hop.recipient = address(this);
                pairIn = abi.decode(poolManager.unlock(abi.encode(hop)), (uint256));
            }
            if (pair != NATIVE) IERC20(pair).forceApprove(address(curve), pairIn);
            bought = curve.buy{value: pair == NATIVE ? pairIn : 0}(pairIn, minOut, recipient);
            if (pair != NATIVE) IERC20(pair).forceApprove(address(curve), 0);
        } else if (launch.phase == PHASE_POOL_CREATED) {
            Plan memory plan = assetIn == pair ? _emptyPlan(assetIn, amountIn) : _plan(assetIn, amountIn, pair);
            plan.viaPons = true;
            plan.ponsPool = _ponsPool(pair, token, launch.poolFee, launch.tickSpacing);
            plan.recipient = recipient;
            bought = abi.decode(poolManager.unlock(abi.encode(plan)), (uint256));
        } else {
            // Swept but not yet pooled, or rescued: nowhere to buy until PONS finishes.
            revert NotTradable(token, launch.phase);
        }

        _refund(assetIn);
        if (pair != assetIn) _refund(pair);
    }

    /// @notice The PoolManager's session: every hop of the plan, then the net settlement.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert UnexpectedCaller(msg.sender);
        Plan memory plan = abi.decode(data, (Plan));

        address currency = plan.assetIn;
        uint256 amount = plan.amountIn;
        uint256 owed = plan.amountIn;
        uint256 leftover;
        address leftoverCurrency;

        if (plan.viaRoute) {
            uint256 used;
            (used, amount, currency) = _swapExactIn(plan.route, currency, amount);
            owed = used;
        }
        if (plan.viaPons) {
            (uint256 used, uint256 out, address outCurrency) = _swapExactIn(plan.ponsPool, currency, amount);
            if (plan.viaRoute) {
                // The route's output was the pool's input; any of it the pool did not take is ours.
                if (amount > used) (leftover, leftoverCurrency) = (amount - used, currency);
            } else {
                owed = used;
            }
            (amount, currency) = (out, outCurrency);
        }

        _settle(plan.assetIn, owed);
        if (leftover != 0) poolManager.take(leftoverCurrency, address(this), leftover);
        poolManager.take(currency, plan.recipient, amount);
        return abi.encode(amount);
    }

    // ---------------------------------------------------------------- admin

    /// @notice Name the V4 pool `assetIn` is swapped through into a launch's pair asset. The
    ///         pool must hold `assetIn`; that its other side is the pair is checked on each buy.
    function setRoute(address assetIn, PoolKeyV4 calldata key) external onlyOwner {
        if (key.currency0 >= key.currency1) revert BadRoute(assetIn);
        if (key.currency0 != assetIn && key.currency1 != assetIn) revert BadRoute(assetIn);
        _routes[assetIn] = key;
        emit RouteSet(assetIn, key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks);
    }

    function clearRoute(address assetIn) external onlyOwner {
        delete _routes[assetIn];
        emit RouteCleared(assetIn);
    }

    // ------------------------------------------------------------- internal

    function _emptyPlan(address assetIn, uint256 amountIn) private pure returns (Plan memory plan) {
        plan.assetIn = assetIn;
        plan.amountIn = amountIn;
    }

    /// @dev A plan whose first hop swaps `assetIn` into `pair` through the asset's route.
    function _plan(address assetIn, uint256 amountIn, address pair) private view returns (Plan memory plan) {
        PoolKeyV4 memory route = _routes[assetIn];
        (address lower, address upper) = assetIn < pair ? (assetIn, pair) : (pair, assetIn);
        if (route.currency0 == address(0) && route.currency1 == address(0)) revert NoRoute(assetIn, pair);
        if (route.currency0 != lower || route.currency1 != upper) revert NoRoute(assetIn, pair);
        plan = _emptyPlan(assetIn, amountIn);
        plan.viaRoute = true;
        plan.route = route;
    }

    function _ponsPool(address pair, address token, uint24 fee, int24 tickSpacing) private view returns (PoolKeyV4 memory) {
        (address currency0, address currency1) = pair < token ? (pair, token) : (token, pair);
        return PoolKeyV4({currency0: currency0, currency1: currency1, fee: fee, tickSpacing: tickSpacing, hooks: hook});
    }

    /// @dev An exact-input swap limited by nothing but its amount. Returns what it took, what it
    ///      gave, and in what.
    function _swapExactIn(PoolKeyV4 memory key, address currencyIn, uint256 amount)
        private
        returns (uint256 used, uint256 out, address currencyOut)
    {
        bool zeroForOne = currencyIn == key.currency0;
        int256 delta = poolManager.swap(
            key,
            SwapParamsV4({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? BalanceDeltaV4.MIN_SQRT_PRICE + 1 : BalanceDeltaV4.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 inDelta, int128 outDelta) = zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        used = uint256(uint128(-inDelta));
        out = uint256(uint128(outDelta));
        currencyOut = zeroForOne ? key.currency1 : key.currency0;
    }

    /// @dev Pay the PoolManager what the session owes it in `currency`.
    function _settle(address currency, uint256 amount) private {
        if (amount == 0) return;
        if (currency == NATIVE) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(currency);
            IERC20(currency).safeTransfer(address(poolManager), amount);
            poolManager.settle();
        }
    }

    /// @dev Everything the venue holds of `asset` goes back to the caller: it holds nothing of
    ///      its own between calls.
    function _refund(address asset) private {
        if (asset == NATIVE) {
            uint256 balance = address(this).balance;
            if (balance == 0) return;
            (bool ok, ) = payable(msg.sender).call{value: balance}("");
            if (!ok) revert RefundFailed();
        } else {
            uint256 balance = IERC20(asset).balanceOf(address(this));
            if (balance != 0) IERC20(asset).safeTransfer(msg.sender, balance);
        }
    }
}
