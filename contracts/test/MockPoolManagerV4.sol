// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManagerV4, IUnlockCallbackV4, PoolKeyV4, SwapParamsV4} from "../interfaces/IUniswapV4Minimal.sol";

/// @dev Uniswap V4's PoolManager, reduced to its accounting rules: trading only inside `unlock`,
///      every currency's delta settled to zero before `unlock` returns, `sync` then `settle` to
///      pay in a token, `settle` with value to pay in ether, and `take` to be paid. Each pool
///      trades at a fixed price the test sets, as `out = in * numerator / denominator` for each
///      direction. A pool given a depth takes no more than that much input in one swap and leaves
///      the rest, as a real pool does when its liquidity runs out before the amount. The manager
///      must hold what it pays out; tests fund it.
contract MockPoolManagerV4 is IPoolManagerV4 {
    using SafeERC20 for IERC20;

    struct Price {
        uint256 zeroForOneNumerator;
        uint256 zeroForOneDenominator;
        uint256 oneForZeroNumerator;
        uint256 oneForZeroDenominator;
        bool set;
    }

    mapping(bytes32 poolId => Price) public prices;
    mapping(bytes32 poolId => uint256) public depthOf;
    mapping(address currency => int256) public deltaOf;
    address[] private _touched;
    bool private _unlocked;
    address private _synced;
    uint256 private _syncedReserve;
    uint256 public swapCount;

    error ManagerLocked();
    error CurrencyNotSettled(address currency, int256 delta);
    error UnknownPool();

    receive() external payable {}

    function poolId(PoolKeyV4 memory key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    function setPrice(PoolKeyV4 calldata key, uint256 n01, uint256 d01, uint256 n10, uint256 d10) external {
        prices[poolId(key)] = Price(n01, d01, n10, d10, true);
    }

    /// @dev The most input one swap in the pool can take; zero for no limit.
    function setDepth(PoolKeyV4 calldata key, uint256 maxIn) external {
        depthOf[poolId(key)] = maxIn;
    }

    function unlock(bytes calldata data) external override returns (bytes memory result) {
        _unlocked = true;
        result = IUnlockCallbackV4(msg.sender).unlockCallback(data);
        for (uint256 i; i < _touched.length; i++) {
            if (deltaOf[_touched[i]] != 0) revert CurrencyNotSettled(_touched[i], deltaOf[_touched[i]]);
        }
        delete _touched;
        _unlocked = false;
    }

    function swap(PoolKeyV4 memory key, SwapParamsV4 memory params, bytes calldata) external override returns (int256) {
        if (!_unlocked) revert ManagerLocked();
        Price memory price = prices[poolId(key)];
        if (!price.set) revert UnknownPool();
        require(params.amountSpecified < 0, "exact input only");
        uint256 amountIn = uint256(-params.amountSpecified);
        uint256 depth = depthOf[poolId(key)];
        if (depth != 0 && amountIn > depth) amountIn = depth;
        uint256 amountOut = params.zeroForOne
            ? (amountIn * price.zeroForOneNumerator) / price.zeroForOneDenominator
            : (amountIn * price.oneForZeroNumerator) / price.oneForZeroDenominator;
        swapCount += 1;
        (address currencyIn, address currencyOut) = params.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        _move(currencyIn, -int256(amountIn));
        _move(currencyOut, int256(amountOut));
        int128 amount0 = params.zeroForOne ? -int128(int256(amountIn)) : int128(int256(amountOut));
        int128 amount1 = params.zeroForOne ? int128(int256(amountOut)) : -int128(int256(amountIn));
        return (int256(amount0) << 128) | int256(uint256(uint128(amount1)));
    }

    function sync(address currency) external override {
        _synced = currency;
        _syncedReserve = currency == address(0) ? 0 : IERC20(currency).balanceOf(address(this));
    }

    function settle() external payable override returns (uint256 paid) {
        if (!_unlocked) revert ManagerLocked();
        if (_synced == address(0)) {
            paid = msg.value;
            _move(address(0), int256(paid));
        } else {
            paid = IERC20(_synced).balanceOf(address(this)) - _syncedReserve;
            _move(_synced, int256(paid));
            _synced = address(0);
        }
    }

    function take(address currency, address to, uint256 amount) external override {
        if (!_unlocked) revert ManagerLocked();
        _move(currency, -int256(amount));
        if (currency == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            require(ok, "take");
        } else {
            IERC20(currency).safeTransfer(to, amount);
        }
    }

    /// @dev The caller's delta, as V4 keeps it: negative is what it owes the manager (a swap's
    ///      input, a take), positive what it is owed (a swap's output, a settle).
    function _move(address currency, int256 amount) private {
        if (deltaOf[currency] == 0) _touched.push(currency);
        deltaOf[currency] += amount;
    }
}
