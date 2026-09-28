# Uniswap V3, vendored

outbidfun.lol runs its own Uniswap V3 deployment on Robinhood Chain. Graduated coins are listed
here, not on an outside DEX. These are the upstream sources, cloned rather than pulled from
npm so the repository is self-contained and the one change we make is visible in review.

| Directory    | Source                                                                    |
| ------------ | ------------------------------------------------------------------------- |
| `core/`      | [Uniswap/v3-core](https://github.com/Uniswap/v3-core) tag `v1.0.0`, all of `contracts/` except `test/` |
| `periphery/` | [Uniswap/v3-periphery](https://github.com/Uniswap/v3-periphery) commit `0682387`: `SwapRouter`, `lens/QuoterV2` and everything they import |

`periphery/external/openzeppelin/` holds the two OpenZeppelin 3.x interfaces the periphery
imports, restated for Solidity 0.7 because the rest of the protocol uses OpenZeppelin 5.

## What changed from upstream

1. **`core/UniswapV3Factory.sol`: only the owner can create pools.** One `require` in
   `createPool`. The `CoinListingManager` owns the factory and opens each coin's pool in the
   transaction that fills its curve, priced where the curve ended. Since nobody else can
   create pools, there is nothing to pre-create or mis-price.
   The canonical factory is 24,535 bytes against a 24,576-byte limit, which is why this is a
   single line rather than a separate role.
2. **Imports** of `@uniswap/v3-core/...` and `@openzeppelin/...` are rewritten to relative
   paths.
3. **Pragmas** with no upper bound gain `<0.8.0`, so Hardhat never compiles a library
   standalone with the 0.8 compiler, where its unchecked arithmetic would not build.

Nothing else is touched. The compiler settings in `hardhat.config.ts` match upstream
(0.7.6, istanbul, optimizer 800 for core and 1,000,000 for the periphery, no metadata hash),
so `UniswapV3Pool` builds to the canonical creation code and `PoolAddress.POOL_INIT_CODE_HASH`
still derives real pool addresses. `test/UniswapV3.test.ts` asserts that hash; if it ever
fails, either the settings drifted or the pool source did.

## Not vendored

`NonfungiblePositionManager` and the NFT descriptor. They were left out because the protocol's
own liquidity needs no manager: the listing manager mints one full-range position per coin
straight through the mint callback and never withdraws it, so there is nothing to tokenise.

Third-party liquidity does not go through them either. `contracts/LiquidityManager.sol` is the
platform's own position manager — 0.8 code alongside the rest of the protocol, not vendored 0.7
periphery — and it answers the mint callback the same way. It is not an NFT: a position is the
tuple `(owner, token, quote, fee, tickLower, tickUpper)` and is not transferable, which is what
keeps it a few hundred lines instead of a few thousand. Depositors sharing a range share this
contract's one position inside the pool and split its fees by the same `feeGrowthInside`
arithmetic Uniswap's own manager uses. It resolves pools through `getPool` on this factory by
`(token, quote, fee)`, rather than through the launchpad's `poolOf`, so it covers every pool the
factory holds and not only the ones the launchpad's registry lists.

Nothing in the pools themselves had to change for that, which is the point of the note above:
`mint` was always open to any contract that could pay the callback.
