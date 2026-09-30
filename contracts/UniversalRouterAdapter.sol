// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @dev A Universal Router — PancakeSwap Infinity's, or Uniswap v4's, which it forks: commands,
///      each with its input, run in order and checked against the deadline.
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @dev What PancakeSwap Infinity's router decodes a CL swap as (infinity-periphery).
interface IInfinityRouter {
    /// @dev One pool along the swap: the currency it pays out, and what keys it — with the currency
    ///      paid in, from the pool before it. Ether is `address(0)` where a pool holds it native.
    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        address hooks;
        address poolManager;
        bytes hookData;
        bytes32 parameters;
    }

    /// @dev The `CL_SWAP_EXACT_IN` action's params (`ICLRouterBase`).
    struct CLSwapExactInputParams {
        address currencyIn;
        PathKey[] path;
        uint128 amountIn;
        uint128 amountOutMinimum;
    }
}

/// @dev What Uniswap v4's router decodes a swap as (v4-periphery, as the Universal Router v2.1.2 on
///      Robinhood Chain builds it).
interface IV4Router {
    /// @dev One pool along the swap, as Infinity's, keyed by its fee, tick spacing and hooks.
    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    /// @dev The `SWAP_EXACT_IN` action's params. `minHopPriceX36` is a least price per pool, which
    ///      the router checks only where it is given; left empty, the whole's minimum is the check.
    struct ExactInputParams {
        address currencyIn;
        PathKey[] path;
        uint256[] minHopPriceX36;
        uint128 amountIn;
        uint128 amountOutMinimum;
    }
}

/**
 * @title UniversalRouterAdapter
 * @notice A Universal Router — PancakeSwap Infinity's or Uniswap v4's — behind v3-periphery's
 *         `exactInput`, the one call the `SwapExecutor` makes of a router it lists as a periphery
 *         router. Listing an adapter is how the executors already deployed reach pools keyed
 *         rather than deployed, with no change to them: a new AMM is a new adapter and an owner's
 *         `setVenue`, never a new executor at a new address.
 *
 *         It pulls `amountIn` of the path's first token from its caller, and only from its caller,
 *         straight into the router, which settles the swap from its own balance — so it needs no
 *         Permit2 and gives no allowance. The pools are crossed in one action along the path's pool
 *         keys, and what the last pays is taken straight to the recipient. Where a pool holds ether
 *         native, the router unwraps what it was sent before the swap, or wraps what the swap paid
 *         before handing it on, so ether only ever arrives wrapped. Neither router checks that a
 *         swap spent all it was sent, so whatever is left goes straight back to the caller, wrapped
 *         where it is ether — as a V3 pool leaves unspent input with its payer. The recipient is
 *         held to `amountOutMinimum` by what it actually received.
 *
 *         A path is the first token, then per pool what keys it, a flag byte and the token bought,
 *         with ether as wrapped ether at every token, so it starts and ends where a V3 path would:
 *         - Infinity: the pool's LP fee (3 bytes), hooks (20), pool manager (20) and parameters (32);
 *         - Uniswap v4: the pool's fee (3), tick spacing (3) and hooks (20).
 *         Flag bit 0 says the pool holds ether native where it is the token bought; bit 1, on the
 *         first pool only, where it is the token paid. A path never starts and ends at one token, so
 *         never holds ether native at both ends.
 *
 *         It has no owner and holds nothing between calls: one deployment per router, immutable.
 */
contract UniversalRouterAdapter {
    using SafeERC20 for IERC20;

    /// @notice Which router it stands in front of, which decides how a path's pool keys are read.
    enum Flavor {
        Infinity,
        UniswapV4
    }

    /// @notice v3-periphery's `ExactInputParams`, as the executor sends them.
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /// @dev The bytes a path grows by per pool: a fee, hooks, pool manager, parameters, flags and a
    ///      token on Infinity; a fee, tick spacing, hooks, flags and a token on Uniswap v4.
    uint256 private constant INFINITY_HOP = 96;
    uint256 private constant V4_HOP = 47;
    uint8 private constant NATIVE_OUT = 1;
    uint8 private constant NATIVE_IN = 2;

    /// @dev The routers' commands (`Commands.sol`) and the actions inside a swap (`Actions.sol`),
    ///      the same in both and two numberings: 0x0b is a command to wrap ether and an action to settle.
    bytes1 private constant COMMAND_SWEEP = 0x04;
    bytes1 private constant COMMAND_WRAP_ETH = 0x0b;
    bytes1 private constant COMMAND_UNWRAP_WETH = 0x0c;
    bytes1 private constant COMMAND_SWAP = 0x10;
    bytes1 private constant ACTION_SWAP_EXACT_IN = 0x07;
    bytes1 private constant ACTION_SETTLE = 0x0b;
    bytes1 private constant ACTION_TAKE = 0x0e;
    /// @dev An amount of zero to settle or take means the whole of what the swap left open.
    uint256 private constant OPEN_DELTA = 0;
    /// @dev An amount to wrap meaning the router's whole ether balance.
    uint256 private constant CONTRACT_BALANCE = 1 << 255;
    /// @dev The routers' stand-ins for whoever called them, and for themselves, as a recipient.
    address private constant ROUTER_CALLER = address(1);
    address private constant ROUTER_ITSELF = address(2);

    /// @notice The Universal Router every swap goes through.
    IUniversalRouter public immutable router;
    Flavor public immutable flavor;
    /// @notice The wrapped ether its router wraps into and unwraps from, named as a V3 router names it.
    address public immutable WETH9;

    error BadPath();
    error BadRecipient();
    error TooLittleReceived(uint256 amountOut, uint256 amountOutMinimum);

    constructor(IUniversalRouter router_, Flavor flavor_, address weth_) {
        router = router_;
        flavor = flavor_;
        WETH9 = weth_;
    }

    /// @notice Swaps `amountIn` of the path's first token, pulled from the caller, along the path's
    ///         pools, and pays what the last one pays to `recipient`, at least `amountOutMinimum` of it.
    function exactInput(ExactInputParams calldata params) external returns (uint256 amountOut) {
        bytes calldata path = params.path;
        uint256 hop = flavor == Flavor.Infinity ? INFINITY_HOP : V4_HOP;
        if (path.length < 20 + hop || (path.length - 20) % hop != 0) revert BadPath();
        address tokenIn = address(bytes20(path[:20]));
        address tokenOut = address(bytes20(path[path.length - 20:]));
        if (tokenIn == tokenOut) revert BadPath();
        // The routers read 1 and 2 as their caller and themselves: what reached either would stay
        // where no one meant it to.
        address recipient = params.recipient;
        if (
            recipient == address(0) ||
            recipient == ROUTER_CALLER ||
            recipient == ROUTER_ITSELF ||
            recipient == address(this) ||
            recipient == address(router)
        ) revert BadRecipient();

        (bytes[] memory swapParams, bool nativeIn, bool nativeOut) = flavor == Flavor.Infinity
            ? _infinitySwap(path, tokenIn, params.amountIn, params.amountOutMinimum)
            : _v4Swap(path, tokenIn, params.amountIn, params.amountOutMinimum);
        (bytes memory commands, bytes[] memory inputs) = _commands(swapParams, tokenIn, nativeIn, nativeOut, params.amountIn, recipient);

        uint256 before = IERC20(tokenOut).balanceOf(recipient);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(router), params.amountIn);
        router.execute(commands, inputs, params.deadline);
        amountOut = IERC20(tokenOut).balanceOf(recipient) - before;
        if (amountOut < params.amountOutMinimum) revert TooLittleReceived(amountOut, params.amountOutMinimum);
    }

    /// @dev The router's commands for one swap: unwrap (ether in) · swap · wrap (ether out) · what
    ///      the swap left of what the router was sent, back to the caller.
    function _commands(
        bytes[] memory swapParams,
        address tokenIn,
        bool nativeIn,
        bool nativeOut,
        uint256 amountIn,
        address recipient
    ) private view returns (bytes memory commands, bytes[] memory inputs) {
        // What the swap takes is settled from the router's own balance; what it pays is taken to
        // the recipient, or to the router itself to wrap where it is ether.
        swapParams[1] = abi.encode(nativeIn ? address(0) : tokenIn, OPEN_DELTA, false);
        address currencyOut = abi.decode(swapParams[2], (address));
        swapParams[2] = abi.encode(currencyOut, nativeOut ? ROUTER_ITSELF : recipient, OPEN_DELTA);

        uint256 count = nativeIn || nativeOut ? 3 : 2;
        commands = new bytes(count);
        inputs = new bytes[](count);
        uint256 n;
        if (nativeIn) {
            commands[n] = COMMAND_UNWRAP_WETH;
            inputs[n++] = abi.encode(ROUTER_ITSELF, amountIn);
        }
        commands[n] = COMMAND_SWAP;
        inputs[n++] = abi.encode(abi.encodePacked(ACTION_SWAP_EXACT_IN, ACTION_SETTLE, ACTION_TAKE), swapParams);
        if (nativeOut) {
            commands[n] = COMMAND_WRAP_ETH;
            inputs[n++] = abi.encode(recipient, CONTRACT_BALANCE);
        }
        if (nativeIn) {
            commands[n] = COMMAND_WRAP_ETH;
            inputs[n] = abi.encode(msg.sender, CONTRACT_BALANCE);
        } else {
            commands[n] = COMMAND_SWEEP;
            inputs[n] = abi.encode(tokenIn, msg.sender, uint256(0));
        }
    }

    /// @dev An Infinity path's swap params (`CL_SWAP_EXACT_IN`), with the currency it pays out in the
    ///      take's slot for `_commands` to finish, and whether the ends are ether held native.
    function _infinitySwap(
        bytes calldata path,
        address tokenIn,
        uint256 amount,
        uint256 minOut
    ) private view returns (bytes[] memory params, bool nativeIn, bool nativeOut) {
        uint256 hops = (path.length - 20) / INFINITY_HOP;
        IInfinityRouter.PathKey[] memory keys = new IInfinityRouter.PathKey[](hops);
        nativeIn = tokenIn == WETH9 && uint8(path[95]) & NATIVE_IN != 0;
        uint256 from = 20;
        for (uint256 i; i < hops; ++i) {
            address token = address(bytes20(path[from + 76:from + 96]));
            bool native = token == WETH9 && uint8(path[from + 75]) & NATIVE_OUT != 0;
            keys[i] = IInfinityRouter.PathKey({
                intermediateCurrency: native ? address(0) : token,
                fee: uint24(bytes3(path[from:from + 3])),
                hooks: address(bytes20(path[from + 3:from + 23])),
                poolManager: address(bytes20(path[from + 23:from + 43])),
                hookData: "",
                parameters: bytes32(path[from + 43:from + 75])
            });
            if (i == hops - 1) nativeOut = native;
            from += INFINITY_HOP;
        }
        params = new bytes[](3);
        params[0] = abi.encode(
            IInfinityRouter.CLSwapExactInputParams({
                currencyIn: nativeIn ? address(0) : tokenIn,
                path: keys,
                amountIn: SafeCast.toUint128(amount),
                amountOutMinimum: SafeCast.toUint128(minOut)
            })
        );
        params[2] = abi.encode(keys[hops - 1].intermediateCurrency);
    }

    /// @dev A Uniswap v4 path's swap params (`SWAP_EXACT_IN`), with the currency it pays out in the
    ///      take's slot for `_commands` to finish, and whether the ends are ether held native.
    function _v4Swap(
        bytes calldata path,
        address tokenIn,
        uint256 amount,
        uint256 minOut
    ) private view returns (bytes[] memory params, bool nativeIn, bool nativeOut) {
        uint256 hops = (path.length - 20) / V4_HOP;
        IV4Router.PathKey[] memory keys = new IV4Router.PathKey[](hops);
        nativeIn = tokenIn == WETH9 && uint8(path[46]) & NATIVE_IN != 0;
        uint256 from = 20;
        for (uint256 i; i < hops; ++i) {
            address token = address(bytes20(path[from + 27:from + 47]));
            bool native = token == WETH9 && uint8(path[from + 26]) & NATIVE_OUT != 0;
            keys[i] = IV4Router.PathKey({
                intermediateCurrency: native ? address(0) : token,
                fee: uint24(bytes3(path[from:from + 3])),
                tickSpacing: int24(uint24(bytes3(path[from + 3:from + 6]))),
                hooks: address(bytes20(path[from + 6:from + 26])),
                hookData: ""
            });
            if (i == hops - 1) nativeOut = native;
            from += V4_HOP;
        }
        params = new bytes[](3);
        params[0] = abi.encode(
            IV4Router.ExactInputParams({
                currencyIn: nativeIn ? address(0) : tokenIn,
                path: keys,
                minHopPriceX36: new uint256[](0),
                amountIn: SafeCast.toUint128(amount),
                amountOutMinimum: SafeCast.toUint128(minOut)
            })
        );
        params[2] = abi.encode(keys[hops - 1].intermediateCurrency);
    }
}
