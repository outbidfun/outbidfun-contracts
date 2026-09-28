// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slice of Uniswap V4 the buyback venue swaps through: a pool's key, a swap's
///         parameters, and the PoolManager calls that open, trade and settle a session.
/// @dev    Laid out exactly as v4-core's `PoolKey` and `SwapParams`, which is what makes the
///         selectors match: `Currency` and `IHooks` are addresses on the wire, and a
///         `BalanceDelta` is an int256 packing the currency0 amount above the currency1 amount.
///         Currency zero is native ether.
struct PoolKeyV4 {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParamsV4 {
    bool zeroForOne;
    /// Negative for an exact input, positive for an exact output.
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManagerV4 {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKeyV4 memory key, SwapParamsV4 memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

interface IUnlockCallbackV4 {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

library BalanceDeltaV4 {
    /// @notice The price bounds v4-core's TickMath allows; a swap limited just inside them is
    ///         limited by nothing but the amount.
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    function amount0(int256 delta) internal pure returns (int128 value) {
        assembly ("memory-safe") {
            value := sar(128, delta)
        }
    }

    function amount1(int256 delta) internal pure returns (int128 value) {
        assembly ("memory-safe") {
            value := signextend(15, delta)
        }
    }
}
