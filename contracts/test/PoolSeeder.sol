// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3PoolMinimal, IWETH9Minimal} from "../interfaces/IUniswapV3Minimal.sol";
import {PoolMath} from "../libraries/PoolMath.sol";

/// @dev Puts a full-range position into a pool the same way CoinListingManager does, for tests
///      that need a live market without going through a graduation. The production path never
///      uses this: only the listing manager mints, and only at graduation.
contract PoolSeeder {
    address public immutable weth;

    constructor(address weth_) {
        weth = weth_;
    }

    receive() external payable {}

    /// @notice sqrtPriceX96 for `price` wei per whole token, on the side `token` sits.
    function sqrtPriceFor(address token, uint256 price) external view returns (uint160) {
        return
            token < weth
                ? PoolMath.sqrtPriceFromRatio(price, 1e18)
                : PoolMath.sqrtPriceFromRatio(1e18, price);
    }

    /// @notice Mint a full-range position sized from `msg.value`. Send the token here first.
    function seed(address pool, address token) external payable returns (uint128 liquidity) {
        (uint160 sqrtP, , , , , , ) = IUniswapV3PoolMinimal(pool).slot0();
        (int24 lower, int24 upper) = PoolMath.fullRange(IUniswapV3PoolMinimal(pool).tickSpacing());
        uint160 sqrtA = PoolMath.getSqrtRatioAtTick(lower);
        uint160 sqrtB = PoolMath.getSqrtRatioAtTick(upper);

        if (token < weth) {
            liquidity = PoolMath.liquidityForAmount1(sqrtA, sqrtP, msg.value);
        } else {
            liquidity = PoolMath.liquidityForAmount0(sqrtP, sqrtB, msg.value);
            while (PoolMath.amount0ForLiquidity(sqrtP, sqrtB, liquidity) > msg.value) liquidity -= 1;
        }
        IUniswapV3PoolMinimal(pool).mint(address(this), lower, upper, liquidity, abi.encode(token));
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        address token = abi.decode(data, (address));
        (address token0, address token1) = token < weth ? (token, weth) : (weth, token);
        _pay(token0, amount0Owed);
        _pay(token1, amount1Owed);
    }

    function _pay(address token, uint256 amount) private {
        if (amount == 0) return;
        if (token == weth) IWETH9Minimal(weth).deposit{value: amount}();
        IERC20(token).transfer(msg.sender, amount);
    }
}
