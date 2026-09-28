// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBuybackVenue} from "./interfaces/IBuybackVenue.sol";
import {IOutbidBurnable} from "./interfaces/IOutbidBurnable.sol";
import {IUniswapV3FactoryMinimal, IUniswapV3PoolMinimal, IWETH9Minimal} from "./interfaces/IUniswapV3Minimal.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

/// @title OUTBID Buyback Vault
/// @notice Holds the buyback share of protocol revenue, and — once $OUTBID exists — buys it and
///         burns every token it receives (tokenomics §12-§19).
///
///         $OUTBID launches on PONS, after this vault is live, so the vault starts with no token.
///         Revenue accrues in whatever it arrives in: ether from bids and launches, the asset each
///         coin is priced in, and coins from their pools' fees. When the token exists the owner
///         calls `enableBuyback` once, naming it and the venue to buy it through. The token can
///         never be changed after that, so the revenue already set aside can only ever buy the
///         token it was set aside for.
///
///         The vault does not know the market. It hands the venue what to spend and checks what
///         came back: the only figures it trusts are its own balances, before and after. The venue
///         can be replaced (`setVenue`) as the market moves — PONS's curve today, its Uniswap V4
///         pool once the token graduates, a better route tomorrow — without moving the revenue.
///
///         Every execution is bounded four ways:
///
///           1. an **allowlisted keeper**. The venues this vault buys in have no time-weighted
///              average to judge a price against, so the keeper is the one who does not buy into
///              a market it can see is pumped. There is no switch to let anyone in;
///           2. `minOutbidOut` and a deadline from the keeper, checked against what arrived;
///           3. a maximum size per asset, capping price impact (§17);
///           4. a cooldown between executions (§14).
///
///         The outbid market does not wait for a keeper: once the buyback is enabled, every bid
///         spends its buyback share here the moment it is paid (`buyNow`), bounded by the bidder's
///         minimum and by the asset's maximum per execution. The keeper spends the rest: revenue
///         that arrived before $OUTBID existed, fee revenue, and whatever a bid paid in over the cap.
///
///         Purchased $OUTBID is burned in the same transaction, with the token's own `burn` where
///         it has one and by sending it to the dead address where it does not, so it can never
///         re-enter circulation.
contract OutbidBuyback is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The asset key for ether. Every other asset is its token contract.
    address public constant ETHER = address(0);
    /// @notice Where a token without `burn` is sent instead.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice The token the buyback buys and burns. Zero until `enableBuyback`, then fixed.
    IERC20 public outbidToken;
    /// @notice Where it is bought. Replaceable by the owner once enabled.
    IBuybackVenue public venue;

    address public immutable WETH;
    /// @notice The platform's own Uniswap V3 factory, for turning a coin into its quote asset.
    IUniswapV3FactoryMinimal public immutable uniswapV3Factory;

    /// @notice Largest single execution in each asset; zero means no cap (§17).
    mapping(address asset => uint256 maximum) public maxPerExecution;
    /// @notice Minimum gap between executions (§14).
    uint256 public cooldown;
    uint256 public lastBuybackAt;
    mapping(address keeper => bool allowed) public keepers;

    /// @notice Lifetime figures for the transparency dashboard (§20, §44).
    mapping(address asset => uint256 amount) public totalSpent;
    uint256 public totalOutbidBurned;
    uint256 public buybackCount;

    event RevenueReceived(address indexed source, uint256 amount);
    event BuybackEnabled(address indexed token, address indexed venue);
    event VenueUpdated(address indexed venue);
    event Converted(address indexed keeper, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event BuybackExecuted(
        address indexed keeper,
        address indexed assetIn,
        uint256 amountIn,
        uint256 outbidBought,
        uint256 outbidBurned,
        uint256 timestamp
    );
    event MaxPerExecutionUpdated(address indexed asset, uint256 maximum);
    event CooldownUpdated(uint256 cooldown);
    event KeeperUpdated(address indexed keeper, bool allowed);

    error ZeroAddress();
    error NotEnabled();
    error AlreadyEnabled(address token);
    error NotAKeeper(address caller);
    error NothingToSpend();
    error AboveMaxPerExecution(uint256 maximum, uint256 provided);
    error InsufficientBalance(uint256 available, uint256 requested);
    error CoolingDown(uint256 readyAt);
    error Expired(uint256 deadline);
    error NoMinimumOut();
    error ExcessiveSlippage(uint256 minimum, uint256 received);
    error NotSpendable(address asset);
    error PoolNotFound(uint24 fee);
    error UnexpectedCaller(address caller);
    error NotConvertible(address token);

    constructor(
        address initialOwner,
        address weth_,
        IUniswapV3FactoryMinimal factory_,
        uint256 cooldown_
    ) Ownable(initialOwner) {
        if (weth_ == address(0) || address(factory_) == address(0)) revert ZeroAddress();
        WETH = weth_;
        uniswapV3Factory = factory_;
        cooldown = cooldown_;
        emit CooldownUpdated(cooldown_);
    }

    /// @notice The RevenueRouter's buyback share arrives as a plain transfer, and a venue's
    ///         refund of unspent ether comes back the same way.
    receive() external payable {
        emit RevenueReceived(msg.sender, msg.value);
    }

    modifier onlyKeeper() {
        if (!keepers[msg.sender]) revert NotAKeeper(msg.sender);
        _;
    }

    // ---------------------------------------------------------------- views

    /// @notice True once `enableBuyback` has named the token.
    function enabled() external view returns (bool) {
        return address(outbidToken) != address(0);
    }

    /// @notice Ether waiting to be spent, wrapped or not.
    function pendingBuyback() public view returns (uint256) {
        return address(this).balance + IERC20(WETH).balanceOf(address(this));
    }

    /// @notice What the vault holds of `asset`: ether under `ETHER`, anything else by address.
    function heldOf(address asset) public view returns (uint256) {
        return asset == ETHER ? address(this).balance : IERC20(asset).balanceOf(address(this));
    }

    /// @notice Earliest timestamp at which the next buyback may run.
    function nextBuybackTime() external view returns (uint256) {
        return lastBuybackAt == 0 ? block.timestamp : lastBuybackAt + cooldown;
    }

    // -------------------------------------------------------------- execute

    /// @notice Spend up to `amountIn` of `assetIn` on $OUTBID through the venue, and burn it.
    ///         What the venue does not spend comes back and stays in the vault.
    function executeBuyback(address assetIn, uint256 amountIn, uint256 minOutbidOut, uint256 deadline)
        external
        nonReentrant
        onlyKeeper
    {
        IERC20 token = outbidToken;
        if (address(token) == address(0)) revert NotEnabled();
        if (block.timestamp > deadline) revert Expired(deadline);
        if (minOutbidOut == 0) revert NoMinimumOut();
        if (amountIn == 0) revert NothingToSpend();
        if (assetIn == address(token)) revert NotSpendable(assetIn);
        uint256 maximum = maxPerExecution[assetIn];
        if (maximum != 0 && amountIn > maximum) revert AboveMaxPerExecution(maximum, amountIn);
        uint256 available = heldOf(assetIn);
        if (amountIn > available) revert InsufficientBalance(available, amountIn);
        uint256 readyAt = lastBuybackAt + cooldown;
        if (lastBuybackAt != 0 && block.timestamp < readyAt) revert CoolingDown(readyAt);
        lastBuybackAt = block.timestamp;

        uint256 outbidBefore = token.balanceOf(address(this));
        IBuybackVenue market = venue;
        if (assetIn == ETHER) {
            market.buy{value: amountIn}(ETHER, amountIn, address(token), minOutbidOut, address(this));
        } else {
            IERC20(assetIn).forceApprove(address(market), amountIn);
            market.buy(assetIn, amountIn, address(token), minOutbidOut, address(this));
            IERC20(assetIn).forceApprove(address(market), 0);
        }
        // Only the vault's own balances are believed: what left, and what arrived.
        uint256 spent = available - heldOf(assetIn);
        uint256 bought = token.balanceOf(address(this)) - outbidBefore;
        if (bought < minOutbidOut) revert ExcessiveSlippage(minOutbidOut, bought);

        totalSpent[assetIn] += spent;
        totalOutbidBurned += bought;
        buybackCount += 1;
        _burn(token, bought);
        emit BuybackExecuted(msg.sender, assetIn, spent, bought, bought, block.timestamp);
    }

    /// @notice Spend a bid's buyback share on $OUTBID the moment it is paid, and burn it. The
    ///         caller pays `amountIn` of `assetIn` in, approved to this vault, so a call can only
    ///         ever add to the burn; anyone may make one, and the outbid market makes one with
    ///         every bid once the buyback is enabled.
    ///
    ///         Bounded by the caller's `minOutbidOut` and by the asset's `maxPerExecution`: what
    ///         is paid in over the cap is not spent now but stays here for a keeper, as does
    ///         whatever the venue does not spend. No keeper and no cooldown, because a call spends
    ///         only what it brought.
    /// @return bought The $OUTBID bought and burned.
    function buyNow(address assetIn, uint256 amountIn, uint256 minOutbidOut)
        external
        nonReentrant
        returns (uint256 bought)
    {
        IERC20 token = outbidToken;
        if (address(token) == address(0)) revert NotEnabled();
        if (minOutbidOut == 0) revert NoMinimumOut();
        if (assetIn == ETHER || assetIn == address(token)) revert NotSpendable(assetIn);

        uint256 received = _pull(assetIn, amountIn);
        uint256 maximum = maxPerExecution[assetIn];
        uint256 spent;
        (spent, bought) = _spend(token, assetIn, maximum != 0 && received > maximum ? maximum : received, minOutbidOut);
        totalSpent[assetIn] += spent;
        totalOutbidBurned += bought;
        buybackCount += 1;
        _burn(token, bought);
        emit BuybackExecuted(msg.sender, assetIn, spent, bought, bought, block.timestamp);
    }

    /// @dev Takes `amount` of `asset` from the caller. Measured rather than trusted, so a
    ///      transfer that takes a cut spends only what arrived.
    function _pull(address asset, uint256 amount) private returns (uint256 received) {
        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(asset).balanceOf(address(this)) - before;
        if (received == 0) revert NothingToSpend();
    }

    /// @dev Spends up to `amount` of the token `assetIn` on `token` through the venue: what left
    ///      the vault and what arrived, by its own balances, at least `minOutbidOut` of it.
    function _spend(IERC20 token, address assetIn, uint256 amount, uint256 minOutbidOut)
        private
        returns (uint256 spent, uint256 bought)
    {
        IERC20 asset = IERC20(assetIn);
        uint256 held = asset.balanceOf(address(this));
        uint256 outbidBefore = token.balanceOf(address(this));
        IBuybackVenue market = venue;
        asset.forceApprove(address(market), amount);
        market.buy(assetIn, amount, address(token), minOutbidOut, address(this));
        asset.forceApprove(address(market), 0);
        spent = held - asset.balanceOf(address(this));
        bought = token.balanceOf(address(this)) - outbidBefore;
        if (bought < minOutbidOut) revert ExcessiveSlippage(minOutbidOut, bought);
    }

    /// @notice Turn one asset the vault holds into another through a pool the platform's own
    ///         factory returns — a coin from its pool's fees into its quote asset, typically —
    ///         and nowhere else. $OUTBID is never bought or sold here: only `executeBuyback` buys it.
    function convert(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline
    ) external nonReentrant onlyKeeper {
        if (block.timestamp > deadline) revert Expired(deadline);
        if (minOut == 0) revert NoMinimumOut();
        address token = address(outbidToken);
        if (token != address(0) && (tokenIn == token || tokenOut == token)) revert NotConvertible(token);
        if (tokenIn == tokenOut) revert NotConvertible(tokenIn);
        uint256 received = _swapOut(tokenIn, tokenOut, fee, amountIn);
        if (received < minOut) revert ExcessiveSlippage(minOut, received);
        emit Converted(msg.sender, tokenIn, tokenOut, amountIn, received);
    }

    function _swapOut(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) private returns (uint256) {
        uint256 available = IERC20(tokenIn).balanceOf(address(this));
        if (amountIn > available) revert InsufficientBalance(available, amountIn);
        address poolAddress = uniswapV3Factory.getPool(tokenIn, tokenOut, fee);
        if (poolAddress == address(0)) revert PoolNotFound(fee);
        bool zeroForOne = tokenIn < tokenOut;
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IUniswapV3PoolMinimal(poolAddress).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? PoolMath.MIN_SQRT_RATIO + 1 : PoolMath.MAX_SQRT_RATIO - 1,
            abi.encode(tokenIn, tokenOut, fee)
        );
        return IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    /// @dev Pays a conversion's pool. Only a pool the platform's factory returns for the pair the
    ///      conversion named is paid, and only its input side.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        (address tokenIn, address tokenOut, uint24 fee) = abi.decode(data, (address, address, uint24));
        address poolAddress = uniswapV3Factory.getPool(tokenIn, tokenOut, fee);
        if (poolAddress == address(0) || msg.sender != poolAddress) revert UnexpectedCaller(msg.sender);
        int256 owed = tokenIn < tokenOut ? amount0Delta : amount1Delta;
        if (owed <= 0) revert UnexpectedCaller(msg.sender);
        // Ether is spent wrapped: only the shortfall is wrapped on the way out.
        if (tokenIn == WETH) {
            uint256 wrapped = IERC20(WETH).balanceOf(address(this));
            if (wrapped < uint256(owed)) IWETH9Minimal(WETH).deposit{value: uint256(owed) - wrapped}();
        }
        IERC20(tokenIn).safeTransfer(poolAddress, uint256(owed));
    }

    // ---------------------------------------------------------------- admin

    /// @notice Name the token the buyback buys and burns, and the venue to buy it through. Once
    ///         only: the token can never be changed after this.
    function enableBuyback(address token, IBuybackVenue venue_) external onlyOwner {
        if (address(outbidToken) != address(0)) revert AlreadyEnabled(address(outbidToken));
        if (token == address(0) || address(venue_) == address(0)) revert ZeroAddress();
        outbidToken = IERC20(token);
        venue = venue_;
        emit BuybackEnabled(token, address(venue_));
    }

    /// @notice Buy through a different venue, as the token's market moves.
    function setVenue(IBuybackVenue venue_) external onlyOwner {
        if (address(outbidToken) == address(0)) revert NotEnabled();
        if (address(venue_) == address(0)) revert ZeroAddress();
        venue = venue_;
        emit VenueUpdated(address(venue_));
    }

    function setMaxPerExecution(address asset, uint256 maximum) external onlyOwner {
        maxPerExecution[asset] = maximum;
        emit MaxPerExecutionUpdated(asset, maximum);
    }

    function setCooldown(uint256 cooldown_) external onlyOwner {
        cooldown = cooldown_;
        emit CooldownUpdated(cooldown_);
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        keepers[keeper] = allowed;
        emit KeeperUpdated(keeper, allowed);
    }

    // ------------------------------------------------------------- internal

    /// @dev Burn with the token's own `burn`; a token without one is sent to the dead address.
    function _burn(IERC20 token, uint256 amount) private {
        try IOutbidBurnable(address(token)).burn(amount) {
            return;
        } catch {
            token.safeTransfer(DEAD, amount);
        }
    }
}
