// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Pool maths for the listing manager
/// @notice The parts of Uniswap V3's TickMath, SqrtPriceMath and LiquidityAmounts the listing
///         manager needs, in Solidity 0.8 so it compiles with the rest of the protocol. The
///         pool itself is the vendored 0.7.6 code under contracts/uniswap-v3; the constants
///         below are copied from its TickMath and the rounding matches what the pool charges
///         on mint (amounts owed round up).
library PoolMath {
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;
    uint256 internal constant Q96 = 0x1000000000000000000000000;
    /// @dev The price bounds a pool swap accepts, from the vendored TickMath.
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /// @dev sqrt(1.0001^tick) * 2^96, ported from TickMath.getSqrtRatioAtTick.
    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            require(absTick <= uint256(int256(MAX_TICK)), 'T');

            uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

            if (tick > 0) ratio = type(uint256).max / ratio;

            // this divides by 1<<32 rounding up to go from a Q128.128 to a Q128.96.
            // we then downcast because we know the result always fits within 160 bits due to our tick input constraint
            // we round up in the division so getTickAtSqrtRatio of the output price is always consistent
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }

    /// @notice The widest position a pool with `tickSpacing` allows.
    function fullRange(int24 tickSpacing) internal pure returns (int24 lower, int24 upper) {
        // Integer division truncates toward zero, which keeps both ends inside the tick bounds.
        lower = (MIN_TICK / tickSpacing) * tickSpacing;
        upper = (MAX_TICK / tickSpacing) * tickSpacing;
    }

    /// @notice sqrt(numerator / denominator) * 2^96, where the ratio is token1 per token0 in raw units.
    function sqrtPriceFromRatio(uint256 numerator, uint256 denominator) internal pure returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(numerator, 1 << 192, denominator)));
    }

    /// @notice `sqrtPriceX96` multiplied by the square root of `numerator / denominator`, for
    ///         moving a price by a ratio while staying in square-root space. The result can
    ///         exceed a uint160, so the caller clamps it into the pool's accepted range.
    function scaleSqrtPrice(
        uint160 sqrtPriceX96,
        uint256 numerator,
        uint256 denominator
    ) internal pure returns (uint256) {
        // sqrt(n/d) in 1e18 fixed point, then applied to the price.
        uint256 scale = Math.sqrt(Math.mulDiv(numerator, 1e36, denominator));
        return Math.mulDiv(sqrtPriceX96, scale, 1e18);
    }

    /// @dev Liquidity a given amount of token0 buys between two prices (floor).
    function liquidityForAmount0(uint160 sqrtA, uint160 sqrtB, uint256 amount0) internal pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 intermediate = Math.mulDiv(sqrtA, sqrtB, Q96);
        return uint128(Math.mulDiv(amount0, intermediate, sqrtB - sqrtA));
    }

    /// @dev Liquidity a given amount of token1 buys between two prices (floor).
    function liquidityForAmount1(uint160 sqrtA, uint160 sqrtB, uint256 amount1) internal pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        return uint128(Math.mulDiv(amount1, Q96, sqrtB - sqrtA));
    }

    /// @dev token0 the pool charges for `liquidity` between two prices: SqrtPriceMath.getAmount0Delta rounding up.
    function amount0ForLiquidity(uint160 sqrtA, uint160 sqrtB, uint128 liquidity) internal pure returns (uint256) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 numerator1 = uint256(liquidity) << 96;
        return Math.ceilDiv(Math.mulDiv(numerator1, sqrtB - sqrtA, sqrtB, Math.Rounding.Ceil), sqrtA);
    }

    /// @dev token1 the pool charges for `liquidity` between two prices: SqrtPriceMath.getAmount1Delta rounding up.
    function amount1ForLiquidity(uint160 sqrtA, uint160 sqrtB, uint128 liquidity) internal pure returns (uint256) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        return Math.mulDiv(liquidity, sqrtB - sqrtA, Q96, Math.Rounding.Ceil);
    }

    /// @dev What a burn pays out, which is what the pool rounds *down* to.
    function amount0Down(uint160 sqrtA, uint160 sqrtB, uint128 liquidity) internal pure returns (uint256) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        return Math.mulDiv(uint256(liquidity) << 96, sqrtB - sqrtA, sqrtB) / sqrtA;
    }

    /// @dev What a burn pays out, which is what the pool rounds *down* to.
    function amount1Down(uint160 sqrtA, uint160 sqrtB, uint128 liquidity) internal pure returns (uint256) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        return Math.mulDiv(liquidity, sqrtB - sqrtA, Q96);
    }

    /// @notice The largest liquidity `amount0` and `amount1` both cover over `[sqrtA, sqrtB]`
    ///         at the current price `sqrtP`. Uniswap's LiquidityAmounts.getLiquidityForAmounts.
    ///
    ///         A range wholly above the price is paid for in token0 alone, one wholly below it
    ///         in token1 alone, and one straddling it in both — so only the straddling case has
    ///         a ratio to respect, and there the smaller of the two sides sets the size.
    function liquidityForAmounts(
        uint160 sqrtP,
        uint160 sqrtA,
        uint160 sqrtB,
        uint256 amount0,
        uint256 amount1
    ) internal pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        if (sqrtP <= sqrtA) return liquidityForAmount0(sqrtA, sqrtB, amount0);
        if (sqrtP >= sqrtB) return liquidityForAmount1(sqrtA, sqrtB, amount1);
        uint128 fromAmount0 = liquidityForAmount0(sqrtP, sqrtB, amount0);
        uint128 fromAmount1 = liquidityForAmount1(sqrtA, sqrtP, amount1);
        return fromAmount0 < fromAmount1 ? fromAmount0 : fromAmount1;
    }

    /// @notice What `liquidity` over `[sqrtA, sqrtB]` is worth at `sqrtP`. `roundUp` gives what
    ///         a mint costs; rounding down gives what a burn returns.
    function amountsForLiquidity(
        uint160 sqrtP,
        uint160 sqrtA,
        uint160 sqrtB,
        uint128 liquidity,
        bool roundUp
    ) internal pure returns (uint256 amount0, uint256 amount1) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        if (sqrtP <= sqrtA) {
            amount0 = roundUp ? amount0ForLiquidity(sqrtA, sqrtB, liquidity) : amount0Down(sqrtA, sqrtB, liquidity);
        } else if (sqrtP < sqrtB) {
            amount0 = roundUp ? amount0ForLiquidity(sqrtP, sqrtB, liquidity) : amount0Down(sqrtP, sqrtB, liquidity);
            amount1 = roundUp ? amount1ForLiquidity(sqrtA, sqrtP, liquidity) : amount1Down(sqrtA, sqrtP, liquidity);
        } else {
            amount1 = roundUp ? amount1ForLiquidity(sqrtA, sqrtB, liquidity) : amount1Down(sqrtA, sqrtB, liquidity);
        }
    }

    /// @notice Fees per unit of liquidity earned inside a range for one of the two tokens, as
    ///         the pool's own Tick.getFeeGrowthInside works it out. `aboveLower` is whether the
    ///         current tick is at or above the lower bound, `belowUpper` whether it is under the
    ///         upper one; together they say where the price sits relative to the range.
    ///
    ///         The subtractions are deliberately unchecked: these counters are meant to overflow
    ///         and only their differences are ever read, which is how the pool treats them too.
    function feeGrowthInside(
        uint256 globalX128,
        uint256 lowerOutsideX128,
        uint256 upperOutsideX128,
        bool aboveLower,
        bool belowUpper
    ) internal pure returns (uint256) {
        unchecked {
            uint256 below = aboveLower ? lowerOutsideX128 : globalX128 - lowerOutsideX128;
            uint256 above = belowUpper ? upperOutsideX128 : globalX128 - upperOutsideX128;
            return globalX128 - below - above;
        }
    }

    /// @notice The fees `liquidity` has earned since it last saw `lastInsideX128`.
    function feesEarned(
        uint256 insideX128,
        uint256 lastInsideX128,
        uint128 liquidity
    ) internal pure returns (uint128) {
        unchecked {
            return uint128(Math.mulDiv(insideX128 - lastInsideX128, liquidity, 1 << 128));
        }
    }
}
