// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUniswapV3FactoryMinimal, IUniswapV3PoolMinimal} from "./interfaces/IUniswapV3Minimal.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

/// @title outbidfun.lol liquidity manager
/// @notice Lets anyone provide liquidity to any pool on the platform's Uniswap V3, and take it
///         back out.
///
///         The pools are ordinary Uniswap V3 pools: `mint` is open to any contract that can
///         answer the mint callback. What the platform did not have was something to answer
///         it. The listing manager mints one full-range position at graduation and holds it
///         forever, so it needed no position accounting and got none, and `NonfungiblePosition-
///         Manager` was never vendored. This is the smaller thing that was missing.
///
///         A pool is named by its two tokens and its fee tier, and found on the factory. Every
///         pool here pairs a token with the asset it was priced in — an ether, a dollar, a
///         tokenised share — so the pair is spelled out rather than assumed. Reading the factory
///         is deliberately wider than the launchpad's own `poolOf`, which only knows about coins
///         that graduated: OUTBID's pool is created straight on the factory and `poolOf` cannot
///         see it. It is no less bounded, because the factory only lets its owner create pools
///         — the set is still exactly the pools this platform opened.
///
///         It is not an NFT. A position is the tuple (owner, token, quote, fee, tickLower,
///         tickUpper), and it is not transferable — you withdraw, the other party deposits.
///         That keeps the contract small enough to read in one sitting, which matters more here
///         than trading positions on a secondary market that does not exist.
///
///         Positions in the same range share one position inside the pool, the one this
///         contract owns. Their fees are split by the same feeGrowthInside arithmetic Uniswap's
///         own position manager uses: each depositor records the fees-per-unit-of-liquidity the
///         range had earned when they arrived, and is owed the growth since, times their share.
///
///         The protocol's own graduation liquidity is not here and cannot be withdrawn through
///         this contract: it belongs to the listing manager, which has no function that takes
///         it out. What you add here is yours; what the curve raised stays locked.
contract LiquidityManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Pass this on a side of `quoteAdd` you are not constraining.
    uint256 public constant UNCONSTRAINED = type(uint256).max;

    IUniswapV3FactoryMinimal public immutable uniswapV3Factory;

    /// @notice One depositor's stake in one range.
    struct Position {
        address owner;
        address token;
        /// @dev The other side of the pair: the asset the token is priced in.
        address quote;
        /// @dev The pool's fee tier, which is part of what identifies the pool and so the
        ///      position: one pair can have a pool at more than one tier.
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    mapping(bytes32 id => Position) private _positions;
    /// @dev Every open position an address holds, so the site can list them without an indexer.
    mapping(address owner => bytes32[] ids) private _idsOf;
    /// @dev Where an id sits in `_idsOf[owner]`, one-based so zero means "not held".
    mapping(bytes32 id => uint256 slot) private _slotOf;

    event LiquidityAdded(
        address indexed owner,
        address indexed token,
        address quote,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 quoteAmount,
        uint256 tokenAmount
    );
    event LiquidityRemoved(
        address indexed owner,
        address indexed token,
        address quote,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 quoteAmount,
        uint256 tokenAmount
    );
    event FeesCollected(
        address indexed owner,
        address indexed token,
        address quote,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint256 quoteAmount,
        uint256 tokenAmount
    );

    error ZeroAddress();
    error NoPool(address token, address quote, uint24 fee);
    error UnexpectedCaller(address caller);
    error DeadlinePassed(uint256 deadline);
    error BadRange(int24 tickLower, int24 tickUpper);
    error NothingToAdd();
    error RangeDoesNotTake(bool quote);
    error NoPosition();
    error MoreThanHeld(uint128 requested, uint128 held);
    error TooLittleReceived(uint256 quoteAmount, uint256 tokenAmount);

    constructor(IUniswapV3FactoryMinimal factory_) {
        if (address(factory_) == address(0)) revert ZeroAddress();
        uniswapV3Factory = factory_;
    }

    modifier before(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlinePassed(deadline);
        _;
    }

    // ----------------------------------------------------------------- views

    /// @notice A position's handle. Ranges are shared, so the owner is part of the identity.
    function positionId(
        address owner,
        address token,
        address quote,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, token, quote, fee, tickLower, tickUpper));
    }

    /// @notice Every position `owner` still holds, newest last.
    function positionsOf(address owner) external view returns (Position[] memory list) {
        bytes32[] storage ids = _idsOf[owner];
        list = new Position[](ids.length);
        for (uint256 index = 0; index < ids.length; index++) list[index] = _positions[ids[index]];
    }

    function positionAt(bytes32 id) external view returns (Position memory) {
        return _positions[id];
    }

    /// @notice The widest range a pool allows, which is the range the protocol's own graduation
    ///         position uses.
    function fullRange(address token, address quote, uint24 fee) external view returns (int24 lower, int24 upper) {
        return PoolMath.fullRange(_pool(token, quote, fee).tickSpacing());
    }

    /// @notice What a position is worth right now: its share of the pool's two tokens, and the
    ///         fees it has earned but not collected. Quote side first.
    ///
    ///         The fee figures are read from the pool's tick counters rather than from what it
    ///         has already credited, so they are current to this block without anyone having to
    ///         poke the position first.
    function positionValue(
        bytes32 id
    ) public view returns (uint256 quoteAmount, uint256 tokenAmount, uint256 quoteFees, uint256 tokenFees) {
        Position storage position = _positions[id];
        if (position.owner == address(0)) return (0, 0, 0, 0);

        IUniswapV3PoolMinimal pool = _pool(position.token, position.quote, position.fee);
        bool isToken0 = position.token < position.quote;

        uint256 amount0;
        uint256 amount1;
        if (position.liquidity > 0) {
            (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
            (amount0, amount1) = PoolMath.amountsForLiquidity(
                sqrtPriceX96,
                PoolMath.getSqrtRatioAtTick(position.tickLower),
                PoolMath.getSqrtRatioAtTick(position.tickUpper),
                position.liquidity,
                false
            );
        }

        (uint256 fees0, uint256 fees1) = _uncollected(pool, position);
        (quoteAmount, tokenAmount) = isToken0 ? (amount1, amount0) : (amount0, amount1);
        (quoteFees, tokenFees) = isToken0 ? (fees1, fees0) : (fees0, fees1);
    }

    /// @notice Which of the two tokens a range takes at the pool's current price.
    ///
    ///         A band above the price is bought with the token alone and a band below it with
    ///         the quote alone — the position is entirely on one side of the market until the
    ///         price comes to it. A band around the price takes both.
    function rangeNeeds(
        address token,
        address quote,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper
    ) public view returns (bool needsQuote, bool needsToken) {
        IUniswapV3PoolMinimal pool = _pool(token, quote, fee);
        _checkRange(pool, tickLower, tickUpper);
        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
        return _rangeNeeds(sqrtPriceX96, tickLower, tickUpper, token < quote);
    }

    /// @notice What a deposit buys in `[tickLower, tickUpper]`, and what it costs on both sides.
    ///
    ///         Pass `UNCONSTRAINED` on the side you are not constraining and the other side
    ///         alone decides the size. That is how the page fills in whichever box you did not
    ///         type in: type the quote and the token figure follows, type tokens and the quote does.
    ///
    ///         Sizing by a token the range does not take has no answer — any amount of the quote
    ///         buys an unlimited amount of a token-only band — so that reverts rather than
    ///         returning a number. Ask `rangeNeeds` first, which tells the page which box to offer.
    function quoteAdd(
        address token,
        address quote,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint256 quoteAvailable,
        uint256 tokenAvailable
    ) external view returns (uint128 liquidity, uint256 quoteNeeded, uint256 tokenNeeded) {
        IUniswapV3PoolMinimal pool = _pool(token, quote, fee);
        _checkRange(pool, tickLower, tickUpper);
        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
        bool isToken0 = token < quote;

        _requireSizable(sqrtPriceX96, tickLower, tickUpper, isToken0, quoteAvailable, tokenAvailable);
        return _quote(
            sqrtPriceX96,
            tickLower,
            tickUpper,
            isToken0 ? tokenAvailable : quoteAvailable,
            isToken0 ? quoteAvailable : tokenAvailable,
            isToken0
        );
    }

    /// @dev token0 pays for the part of a range above the price, token1 for the part below it.
    function _rangeNeeds(
        uint160 sqrtP,
        int24 tickLower,
        int24 tickUpper,
        bool isToken0
    ) private pure returns (bool needsQuote, bool needsToken) {
        bool needs0 = sqrtP < PoolMath.getSqrtRatioAtTick(tickUpper);
        bool needs1 = sqrtP > PoolMath.getSqrtRatioAtTick(tickLower);
        return isToken0 ? (needs1, needs0) : (needs0, needs1);
    }

    /// @dev Refuses a quote whose only constraint is a token the range will not take.
    function _requireSizable(
        uint160 sqrtP,
        int24 tickLower,
        int24 tickUpper,
        bool isToken0,
        uint256 quoteAvailable,
        uint256 tokenAvailable
    ) private pure {
        (bool needsQuote, bool needsToken) = _rangeNeeds(sqrtP, tickLower, tickUpper, isToken0);
        if (quoteAvailable != UNCONSTRAINED && !needsQuote && tokenAvailable == UNCONSTRAINED) {
            revert RangeDoesNotTake(true);
        }
        if (tokenAvailable != UNCONSTRAINED && !needsToken && quoteAvailable == UNCONSTRAINED) {
            revert RangeDoesNotTake(false);
        }
    }

    function _quote(
        uint160 sqrtP,
        int24 tickLower,
        int24 tickUpper,
        uint256 available0,
        uint256 available1,
        bool isToken0
    ) private pure returns (uint128 liquidity, uint256 quoteNeeded, uint256 tokenNeeded) {
        // The liquidity formulas multiply the amount by a Q96 ratio, so an unbounded sentinel
        // would overflow the uint128 they return. No real balance reaches this ceiling: the
        // largest supply any token here can have is far below it.
        if (available0 > type(uint128).max) available0 = type(uint128).max;
        if (available1 > type(uint128).max) available1 = type(uint128).max;

        uint160 sqrtA = PoolMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtB = PoolMath.getSqrtRatioAtTick(tickUpper);
        liquidity = PoolMath.liquidityForAmounts(sqrtP, sqrtA, sqrtB, available0, available1);
        liquidity = _fit(sqrtP, sqrtA, sqrtB, liquidity, available0, available1);

        (uint256 amount0, uint256 amount1) =
            PoolMath.amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity, true);
        (quoteNeeded, tokenNeeded) = isToken0 ? (amount1, amount0) : (amount0, amount1);
    }

    // ------------------------------------------------------------- liquidity

    struct AddParams {
        address token;
        address quote;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        /// @dev The most of each side the caller has approved to this contract. What the
        ///      position does not use never leaves the wallet.
        uint256 quoteDesired;
        uint256 tokenDesired;
        /// @dev The least of each side the caller accepts spending, against the price moving.
        uint256 quoteMin;
        uint256 tokenMin;
        uint256 deadline;
    }

    /// @notice Put both sides of a pair into a pool. Nothing is sent ahead: the pool takes what
    ///         the position costs straight from the wallet, up to the two ceilings, and no more.
    function addLiquidity(
        AddParams calldata params
    )
        external
        nonReentrant
        before(params.deadline)
        returns (uint128 liquidity, uint256 quoteAmount, uint256 tokenAmount)
    {
        IUniswapV3PoolMinimal pool = _pool(params.token, params.quote, params.fee);
        _checkRange(pool, params.tickLower, params.tickUpper);

        liquidity = _size(pool, params);
        if (liquidity == 0) revert NothingToAdd();

        (quoteAmount, tokenAmount) = _mint(pool, params, liquidity);
        if (quoteAmount < params.quoteMin || tokenAmount < params.tokenMin) {
            revert TooLittleReceived(quoteAmount, tokenAmount);
        }

        _record(pool, params, liquidity);

        emit LiquidityAdded(
            msg.sender,
            params.token,
            params.quote,
            params.fee,
            params.tickLower,
            params.tickUpper,
            liquidity,
            quoteAmount,
            tokenAmount
        );
    }

    /// @dev The liquidity the two amounts offered both cover at the pool's price.
    function _size(IUniswapV3PoolMinimal pool, AddParams calldata params) private view returns (uint128) {
        (uint256 amount0Desired, uint256 amount1Desired) = params.token < params.quote
            ? (params.tokenDesired, params.quoteDesired)
            : (params.quoteDesired, params.tokenDesired);
        (uint160 sqrtPriceX96, , , , , , ) = pool.slot0();
        uint160 sqrtA = PoolMath.getSqrtRatioAtTick(params.tickLower);
        uint160 sqrtB = PoolMath.getSqrtRatioAtTick(params.tickUpper);
        uint128 liquidity =
            PoolMath.liquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, amount0Desired, amount1Desired);
        return _fit(sqrtPriceX96, sqrtA, sqrtB, liquidity, amount0Desired, amount1Desired);
    }

    /// @dev Trims liquidity until what the pool will charge for it fits inside what the caller
    ///      approved.
    ///
    ///      Defensive, not observed. Sizing rounds down and charging rounds up, and on the token0
    ///      side the two are not exact inverses — the liquidity formula floors an intermediate
    ///      product — so in principle the mint can ask the callback for a unit more than was
    ///      offered, which would fail on the transfer rather than anywhere informative. No
    ///      amount tried reproduces it: 160 adds across both token orderings, straddling and
    ///      single-sided ranges, all fit on the first check. The listing manager carries the same
    ///      step-down, so this keeps the two consistent rather than leaving one of them to find
    ///      out. In the normal case the loop tests once and breaks.
    ///
    ///      Bounded rather than open-ended: on a range narrow enough that one unit of liquidity
    ///      costs under a unit of either token, walking down one unit at a time would not
    ///      converge. Coming out still over budget is fine — the mint reverts, which is the
    ///      honest outcome for a position that cannot be paid for.
    function _fit(
        uint160 sqrtP,
        uint160 sqrtA,
        uint160 sqrtB,
        uint128 liquidity,
        uint256 available0,
        uint256 available1
    ) private pure returns (uint128) {
        for (uint256 step = 0; step < 128 && liquidity > 0; step++) {
            (uint256 amount0, uint256 amount1) =
                PoolMath.amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity, true);
            if (amount0 <= available0 && amount1 <= available1) break;
            liquidity -= 1;
        }
        return liquidity;
    }

    /// @dev Mints into the pool and reports what it charged, quote side first.
    function _mint(
        IUniswapV3PoolMinimal pool,
        AddParams calldata params,
        uint128 liquidity
    ) private returns (uint256 quoteAmount, uint256 tokenAmount) {
        (uint256 amount0, uint256 amount1) = pool.mint(
            address(this),
            params.tickLower,
            params.tickUpper,
            liquidity,
            abi.encode(params.token, params.quote, params.fee, msg.sender)
        );
        return params.token < params.quote ? (amount1, amount0) : (amount0, amount1);
    }

    /// @dev Opens the caller's position if this is their first deposit in the range, then adds
    ///      the new liquidity to it.
    function _record(IUniswapV3PoolMinimal pool, AddParams calldata params, uint128 liquidity) private {
        bytes32 id = positionId(
            msg.sender, params.token, params.quote, params.fee, params.tickLower, params.tickUpper
        );
        Position storage position = _positions[id];
        if (position.owner == address(0)) {
            position.owner = msg.sender;
            position.token = params.token;
            position.quote = params.quote;
            position.fee = params.fee;
            position.tickLower = params.tickLower;
            position.tickUpper = params.tickUpper;
            _idsOf[msg.sender].push(id);
            _slotOf[id] = _idsOf[msg.sender].length;
        }
        // The mint has just brought the pool's fee counters up to date, so this credits every
        // fee the existing liquidity earned before the new liquidity dilutes the share.
        _creditFees(pool, position);
        position.liquidity += liquidity;
    }

    struct RemoveParams {
        address token;
        address quote;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        /// @dev How much of the position to take out. Fees always come out in full.
        uint128 liquidity;
        uint256 quoteMin;
        uint256 tokenMin;
        uint256 deadline;
    }

    /// @notice Take liquidity back out, with everything it has earned.
    function removeLiquidity(
        RemoveParams calldata params
    )
        external
        nonReentrant
        before(params.deadline)
        returns (uint256 quoteAmount, uint256 tokenAmount)
    {
        bytes32 id = positionId(
            msg.sender, params.token, params.quote, params.fee, params.tickLower, params.tickUpper
        );
        Position storage position = _positions[id];
        if (position.owner == address(0)) revert NoPosition();

        IUniswapV3PoolMinimal pool = _pool(params.token, params.quote, params.fee);
        _burn(pool, position, params);

        return _payOut(pool, id, position, msg.sender);
    }

    /// @dev Burns the caller's share out of the shared position and moves the principal, along
    ///      with the fees the burn brought up to date, into what this position is owed.
    function _burn(
        IUniswapV3PoolMinimal pool,
        Position storage position,
        RemoveParams calldata params
    ) private {
        if (params.liquidity == 0 || params.liquidity > position.liquidity) {
            revert MoreThanHeld(params.liquidity, position.liquidity);
        }

        // Burning updates the pool's fee counters, so credit against the state it leaves.
        (uint256 amount0, uint256 amount1) = pool.burn(params.tickLower, params.tickUpper, params.liquidity);
        _creditFees(pool, position);
        position.liquidity -= params.liquidity;
        position.tokensOwed0 += uint128(amount0);
        position.tokensOwed1 += uint128(amount1);

        (uint256 principalQuote, uint256 principalToken) =
            params.token < params.quote ? (amount1, amount0) : (amount0, amount1);
        if (principalQuote < params.quoteMin || principalToken < params.tokenMin) {
            revert TooLittleReceived(principalQuote, principalToken);
        }

        emit LiquidityRemoved(
            msg.sender,
            params.token,
            params.quote,
            params.fee,
            params.tickLower,
            params.tickUpper,
            params.liquidity,
            principalQuote,
            principalToken
        );
    }

    /// @notice Sweep a position's fees without touching the liquidity.
    function collect(
        address token,
        address quote,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper
    ) external nonReentrant returns (uint256 quoteAmount, uint256 tokenAmount) {
        bytes32 id = positionId(msg.sender, token, quote, fee, tickLower, tickUpper);
        Position storage position = _positions[id];
        if (position.owner == address(0)) revert NoPosition();

        IUniswapV3PoolMinimal pool = _pool(token, quote, fee);
        // A zero burn is how the pool is asked to bring this range's earnings up to date.
        if (position.liquidity > 0) pool.burn(tickLower, tickUpper, 0);
        _creditFees(pool, position);

        (quoteAmount, tokenAmount) = _payOut(pool, id, position, msg.sender);
    }

    /// @notice Pool callback: pays for the position being minted, out of the depositor's wallet.
    ///         A pool only calls back the account that called `mint`, and the caller must be
    ///         the very pool the factory returns for the pair in the callback data.
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        (address token, address quote, uint24 fee, address payer) =
            abi.decode(data, (address, address, uint24, address));
        if (msg.sender != uniswapV3Factory.getPool(token, quote, fee) || msg.sender == address(0)) {
            revert UnexpectedCaller(msg.sender);
        }

        (address token0, address token1) = token < quote ? (token, quote) : (quote, token);
        if (amount0Owed > 0) IERC20(token0).safeTransferFrom(payer, msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(token1).safeTransferFrom(payer, msg.sender, amount1Owed);
    }

    // -------------------------------------------------------------- internal

    /// @dev The platform's pool for a pair, or a revert. Reading the factory rather than the
    ///      listing manager's `poolOf` is what makes every pool on this deployment reachable and
    ///      not just the graduated coins': OUTBID's own pool is created straight on the factory and
    ///      is invisible to `poolOf`. It is no less bounded — the factory only lets its owner
    ///      create pools, so the set is still exactly the pools this platform opened.
    function _pool(address token, address quote, uint24 fee) private view returns (IUniswapV3PoolMinimal) {
        if (token == quote) revert NoPool(token, quote, fee);
        address pool = uniswapV3Factory.getPool(token, quote, fee);
        if (pool == address(0)) revert NoPool(token, quote, fee);
        return IUniswapV3PoolMinimal(pool);
    }

    function _checkRange(IUniswapV3PoolMinimal pool, int24 tickLower, int24 tickUpper) private view {
        int24 spacing = pool.tickSpacing();
        if (
            tickLower >= tickUpper ||
            tickLower < PoolMath.MIN_TICK ||
            tickUpper > PoolMath.MAX_TICK ||
            tickLower % spacing != 0 ||
            tickUpper % spacing != 0
        ) revert BadRange(tickLower, tickUpper);
    }

    /// @dev This contract's own position inside a pool, which every depositor in the range shares.
    function _poolKey(Position storage position) private view returns (bytes32) {
        return keccak256(abi.encodePacked(address(this), position.tickLower, position.tickUpper));
    }

    /// @dev The fees the pool has already credited to the shared position but this depositor has
    ///      not been given a share of yet. Only correct straight after a mint or burn, which is
    ///      the only place it is called.
    function _creditFees(IUniswapV3PoolMinimal pool, Position storage position) private {
        (, uint256 inside0X128, uint256 inside1X128, , ) = pool.positions(_poolKey(position));
        if (position.liquidity > 0) {
            position.tokensOwed0 += PoolMath.feesEarned(inside0X128, position.feeGrowthInside0LastX128, position.liquidity);
            position.tokensOwed1 += PoolMath.feesEarned(inside1X128, position.feeGrowthInside1LastX128, position.liquidity);
        }
        position.feeGrowthInside0LastX128 = inside0X128;
        position.feeGrowthInside1LastX128 = inside1X128;
    }

    /// @dev What a position has earned, counted from the pool's tick state so no poke is needed.
    function _uncollected(
        IUniswapV3PoolMinimal pool,
        Position storage position
    ) private view returns (uint256 fees0, uint256 fees1) {
        fees0 = position.tokensOwed0;
        fees1 = position.tokensOwed1;
        if (position.liquidity == 0) return (fees0, fees1);

        (, int24 tickCurrent, , , , , ) = pool.slot0();
        bool aboveLower = tickCurrent >= position.tickLower;
        bool belowUpper = tickCurrent < position.tickUpper;
        (, , uint256 lower0, uint256 lower1, , , , ) = pool.ticks(position.tickLower);
        (, , uint256 upper0, uint256 upper1, , , , ) = pool.ticks(position.tickUpper);

        fees0 += PoolMath.feesEarned(
            PoolMath.feeGrowthInside(pool.feeGrowthGlobal0X128(), lower0, upper0, aboveLower, belowUpper),
            position.feeGrowthInside0LastX128,
            position.liquidity
        );
        fees1 += PoolMath.feesEarned(
            PoolMath.feeGrowthInside(pool.feeGrowthGlobal1X128(), lower1, upper1, aboveLower, belowUpper),
            position.feeGrowthInside1LastX128,
            position.liquidity
        );
    }

    /// @dev Pay this position's owed tokens out of the shared pool position, straight from the
    ///      pool to `recipient`, then forget the position if nothing is left in it. Paid direct
    ///      rather than through this contract: a reward coin takes its fee on the way out of the
    ///      pool, and a second hop through here would take it twice — or come up short and revert.
    function _payOut(
        IUniswapV3PoolMinimal pool,
        bytes32 id,
        Position storage position,
        address recipient
    ) private returns (uint256 quoteAmount, uint256 tokenAmount) {
        uint128 owed0 = position.tokensOwed0;
        uint128 owed1 = position.tokensOwed1;
        address token = position.token;
        address quote = position.quote;

        if (owed0 > 0 || owed1 > 0) {
            position.tokensOwed0 = 0;
            position.tokensOwed1 = 0;
            (uint128 got0, uint128 got1) = pool.collect(
                recipient,
                position.tickLower,
                position.tickUpper,
                owed0,
                owed1
            );
            (tokenAmount, quoteAmount) = token < quote ? (uint256(got0), uint256(got1)) : (uint256(got1), uint256(got0));
        }

        emit FeesCollected(
            recipient,
            token,
            quote,
            position.fee,
            position.tickLower,
            position.tickUpper,
            quoteAmount,
            tokenAmount
        );

        if (position.liquidity == 0) _forget(id, position);
    }

    /// @dev Drop an emptied position out of its owner's list, by moving the last one into its
    ///      slot so the list stays gap-free.
    function _forget(bytes32 id, Position storage position) private {
        address owner = position.owner;
        bytes32[] storage ids = _idsOf[owner];
        uint256 slot = _slotOf[id];
        if (slot == 0) return;

        bytes32 last = ids[ids.length - 1];
        ids[slot - 1] = last;
        _slotOf[last] = slot;
        ids.pop();
        delete _slotOf[id];
        delete _positions[id];
    }
}
