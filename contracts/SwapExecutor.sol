// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITokenRegistry} from "./interfaces/ITokenRegistry.sol";

interface IWrappedEther {
    function deposit() external payable;

    function withdraw(uint256 amount) external;
}

/// @dev v3-periphery's SwapRouter and the routers built on it: the deadline travels in the params.
interface IPeripheryRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @dev A coin on this platform's bonding curve: what it is priced in, and its buy and sell.
interface ICurveCoin {
    function reserveToken() external view returns (address);

    function buy(uint256 amountIn, uint256 minAmount) external;

    function sell(uint256 amount, uint256 minValue) external;
}

/// @dev swap-router-contracts' SwapRouter02 and the routers built on it: no deadline in the params.
interface IRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * @title SwapExecutor
 * @notice Runs a trade the swap page has already routed, when no one AMM's router can: legs
 *         across several AMMs, or a leg whose pools belong to more than one. The whole trade fills
 *         for at least its minimum, before its deadline, to its recipient, or reverts; nothing is
 *         settled in part.
 *
 *         It finds nothing and optimizes nothing: the page chooses the legs, their shares and
 *         their paths off chain, and this contract only checks that what it is asked to do stays
 *         inside the trader's own terms. A trade that one router can run on its own is sent to that
 *         router instead, and never passes through here.
 *
 *         What a caller can make it do is narrow on purpose. It takes the token paid only from the
 *         caller and only the trade's amount, which the legs must add up to. It calls nothing but
 *         `exactInput` on a router the owner has listed, with calldata it builds itself — no
 *         caller-supplied target or calldata — so an allowance given to it cannot be turned
 *         against anyone. Each leg's steps must join: the first starts at the token paid, each
 *         starts where the last ended, the last ends at the token bought, and nothing in between
 *         is either. A router is approved for exactly its step's amount, cleared after it. What a
 *         pool leaves unspent goes back to the caller, and nothing is held between transactions.
 *
 *         It also buys and sells this platform's coins on their bonding curves (`buyCurve`,
 *         `sellCurve`), for coins the owner's registry says the platform launched, so the site can
 *         send every trade through one contract.
 *
 *         A trading fee, `feeBps`, never above `MAX_FEE_BPS` (0.25%), is taken from each trade and
 *         paid to `feeRecipient` in the same transaction. It is taken in ether or a fee asset
 *         where the trade has one: from what is paid when that is ether or a fee asset, otherwise
 *         from what is bought when that is, otherwise from what is paid. At zero, the default, a
 *         trade runs exactly as it did without one.
 */
contract SwapExecutor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice How a listed router is called. `None` is unlisted.
    enum Venue {
        None,
        PeripheryRouter,
        Router02
    }

    /// @notice One router's stretch of a leg: the pools it crosses, packed the way it reads them.
    struct Step {
        address router;
        bytes path;
    }

    /// @notice One share of the trade: what it spends, the least it may return, and its steps.
    struct Leg {
        uint256 amountIn;
        uint256 minOut;
        Step[] steps;
    }

    /// @notice A whole trade as the page routed it. Ether is the zero address at either end.
    struct Trade {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address recipient;
        uint256 deadline;
        Leg[] legs;
    }

    uint256 public constant MAX_LEGS = 8;
    uint256 public constant MAX_STEPS = 3;
    /// @notice The highest trading fee the owner can set: 0.25%.
    uint16 public constant MAX_FEE_BPS = 25;
    uint256 private constant BPS = 10_000;

    /// @notice The wrapped ether a trade in or out of ether passes through.
    address public immutable weth;

    /// @notice The routers steps may go through, and how each is called.
    mapping(address router => Venue venue) public venues;

    /// @notice The trading fee, in basis points of what it is taken from, and who is paid it.
    uint16 public feeBps;
    address public feeRecipient;
    /// @notice Tokens a fee is taken in where a trade has one; wrapped ether always is.
    mapping(address token => bool) public feeAssets;
    /// @notice The registry of coins `buyCurve` and `sellCurve` may trade. Unset, they trade none.
    ITokenRegistry public coins;

    event VenueSet(address indexed router, Venue venue);
    event FeeSet(uint16 feeBps, address recipient);
    event FeeAssetSet(address indexed token, bool isFeeAsset);
    event CoinsSet(address registry);
    event FeeCharged(address indexed payer, address indexed token, uint256 amount);
    /// @notice A curve trade: `amountIn` of what was paid (the reserve token on a buy, coins on a
    ///         sell) for `amountOut` of what was received, after the fee.
    event CurveTraded(
        address indexed coin,
        address indexed trader,
        address indexed recipient,
        bool isBuy,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );
    /// @notice `routeHash` is `keccak256(abi.encode(trade))`: the page computes the same, so a
    ///         transaction can be matched to exactly the route that was chosen for it.
    event Executed(
        bytes32 indexed routeHash,
        address indexed sender,
        address indexed recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 legs
    );

    error Expired();
    error BadRecipient();
    error BadLegs();
    error SameToken();
    error AmountMismatch();
    error UnlistedRouter(address router);
    error WrongPath(uint256 leg, uint256 step);
    error WrongValue();
    error TooLittleReceived(uint256 amountOut, uint256 minAmountOut);
    error EtherRejected();
    error EtherNotSent();
    error FeeTooHigh(uint16 feeBps);
    error NoFeeRecipient();
    error NotACoin(address coin);

    constructor(address weth_, address owner_) Ownable(owner_) {
        weth = weth_;
    }

    /// @notice Lists a router, says how it is called, or unlists it with `Venue.None`.
    function setVenue(address router, Venue venue) external onlyOwner {
        venues[router] = venue;
        emit VenueSet(router, venue);
    }

    /// @notice Sets the trading fee, at most `MAX_FEE_BPS`, and who is paid it. Zero turns it off.
    function setFee(uint16 feeBps_, address recipient) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        if (feeBps_ > 0 && recipient == address(0)) revert NoFeeRecipient();
        feeBps = feeBps_;
        feeRecipient = recipient;
        emit FeeSet(feeBps_, recipient);
    }

    /// @notice Says whether a fee is taken in `token` where a trade has it.
    function setFeeAsset(address token, bool isFeeAsset) external onlyOwner {
        feeAssets[token] = isFeeAsset;
        emit FeeAssetSet(token, isFeeAsset);
    }

    /// @notice Sets the registry of coins the curve trades may be made in.
    function setCoins(ITokenRegistry registry) external onlyOwner {
        coins = registry;
        emit CoinsSet(address(registry));
    }

    /// @notice The fee on `amount`, at the current rate.
    function feeOn(uint256 amount) public view returns (uint256) {
        return (amount * feeBps) / BPS;
    }

    /// @notice Runs `trade` and pays its recipient at least its minimum, or reverts altogether.
    function execute(Trade calldata trade) external payable nonReentrant returns (uint256 amountOut) {
        if (block.timestamp > trade.deadline) revert Expired();
        if (trade.recipient == address(0) || trade.recipient == address(this)) revert BadRecipient();
        address paid = trade.tokenIn == address(0) ? weth : trade.tokenIn;
        address bought = trade.tokenOut == address(0) ? weth : trade.tokenOut;
        if (paid == bought) revert SameToken();
        // The fee comes out of what is bought only where that is ether or a fee asset and what is
        // paid is not; otherwise out of what is paid, before the legs, which spend the rest.
        bool feeOnOut = feeBps > 0 && !_isFeeAsset(paid) && _isFeeAsset(bought);
        uint256 feeIn = feeOnOut ? 0 : feeOn(trade.amountIn);
        _check(trade.legs, trade.amountIn - feeIn, paid, bought);

        // Balances are measured, not assumed: the contract holds nothing of its own, but anything
        // sent to it by mistake stays out of this trade's figures.
        uint256 paidBefore = IERC20(paid).balanceOf(address(this));
        if (trade.tokenIn == address(0)) {
            if (msg.value != trade.amountIn) revert WrongValue();
            IWrappedEther(weth).deposit{value: trade.amountIn}();
        } else {
            if (msg.value != 0) revert WrongValue();
            IERC20(paid).safeTransferFrom(msg.sender, address(this), trade.amountIn);
        }
        if (feeIn > 0) _payFee(paid, feeIn);

        // What is bought arrives here where it is ether, or where the fee comes out of it.
        address to = trade.tokenOut == address(0) || feeOnOut ? address(this) : trade.recipient;
        uint256 boughtBefore = IERC20(bought).balanceOf(to);
        for (uint256 i; i < trade.legs.length; ++i) {
            _runLeg(trade.legs[i], paid, to, trade.deadline);
        }
        amountOut = IERC20(bought).balanceOf(to) - boughtBefore;
        if (feeOnOut) {
            uint256 feeOut = feeOn(amountOut);
            amountOut -= feeOut;
            if (feeOut > 0) _payFee(bought, feeOut);
        }
        if (amountOut < trade.minAmountOut) revert TooLittleReceived(amountOut, trade.minAmountOut);

        uint256 unspent = IERC20(paid).balanceOf(address(this)) - paidBefore;
        if (unspent > 0) _giveBack(paid, unspent, trade.tokenIn == address(0));
        if (trade.tokenOut == address(0)) {
            IWrappedEther(weth).withdraw(amountOut);
            _sendEther(trade.recipient, amountOut);
        } else if (feeOnOut) {
            IERC20(bought).safeTransfer(trade.recipient, amountOut);
        }

        emit Executed(
            keccak256(abi.encode(trade)),
            msg.sender,
            trade.recipient,
            trade.tokenIn,
            trade.tokenOut,
            trade.amountIn - unspent,
            amountOut,
            trade.legs.length
        );
    }

    /// @notice Buys `coin` on its bonding curve with `amountIn` of its reserve token — sent as
    ///         ether where that is wrapped ether — and pays the coins to `recipient`, at least
    ///         `minCoins` of them. The fee is taken from what is paid; a buy that fills the curve
    ///         pays the fee only on what the curve took, and the rest comes back to the caller.
    /// @dev The coins are bought by this contract and passed on, so a coin that takes a share of
    ///      a transfer takes it here too; the site sends those coins' trades straight to the coin.
    function buyCurve(
        address coin,
        uint256 amountIn,
        uint256 minCoins,
        address recipient,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 coinsOut) {
        _curveTerms(coin, recipient, deadline);
        address reserve = ICurveCoin(coin).reserveToken();
        uint256 heldBefore = IERC20(reserve).balanceOf(address(this));
        _takePayment(reserve, amountIn);
        uint256 fee = feeOn(amountIn);
        coinsOut = _buyAndPass(coin, reserve, amountIn - fee, minCoins, recipient);
        (uint256 spent, uint256 feeDue) = _settleBuy(reserve, amountIn, fee, heldBefore);
        emit CurveTraded(coin, msg.sender, recipient, true, spent, coinsOut, feeDue);
    }

    /// @notice Sells `amount` of `coin` to its bonding curve and pays what it is worth, less the
    ///         fee, to `recipient` — as ether where the reserve is wrapped ether and `asEther` —
    ///         at least `minOut` of it.
    function sellCurve(
        address coin,
        uint256 amount,
        uint256 minOut,
        address recipient,
        uint256 deadline,
        bool asEther
    ) external nonReentrant returns (uint256 amountOut) {
        _curveTerms(coin, recipient, deadline);
        address reserve = ICurveCoin(coin).reserveToken();
        if (asEther && reserve != weth) revert WrongValue();
        uint256 coinsBefore = IERC20(coin).balanceOf(address(this));
        IERC20(coin).safeTransferFrom(msg.sender, address(this), amount);
        // What arrived is what is sold: a coin that takes a share of a transfer has taken it.
        uint256 fee;
        (amountOut, fee) = _sellAndPay(coin, reserve, IERC20(coin).balanceOf(address(this)) - coinsBefore, minOut, recipient, asEther);
        emit CurveTraded(coin, msg.sender, recipient, false, amount, amountOut, fee);
    }

    /// @dev Sells `selling` to the curve and pays the proceeds, less the fee, to `recipient`.
    function _sellAndPay(
        address coin,
        address reserve,
        uint256 selling,
        uint256 minOut,
        address recipient,
        bool asEther
    ) private returns (uint256 amountOut, uint256 fee) {
        uint256 reserveBefore = IERC20(reserve).balanceOf(address(this));
        ICurveCoin(coin).sell(selling, 0);
        uint256 gross = IERC20(reserve).balanceOf(address(this)) - reserveBefore;
        fee = feeOn(gross);
        amountOut = gross - fee;
        if (amountOut < minOut) revert TooLittleReceived(amountOut, minOut);
        if (fee > 0) _payFee(reserve, fee);
        if (asEther) {
            IWrappedEther(weth).withdraw(amountOut);
            _sendEther(recipient, amountOut);
        } else {
            IERC20(reserve).safeTransfer(recipient, amountOut);
        }
    }

    /// @dev Ether arrives only from wrapped ether, unwrapping.
    receive() external payable {
        if (msg.sender != weth) revert EtherRejected();
    }

    /// @dev Every leg's steps listed and joined, from `paid` to `bought` through neither, and the
    ///      legs' amounts adding up to the trade's.
    function _check(Leg[] calldata legs, uint256 amountIn, address paid, address bought) private view {
        if (legs.length == 0 || legs.length > MAX_LEGS) revert BadLegs();
        uint256 total;
        for (uint256 i; i < legs.length; ++i) {
            Step[] calldata steps = legs[i].steps;
            if (steps.length == 0 || steps.length > MAX_STEPS) revert BadLegs();
            address at = paid;
            for (uint256 j; j < steps.length; ++j) {
                if (venues[steps[j].router] == Venue.None) revert UnlistedRouter(steps[j].router);
                bytes calldata path = steps[j].path;
                if (path.length < 43 || address(bytes20(path[:20])) != at) revert WrongPath(i, j);
                at = address(bytes20(path[path.length - 20:]));
                bool last = j == steps.length - 1;
                if (last ? at != bought : (at == paid || at == bought)) revert WrongPath(i, j);
            }
            total += legs[i].amountIn;
        }
        if (total != amountIn || total == 0) revert AmountMismatch();
    }

    /// @dev One leg, step by step: each step spends what the one before it paid out, the last pays
    ///      `to` and answers for the leg's minimum.
    function _runLeg(Leg calldata leg, address paid, address to, uint256 deadline) private {
        uint256 amount = leg.amountIn;
        address tokenIn = paid;
        uint256 last = leg.steps.length - 1;
        for (uint256 j; j <= last; ++j) {
            bool isLast = j == last;
            (amount, tokenIn) = _step(
                leg.steps[j],
                tokenIn,
                amount,
                isLast ? to : address(this),
                isLast ? leg.minOut : 0,
                deadline,
                j > 0
            );
        }
    }

    /// @dev One step, and what it paid this contract where it paid this contract. A step after the
    ///      first returns to the caller any of its input its pools left unspent; for the token
    ///      paid, that happens once, for the whole trade.
    function _step(
        Step calldata step,
        address tokenIn,
        uint256 amount,
        address to,
        uint256 minOut,
        uint256 deadline,
        bool giveBackUnspent
    ) private returns (uint256 received, address tokenOut) {
        tokenOut = address(bytes20(step.path[step.path.length - 20:]));
        uint256 heldIn = IERC20(tokenIn).balanceOf(address(this)) - amount;
        uint256 heldOut = to == address(this) ? IERC20(tokenOut).balanceOf(address(this)) : 0;
        _swap(step, tokenIn, amount, to, minOut, deadline);
        if (giveBackUnspent) {
            uint256 unspent = IERC20(tokenIn).balanceOf(address(this)) - heldIn;
            if (unspent > 0) _giveBack(tokenIn, unspent, false);
        }
        if (to == address(this)) received = IERC20(tokenOut).balanceOf(address(this)) - heldOut;
    }

    function _swap(Step calldata step, address tokenIn, uint256 amount, address to, uint256 minOut, uint256 deadline) private {
        IERC20(tokenIn).forceApprove(step.router, amount);
        if (venues[step.router] == Venue.PeripheryRouter) {
            IPeripheryRouter(step.router).exactInput(
                IPeripheryRouter.ExactInputParams({
                    path: step.path,
                    recipient: to,
                    deadline: deadline,
                    amountIn: amount,
                    amountOutMinimum: minOut
                })
            );
        } else {
            IRouter02(step.router).exactInput(
                IRouter02.ExactInputParams({path: step.path, recipient: to, amountIn: amount, amountOutMinimum: minOut})
            );
        }
        IERC20(tokenIn).forceApprove(step.router, 0);
    }

    /// @dev A curve buy's payment: ether, wrapped here, where the reserve is wrapped ether and
    ///      ether was sent; otherwise the reserve token, pulled from the caller.
    function _takePayment(address reserve, uint256 amountIn) private {
        if (msg.value > 0) {
            if (reserve != weth || msg.value != amountIn) revert WrongValue();
            IWrappedEther(weth).deposit{value: amountIn}();
        } else {
            IERC20(reserve).safeTransferFrom(msg.sender, address(this), amountIn);
        }
    }

    /// @dev Buys with `spend` and passes the coins on, at least `minCoins` of them.
    function _buyAndPass(
        address coin,
        address reserve,
        uint256 spend,
        uint256 minCoins,
        address recipient
    ) private returns (uint256 coinsOut) {
        uint256 coinsBefore = IERC20(coin).balanceOf(address(this));
        IERC20(reserve).forceApprove(coin, spend);
        ICurveCoin(coin).buy(spend, 0);
        IERC20(reserve).forceApprove(coin, 0);
        coinsOut = IERC20(coin).balanceOf(address(this)) - coinsBefore;
        if (coinsOut < minCoins) revert TooLittleReceived(coinsOut, minCoins);
        IERC20(coin).safeTransfer(recipient, coinsOut);
    }

    /// @dev The fee on what the curve took, and the change from a buy that filled the curve, with
    ///      the fee on it, back to the caller. `spent` is what the trade cost the caller in all.
    function _settleBuy(
        address reserve,
        uint256 amountIn,
        uint256 fee,
        uint256 heldBefore
    ) private returns (uint256 spent, uint256 feeDue) {
        uint256 change = IERC20(reserve).balanceOf(address(this)) - heldBefore - fee;
        feeDue = change == 0 ? fee : ((amountIn - fee - change) * feeBps) / (BPS - feeBps);
        if (feeDue > fee) feeDue = fee;
        if (feeDue > 0) _payFee(reserve, feeDue);
        uint256 back = change + fee - feeDue;
        if (back > 0) _giveBack(reserve, back, msg.value > 0);
        spent = amountIn - back;
    }

    /// @dev A curve trade's terms: before its deadline, to a real recipient, in a platform coin.
    function _curveTerms(address coin, address recipient, uint256 deadline) private view {
        if (block.timestamp > deadline) revert Expired();
        if (recipient == address(0) || recipient == address(this)) revert BadRecipient();
        if (address(coins) == address(0) || !coins.isMemeCoinLegit(coin)) revert NotACoin(coin);
    }

    function _isFeeAsset(address token) private view returns (bool) {
        return token == weth || feeAssets[token];
    }

    function _payFee(address token, uint256 amount) private {
        IERC20(token).safeTransfer(feeRecipient, amount);
        emit FeeCharged(msg.sender, token, amount);
    }

    function _giveBack(address token, uint256 amount, bool asEther) private {
        if (asEther) {
            IWrappedEther(weth).withdraw(amount);
            _sendEther(msg.sender, amount);
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
        }
    }

    function _sendEther(address to, uint256 amount) private {
        (bool sent, ) = to.call{value: amount}("");
        if (!sent) revert EtherNotSent();
    }
}
