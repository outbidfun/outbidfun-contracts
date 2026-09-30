// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IFrontFactory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IFrontPool {
    function liquidity() external view returns (uint128);

    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
}

interface IFrontRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IFrontQuoter {
    function quoteExactInput(
        bytes memory path,
        uint256 amountIn
    ) external returns (uint256 amountOut, uint160[] memory, uint32[] memory, uint256 gasEstimate);
}

interface IFrontWeth {
    function deposit() external payable;

    function withdraw(uint256 amount) external;

    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice What a keyed-pool AMM's contracts answer the executor and the page — its pool state by
///         id, its quoter's `quoteExactInput`, its Universal Router's `execute` — as one contract in
///         front of the Hardhat network's own V3 pools, so tests key pools, quote and send a step
///         exactly as on Robinhood Chain. A pool key finds the V3 pool of its two currencies at its
///         fee; ether native in a key is the network's wrapped ether. A pool is known once
///         `register`ed, as a keyed pool is once initialized. The router takes only the commands and
///         actions the executor sends, in their order, and keeps the last call for tests to hold the
///         page's encoding against. `setSpend` makes swaps spend only part of what they are given,
///         as a pool whose liquidity went since the quote would, which neither real router checks.
abstract contract KeyedPoolFront {
    using SafeERC20 for IERC20;

    /// @dev A pool as the V3 lookup needs it.
    struct Pool {
        address currency0;
        address currency1;
        uint24 fee;
        bool known;
    }

    /// @dev What a swap's params say, whichever router's shape they came in.
    struct Swap {
        address currencyIn;
        address[] currencies;
        uint24[] fees;
        uint128 amountIn;
        uint128 amountOutMinimum;
    }

    IFrontFactory public immutable factory;
    IFrontRouter public immutable router;
    IFrontQuoter public immutable quoter;
    IFrontWeth public immutable weth;

    mapping(bytes32 id => Pool) internal pools;
    /// @notice The share of each swap's input it spends, in basis points: all of it, unless set.
    uint16 public spendBps = 10_000;

    bytes public lastCommands;
    bytes[] private lastInputs;

    constructor(IFrontFactory factory_, IFrontRouter router_, IFrontQuoter quoter_, IFrontWeth weth_) {
        factory = factory_;
        router = router_;
        quoter = quoter_;
        weth = weth_;
    }

    function setSpend(uint16 bps) external {
        spendBps = bps;
    }

    function lastInput(uint256 index) external view returns (bytes memory) {
        return lastInputs[index];
    }

    function lastInputCount() external view returns (uint256) {
        return lastInputs.length;
    }

    // ------------------------------------------------------------------- the pool's state

    function getLiquidity(bytes32 id) external view returns (uint128) {
        address pool = _poolOf(id);
        return pool == address(0) ? 0 : IFrontPool(pool).liquidity();
    }

    function getSlot0(bytes32 id) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee) {
        address pool = _poolOf(id);
        if (pool == address(0)) return (0, 0, 0, 0);
        (sqrtPriceX96, tick, , , , , ) = IFrontPool(pool).slot0();
        lpFee = pools[id].fee;
    }

    // ------------------------------------------------------------------ the universal router

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        require(block.timestamp <= deadline, "KeyedPoolFront: expired");
        require(commands.length == inputs.length, "KeyedPoolFront: inputs");
        lastCommands = commands;
        delete lastInputs;
        for (uint256 i; i < inputs.length; ++i) lastInputs.push(inputs[i]);

        for (uint256 i; i < commands.length; ++i) {
            bytes1 command = commands[i];
            if (command == 0x0c) {
                // UNWRAP_WETH(recipient, amountMin): the router's whole wrapped ether, to itself.
                (address recipient, uint256 amountMin) = abi.decode(inputs[i], (address, uint256));
                require(recipient == address(2), "KeyedPoolFront: unwrap recipient");
                uint256 held = weth.balanceOf(address(this));
                require(held >= amountMin, "KeyedPoolFront: unwrap amount");
                weth.withdraw(held);
            } else if (command == 0x10) {
                _swap(inputs[i]);
            } else if (command == 0x0b) {
                // WRAP_ETH(recipient, amount): the router's whole ether balance, to the recipient.
                (address recipient, uint256 amount) = abi.decode(inputs[i], (address, uint256));
                require(amount == 1 << 255, "KeyedPoolFront: wrap amount");
                uint256 balance = address(this).balance;
                if (balance > 0) {
                    weth.deposit{value: balance}();
                    address to = _map(recipient);
                    if (to != address(this)) weth.transfer(to, balance);
                }
            } else if (command == 0x04) {
                // SWEEP(token, recipient, amountMin): the router's whole balance of the token.
                (address token, address recipient, uint256 amountMin) = abi.decode(inputs[i], (address, address, uint256));
                uint256 balance = IERC20(token).balanceOf(address(this));
                require(balance >= amountMin, "KeyedPoolFront: sweep amount");
                if (balance > 0) IERC20(token).safeTransfer(_map(recipient), balance);
            } else {
                revert("KeyedPoolFront: command");
            }
        }
    }

    /// @dev The swap command: swap along the path, settle the token paid from this contract's
    ///      balance, take what was bought to the recipient — the only actions, in the only order,
    ///      the executor sends.
    function _swap(bytes calldata input) private {
        (bytes memory actions, bytes[] memory params) = abi.decode(input, (bytes, bytes[]));
        require(actions.length == 3 && actions[0] == 0x07 && actions[1] == 0x0b && actions[2] == 0x0e, "KeyedPoolFront: actions");
        Swap memory swap = _decodeSwap(params[0]);
        (address settleCurrency, uint256 settleAmount, bool payerIsUser) = abi.decode(params[1], (address, uint256, bool));
        require(settleCurrency == swap.currencyIn && settleAmount == 0 && !payerIsUser, "KeyedPoolFront: settle");
        (address takeCurrency, address recipient, uint256 takeAmount) = abi.decode(params[2], (address, address, uint256));
        address currencyOut = swap.currencies[swap.currencies.length - 1];
        require(takeCurrency == currencyOut && takeAmount == 0, "KeyedPoolFront: take");
        bool toItself = recipient == address(2);
        require(!toItself || currencyOut == address(0), "KeyedPoolFront: take recipient");

        uint256 spend = (uint256(swap.amountIn) * spendBps) / 10_000;
        // Native ether paid is what an earlier command unwrapped; the V3 pool behind takes it wrapped.
        if (swap.currencyIn == address(0)) weth.deposit{value: spend}();
        IERC20(_erc20(swap.currencyIn)).forceApprove(address(router), spend);
        uint256 amountOut = router.exactInput(
            IFrontRouter.ExactInputParams({
                path: _v3Path(swap.currencyIn, swap.currencies, swap.fees),
                recipient: toItself ? address(this) : recipient,
                deadline: block.timestamp,
                amountIn: spend,
                amountOutMinimum: swap.amountOutMinimum
            })
        );
        // Native ether taken to the router itself is held as ether, for a wrap to follow.
        if (toItself) weth.withdraw(amountOut);
    }

    /// @dev What a swap's params say, decoded from the router's own shape for them.
    function _decodeSwap(bytes memory params) internal pure virtual returns (Swap memory);

    function _quote(address currencyIn, address[] memory currencies, uint24[] memory fees, uint128 amount)
        internal
        returns (uint256 amountOut, uint256 gasEstimate)
    {
        (amountOut, , , gasEstimate) = quoter.quoteExactInput(_v3Path(currencyIn, currencies, fees), amount);
    }

    function _register(bytes32 id, address currency0, address currency1, uint24 fee) internal {
        pools[id] = Pool({currency0: currency0, currency1: currency1, fee: fee, known: true});
    }

    function _poolOf(bytes32 id) private view returns (address) {
        Pool memory pool = pools[id];
        if (!pool.known) return address(0);
        return factory.getPool(_erc20(pool.currency0), _erc20(pool.currency1), pool.fee);
    }

    function _erc20(address currency) private view returns (address) {
        return currency == address(0) ? address(weth) : currency;
    }

    /// @dev A recipient as the routers read one: 1 is whoever called, 2 the router itself.
    function _map(address recipient) private view returns (address) {
        return recipient == address(1) ? msg.sender : recipient == address(2) ? address(this) : recipient;
    }

    /// @dev The V3 path of the pools these currencies and fees find: each fee is its V3 pool's tier.
    function _v3Path(address currencyIn, address[] memory currencies, uint24[] memory fees) private view returns (bytes memory packed) {
        packed = abi.encodePacked(_erc20(currencyIn));
        for (uint256 i; i < currencies.length; ++i) packed = abi.encodePacked(packed, fees[i], _erc20(currencies[i]));
    }

    receive() external payable {}
}

/// @notice PancakeSwap Infinity's CL pool manager, CL quoter and Universal Router, in front of V3 pools.
contract InfinityFront is KeyedPoolFront {
    struct PoolKey {
        address currency0;
        address currency1;
        address hooks;
        address poolManager;
        uint24 fee;
        bytes32 parameters;
    }

    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        address hooks;
        address poolManager;
        bytes hookData;
        bytes32 parameters;
    }

    struct QuoteExactParams {
        address exactCurrency;
        PathKey[] path;
        uint128 exactAmount;
    }

    struct CLSwapExactInputParams {
        address currencyIn;
        PathKey[] path;
        uint128 amountIn;
        uint128 amountOutMinimum;
    }

    constructor(
        IFrontFactory factory_,
        IFrontRouter router_,
        IFrontQuoter quoter_,
        IFrontWeth weth_
    ) KeyedPoolFront(factory_, router_, quoter_, weth_) {}

    /// @notice Makes a pool known by its key, as initializing it on Infinity would.
    function register(PoolKey calldata key) external returns (bytes32 id) {
        id = keccak256(abi.encode(key));
        _register(id, key.currency0, key.currency1, key.fee);
    }

    function quoteExactInput(QuoteExactParams memory params) external returns (uint256 amountOut, uint256 gasEstimate) {
        (address[] memory currencies, uint24[] memory fees) = _hops(params.path);
        return _quote(params.exactCurrency, currencies, fees, params.exactAmount);
    }

    function _decodeSwap(bytes memory params) internal pure override returns (Swap memory swap) {
        CLSwapExactInputParams memory decoded = abi.decode(params, (CLSwapExactInputParams));
        (address[] memory currencies, uint24[] memory fees) = _hops(decoded.path);
        swap = Swap(decoded.currencyIn, currencies, fees, decoded.amountIn, decoded.amountOutMinimum);
    }

    function _hops(PathKey[] memory path) private pure returns (address[] memory currencies, uint24[] memory fees) {
        currencies = new address[](path.length);
        fees = new uint24[](path.length);
        for (uint256 i; i < path.length; ++i) (currencies[i], fees[i]) = (path[i].intermediateCurrency, path[i].fee);
    }
}

/// @notice Uniswap v4's StateView, V4Quoter and Universal Router (v2.1.2), in front of V3 pools.
contract UniswapV4Front is KeyedPoolFront {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    struct QuoteExactParams {
        address exactCurrency;
        PathKey[] path;
        uint128 exactAmount;
    }

    struct ExactInputParams {
        address currencyIn;
        PathKey[] path;
        uint256[] minHopPriceX36;
        uint128 amountIn;
        uint128 amountOutMinimum;
    }

    constructor(
        IFrontFactory factory_,
        IFrontRouter router_,
        IFrontQuoter quoter_,
        IFrontWeth weth_
    ) KeyedPoolFront(factory_, router_, quoter_, weth_) {}

    /// @notice Makes a pool known by its key, as initializing it on v4 would.
    function register(PoolKey calldata key) external returns (bytes32 id) {
        id = keccak256(abi.encode(key));
        _register(id, key.currency0, key.currency1, key.fee);
    }

    function quoteExactInput(QuoteExactParams memory params) external returns (uint256 amountOut, uint256 gasEstimate) {
        (address[] memory currencies, uint24[] memory fees) = _hops(params.path);
        return _quote(params.exactCurrency, currencies, fees, params.exactAmount);
    }

    function _decodeSwap(bytes memory params) internal pure override returns (Swap memory swap) {
        ExactInputParams memory decoded = abi.decode(params, (ExactInputParams));
        require(decoded.minHopPriceX36.length == 0, "UniswapV4Front: hop prices");
        (address[] memory currencies, uint24[] memory fees) = _hops(decoded.path);
        swap = Swap(decoded.currencyIn, currencies, fees, decoded.amountIn, decoded.amountOutMinimum);
    }

    function _hops(PathKey[] memory path) private pure returns (address[] memory currencies, uint24[] memory fees) {
        currencies = new address[](path.length);
        fees = new uint24[](path.length);
        for (uint256 i; i < path.length; ++i) (currencies[i], fees[i]) = (path[i].intermediateCurrency, path[i].fee);
    }
}
