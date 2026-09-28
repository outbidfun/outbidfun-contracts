// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICoinListingManager, ICoinReserve, IFeeEscrow} from "./interfaces/ICoinListingManager.sol";
import {ITokenRegistry} from "./interfaces/ITokenRegistry.sol";
import {IUniswapV3FactoryMinimal, IUniswapV3PoolMinimal} from "./interfaces/IUniswapV3Minimal.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

/// @title outbidfun.lol listing manager
/// @notice Takes a coin from the bonding curve into the platform's own Uniswap V3 pool, paired
///         with the asset the coin was priced in.
///
///         This contract owns the Uniswap V3 factory, and the factory only lets its owner
///         create pools. So a coin has no pool until the moment its curve fills, and nobody
///         can create or price one ahead of time (audit F-01, F-15). The two factory admin
///         calls are passed through below.
///
///         At graduation the coin sends the curve's reserve and the price it reached; this
///         contract opens the pool at that price, and puts the whole reserve and freshly minted
///         coins into one full-range position it owns. Nothing is taken at graduation: every fee
///         the protocol earns on a coin is charged per trade. Nothing here can remove that
///         position, so the liquidity is locked for good. The swap fees it earns are shared the
///         way the coin's trading fee is — the protocol's share to the treasury, the creator's
///         to their escrow balance — and anyone may sweep them with `collectFees`.
///
///         The owner may also open a pool between two assets that are not coins — a bridge
///         between quote assets, with `openBridgePool` — so a route can cross between two
///         coins priced in different assets. Bridge pools are ordinary: LPed like any other
///         pool through `LiquidityManager`, no locked position, and untracked by `poolOf`.
contract CoinListingManager is ICoinListingManager, Ownable {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;

    IUniswapV3FactoryMinimal public immutable uniswapV3Factory;
    /// @notice Where the protocol's share of every fee is paid: the revenue router, once it
    ///         exists, or the treasury until then. Every coin and the factory read it per payment.
    address public override treasury;
    /// @notice Where the creator's share of pool fees is credited for them to claim.
    IFeeEscrow public immutable feeEscrow;

    /// @notice Fee tier for new pools, in hundredths of a basis point (10000 = 1%).
    uint24 public poolFee;
    /// @notice The launchpad whose coins may graduate here. Set once.
    ITokenRegistry public coinFactory;

    /// @inheritdoc ICoinListingManager
    mapping(address coin => address pool) public override poolOf;
    /// @notice The other side of a graduated coin's pool: the asset its curve was priced in.
    mapping(address coin => address quote) public quoteOf;

    event PoolOpened(address indexed coin, address indexed pool, address quote, uint24 fee, uint160 sqrtPriceX96);
    event MemeCoinListed(
        address indexed memecoin,
        address indexed pool,
        address quote,
        uint128 liquidity,
        uint256 quoteIn,
        uint256 coinIn
    );
    /// @notice Pool fees swept: how much of each side went to the protocol, and to the creator.
    event FeesCollected(
        address indexed coin,
        uint256 quoteToProtocol,
        uint256 coinToProtocol,
        uint256 quoteToCreator,
        uint256 coinToCreator
    );
    event PoolFeeUpdated(uint24 fee);
    event CoinFactorySet(address indexed coinFactory);
    event TreasuryUpdated(address indexed treasury);
    /// @notice A pool opened between two assets, neither a coin this platform launched — a
    ///         bridge, not a graduation.
    event BridgePoolOpened(address indexed tokenA, address indexed tokenB, uint24 fee, address pool, uint160 sqrtPriceX96);

    error ZeroAddress();
    error CoinFactoryAlreadySet();
    error FeeTierNotEnabled(uint24 fee);
    error UnknownCoin(address coin);
    error AlreadyListed(address coin);
    error NotListed(address coin);
    error UnexpectedCaller(address caller);
    error InsufficientTokens(uint256 required, uint256 provided);
    error InsufficientQuote(uint256 required, uint256 provided);
    error BridgeSameAsset(address token);
    error BridgeIsCoin(address token);
    error PoolAlreadyOpen(address tokenA, address tokenB, uint24 fee);

    constructor(
        address initialOwner,
        address treasury_,
        IUniswapV3FactoryMinimal factory_,
        IFeeEscrow feeEscrow_,
        uint24 poolFee_
    ) Ownable(initialOwner) {
        if (treasury_ == address(0) || address(factory_) == address(0) || address(feeEscrow_) == address(0)) {
            revert ZeroAddress();
        }
        if (factory_.feeAmountTickSpacing(poolFee_) == 0) revert FeeTierNotEnabled(poolFee_);
        treasury = treasury_;
        uniswapV3Factory = factory_;
        feeEscrow = feeEscrow_;
        poolFee = poolFee_;
        emit PoolFeeUpdated(poolFee_);
        emit TreasuryUpdated(treasury_);
    }

    // ---------------------------------------------------------------- views

    /// @notice The position a graduated coin holds: the full range of its pool.
    function positionTicks(address coin) public view returns (int24 lower, int24 upper) {
        address pool = poolOf[coin];
        if (pool == address(0)) revert NotListed(coin);
        return PoolMath.fullRange(IUniswapV3PoolMinimal(pool).tickSpacing());
    }

    /// @inheritdoc ICoinListingManager
    function tokensForListing(
        address coin,
        uint256 cap,
        uint256 price
    ) external view override returns (uint256) {
        (, uint256 coinAmount, , ) = _listingAmounts(coin, ICoinReserve(coin).reserveToken(), cap, price);
        return coinAmount;
    }

    // --------------------------------------------------------- graduation

    /// @inheritdoc ICoinListingManager
    function listMemeCoin(uint256 amountToken, uint256 amountQuote, uint256 price) external override {
        address coin = msg.sender;
        // The factory answers by calling the coin, so ask only about contracts (audit F-09).
        if (coin.code.length == 0 || address(coinFactory) == address(0) || !coinFactory.isMemeCoinLegit(coin)) {
            revert UnknownCoin(coin);
        }
        if (poolOf[coin] != address(0)) revert AlreadyListed(coin);

        address quote = ICoinReserve(coin).reserveToken();
        uint256 held = IERC20(quote).balanceOf(address(this));
        if (held < amountQuote) revert InsufficientQuote(amountQuote, held);

        (uint128 liquidity, uint256 coinAmount, uint256 quoteAmount, uint160 sqrtPriceX96) =
            _listingAmounts(coin, quote, amountQuote, price);
        if (amountToken < coinAmount) revert InsufficientTokens(coinAmount, amountToken);

        address pool = uniswapV3Factory.createPool(coin, quote, poolFee);
        IUniswapV3PoolMinimal(pool).initialize(sqrtPriceX96);
        poolOf[coin] = pool;
        quoteOf[coin] = quote;
        emit PoolOpened(coin, pool, quote, poolFee, sqrtPriceX96);

        (int24 lower, int24 upper) = PoolMath.fullRange(IUniswapV3PoolMinimal(pool).tickSpacing());
        IUniswapV3PoolMinimal(pool).mint(address(this), lower, upper, liquidity, abi.encode(coin));

        // The unit or two the position's rounding could not use. Nothing else is held back.
        uint256 dust = IERC20(quote).balanceOf(address(this));
        if (dust > 0) IERC20(quote).safeTransfer(treasury, dust);

        emit MemeCoinListed(coin, pool, quote, liquidity, quoteAmount, coinAmount);
    }

    /// @notice Pool callback: pays the pool what the position costs. Only a pool this contract
    ///         opened can call it, and a pool only calls back the account that is minting.
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        address coin = abi.decode(data, (address));
        address pool = poolOf[coin];
        if (pool == address(0) || msg.sender != pool) revert UnexpectedCaller(msg.sender);

        address quote = quoteOf[coin];
        (address token0, address token1) = coin < quote ? (coin, quote) : (quote, coin);
        if (amount0Owed > 0) IERC20(token0).safeTransfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(token1).safeTransfer(msg.sender, amount1Owed);
    }

    /// @notice Sweep the swap fees the graduation position has earned, on both sides of the
    ///         pair, and share them the way the coin's own trading fee is shared: the protocol's
    ///         share to the treasury, the rest credited to the creator's escrow balance. Anyone
    ///         may call.
    function collectFees(address coin) external returns (uint256 quoteAmount, uint256 coinAmount) {
        address pool = poolOf[coin];
        if (pool == address(0)) revert NotListed(coin);

        (int24 lower, int24 upper) = positionTicks(coin);
        // A zero burn brings the fees earned so far into the position's owed balances.
        IUniswapV3PoolMinimal(pool).burn(lower, upper, 0);
        (uint128 got0, uint128 got1) = IUniswapV3PoolMinimal(pool).collect(
            address(this),
            lower,
            upper,
            type(uint128).max,
            type(uint128).max
        );
        address quote = quoteOf[coin];
        (quoteAmount, coinAmount) = coin < quote ? (uint256(got1), uint256(got0)) : (uint256(got0), uint256(got1));

        // The split the coin fixed at launch, read from the coin so a later change to the
        // factory's terms never touches a coin already trading.
        uint256 shareBps = ICoinReserve(coin).protocolShareBps();
        address creator = ICoinReserve(coin).creatorFeeRecipient();
        (uint256 quoteToProtocol, uint256 quoteToCreator) = _share(quote, quoteAmount, shareBps, creator);
        (uint256 coinToProtocol, uint256 coinToCreator) = _share(coin, coinAmount, shareBps, creator);

        emit FeesCollected(coin, quoteToProtocol, coinToProtocol, quoteToCreator, coinToCreator);
    }

    /// @dev Pays the protocol's share of `amount` of `token` to the treasury and credits the rest
    ///      to `creator` in the escrow, which pulls it from here.
    function _share(
        address token,
        uint256 amount,
        uint256 shareBps,
        address creator
    ) private returns (uint256 toProtocol, uint256 toCreator) {
        if (amount == 0) return (0, 0);
        toProtocol = (amount * shareBps) / BPS;
        toCreator = amount - toProtocol;
        if (toProtocol > 0) IERC20(token).safeTransfer(treasury, toProtocol);
        if (toCreator > 0) {
            IERC20(token).forceApprove(address(feeEscrow), toCreator);
            feeEscrow.credit(creator, token, toCreator);
        }
    }

    // ---------------------------------------------------------------- admin

    function setCoinFactory(ITokenRegistry coinFactory_) external onlyOwner {
        if (address(coinFactory) != address(0)) revert CoinFactoryAlreadySet();
        if (address(coinFactory_) == address(0)) revert ZeroAddress();
        coinFactory = coinFactory_;
        emit CoinFactorySet(address(coinFactory_));
    }

    /// @notice Point the protocol's share of every fee somewhere else: the revenue router, once
    ///         it is deployed. Takes effect on the next payment from every coin and the factory.
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Hand the factory to another owner. Graduations stop working until it is
    ///         handed back, because only the factory owner can open pools.
    function setFactoryOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        uniswapV3Factory.setOwner(newOwner);
    }

    /// @notice Enable a fee tier on the factory. Pass-through, since this contract owns it.
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external onlyOwner {
        uniswapV3Factory.enableFeeAmount(fee, tickSpacing);
    }

    /// @notice Fee tier for pools opened from now on. Existing pools keep theirs.
    function setPoolFee(uint24 fee) external onlyOwner {
        if (uniswapV3Factory.feeAmountTickSpacing(fee) == 0) revert FeeTierNotEnabled(fee);
        poolFee = fee;
        emit PoolFeeUpdated(fee);
    }

    /// @notice Opens a pool between two assets that are neither one a coin this platform
    ///         launched — a bridge between two quote assets, so a route can cross between them
    ///         where no coin's own pool connects the two. An ordinary pool: liquidity goes in
    ///         through `LiquidityManager` like any other pool here, not the locked, full-range
    ///         position a coin's own graduation mints and never returns. It has no entry in
    ///         `poolOf` — that mapping is coins only — and is found the same way OUTBID's own
    ///         pool is: through the factory's `getPool`.
    function openBridgePool(
        address tokenA,
        address tokenB,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external onlyOwner returns (address pool) {
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();
        if (tokenA == tokenB) revert BridgeSameAsset(tokenA);
        if (address(coinFactory) != address(0)) {
            if (coinFactory.isMemeCoinLegit(tokenA)) revert BridgeIsCoin(tokenA);
            if (coinFactory.isMemeCoinLegit(tokenB)) revert BridgeIsCoin(tokenB);
        }
        if (uniswapV3Factory.feeAmountTickSpacing(fee) == 0) revert FeeTierNotEnabled(fee);
        if (uniswapV3Factory.getPool(tokenA, tokenB, fee) != address(0)) revert PoolAlreadyOpen(tokenA, tokenB, fee);

        pool = uniswapV3Factory.createPool(tokenA, tokenB, fee);
        IUniswapV3PoolMinimal(pool).initialize(sqrtPriceX96);
        emit BridgePoolOpened(tokenA, tokenB, fee, pool, sqrtPriceX96);
    }

    // ------------------------------------------------------------- internal

    /// @dev The full-range position `quoteIn` buys at `price`, sized from the quote side so all
    ///      of it is used, the coins that must go with it, and the sqrtPriceX96 the pool opens at.
    ///
    ///      `price` is the quote asset per whole coin at eighteen decimals, whatever the asset's
    ///      own. The pool wants raw token1 per raw token0, so the quote's decimals come back in
    ///      here: a whole coin is 1e18 raw, and a price at eighteen decimals is 10^(18 - d)
    ///      times the raw figure.
    function _listingAmounts(
        address coin,
        address quote,
        uint256 quoteIn,
        uint256 price
    ) private view returns (uint128 liquidity, uint256 coinAmount, uint256 quoteAmount, uint160 sqrtP) {
        uint256 quoteForPool = quoteIn;

        uint256 scale = 10 ** (36 - IERC20Metadata(quote).decimals());
        sqrtP = coin < quote
            ? PoolMath.sqrtPriceFromRatio(price, scale)
            : PoolMath.sqrtPriceFromRatio(scale, price);
        (int24 lower, int24 upper) = PoolMath.fullRange(uniswapV3Factory.feeAmountTickSpacing(poolFee));
        uint160 sqrtA = PoolMath.getSqrtRatioAtTick(lower);
        uint160 sqrtB = PoolMath.getSqrtRatioAtTick(upper);

        if (coin < quote) {
            // coin is token0, the quote is token1
            liquidity = PoolMath.liquidityForAmount1(sqrtA, sqrtP, quoteForPool);
            quoteAmount = PoolMath.amount1ForLiquidity(sqrtA, sqrtP, liquidity);
            coinAmount = PoolMath.amount0ForLiquidity(sqrtP, sqrtB, liquidity);
        } else {
            // the quote is token0, coin is token1
            liquidity = PoolMath.liquidityForAmount0(sqrtP, sqrtB, quoteForPool);
            // The pool rounds what it charges up; step down until the quote fits.
            while (PoolMath.amount0ForLiquidity(sqrtP, sqrtB, liquidity) > quoteForPool) liquidity -= 1;
            quoteAmount = PoolMath.amount0ForLiquidity(sqrtP, sqrtB, liquidity);
            coinAmount = PoolMath.amount1ForLiquidity(sqrtA, sqrtP, liquidity);
        }
    }
}
