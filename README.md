# outbidfun.lol contracts

The smart contracts behind [outbidfun.lol](https://outbidfun.lol), a token launchpad on
[Robinhood Chain](https://robinhoodchain.blockscout.com) where coins outbid each other for the
front page.

A coin launches on a bonding curve priced in an asset its creator picks from the ones the
platform lists (wrapped ether, USDG, tokenised shares). It trades on its curve until the reserve
reaches that asset's cap, then graduates into a Uniswap V3 pool against the same asset. The pool
is opened by the platform's own V3 deployment, and its liquidity is locked forever.
Separately, communities bid in USDG for their coin's place on the front page. Each bid buys and
burns the coin it backs (75%), funds the $OUTBID buyback (20%) and the treasury (5%).

Deployed addresses are in [DEPLOYMENTS.md](DEPLOYMENTS.md).

## Contracts

| Contract | What it is |
| -------- | ---------- |
| `CoinFactory` / `CoinDeployer` | The launchpad. Lists the assets a coin can be priced in and the cap each graduates at, holds the curve parameters and fee terms for new coins, deploys each coin at a CREATE2 address derived from its symbol (`getAddress`), and answers `isMemeCoinLegit`. |
| `CoinCreator` | Holds `Coin`'s creation code for the factory, which could not carry it and stay under the size limit. |
| `Coin` | One launched coin: an ERC20 with its bonding curve. `buy`, `sell`, `price`, the fee terms it launched with (immutables), and graduation. It holds its own curve reserve. |
| `Formula` / `Power` | The curve's maths: `reserve = k · supply^(1 + powerN/powerD)`, evaluated with Bancor's fixed-point power function. |
| `HolderRewards` | A reward coin's distributor (cloned per coin): shares a cut of every transfer, and optionally the creator's fees, among holders. |
| `FeeEscrow` | Where a creator's share of fees waits to be claimed. |
| `CoinListingManager` | Owns the Uniswap V3 factory, so only it can open pools. At graduation it opens the coin's pool at the curve's final price and mints one full-range position it can never withdraw. `collectFees` sweeps that position's swap fees. |
| `LiquidityManager` | Third-party liquidity for any pool on the platform's V3: add, withdraw, collect. Positions are not transferable. |
| `OutbidMarket` | The paid ranking. Bids are in USDG; `bidVia` swaps anything else to USDG through `SwapExecutor`. Every bid is split on the spot: buy-and-burn of the coin, the $OUTBID buyback, the treasury. |
| `SwapExecutor` | Runs a trade routed across several AMMs in one transaction. It checks the trader's minimum, deadline and recipient, and holds nothing between transactions. |
| `RevenueRouter` | The door protocol fees come in by, in any asset. It splits each asset between the buyback (80%) and operations (20%). |
| `OutbidBuyback` / `PonsBuybackVenue` | Collect the buyback share and, once enabled with $OUTBID and a venue, buy $OUTBID and burn it. $OUTBID itself launches on PONS. |
| `Treasury` | The operations wallet. |
| `WETH9` | For chains without a canonical WETH (the Robinhood Chain testnet). |
| `uniswap-v3/` | Vendored Uniswap V3 core, plus the `SwapRouter` and `QuoterV2` periphery. One change: only the factory's owner can create pools. See [its README](contracts/uniswap-v3/README.md). |

`contracts/test/` holds mocks used only by the test suite.

## Fees and where they go

| Paid by | Amount (current terms) | Goes to |
| ------- | ---------------------- | ------- |
| Every curve buy and sell | 1% of the reserve-asset leg | 30% to the protocol (`CoinListingManager.treasury()`, the `RevenueRouter`), 70% to the creator via `FeeEscrow` |
| Creator tax, if the creator set one | up to 10%, fixed at launch | the creator |
| Snipe tax on buys in the first 3 seconds | 99% falling to 0 | split like the trading fee |
| Launch | 0.0005 ETH | the protocol |
| Swaps in a graduated coin's pool | the pool's fee tier (1%) | the locked position's fees: 30% protocol, 70% creator |
| A bid | the bid | 75% buys the coin and burns it, 20% to `OutbidBuyback`, 5% to the treasury |

Protocol revenue reaching the `RevenueRouter` is split 80% to the $OUTBID buyback and 20% to
operations. Every term a coin launched with is an immutable on the coin. The owner can change
terms for coins launched later, within hard caps in `CoinDeployer`.

## Trust model

The contracts are owned. The owner can:

- list and pause quote assets;
- change the fee terms for coins launched later, where the trading fee and creator tax are capped
  in `CoinDeployer`, and change the launch fee;
- change the revenue and bid splits and where they go;
- set the buyback venue and keepers;
- list the routers `SwapExecutor` may call.

The owner cannot touch a curve's reserve, withdraw graduated liquidity, or change the terms of a
coin already launched. [DEPLOYMENTS.md](DEPLOYMENTS.md) names each deployment's owner.

## Development

Requires Node.js 20.9+ and pnpm.

```sh
pnpm install
pnpm compile      # hardhat compile, then regenerate abi/
pnpm test
pnpm typecheck
```

Two compilers run side by side: Solidity 0.8.24 for the protocol and 0.7.6 for the vendored
Uniswap V3. The V3 contracts use upstream's exact settings, so the pool's init code hash is
canonical, and `test/UniswapV3.test.ts` asserts it.

`abi/` exports every contract's ABI as a TypeScript `const`, for use with viem.

### Local chain

```sh
pnpm node         # a Hardhat node on :8545
pnpm seed:local   # deploys everything, launches, trades, graduates and bids, then prints the addresses
```

### Deploying

Deployments are Hardhat Ignition modules (`ignition/modules`) with a parameters file per network
(`ignition/config`). Copy `.env.example` to `.env` and set `DEPLOYER_PRIVATE_KEY`, then:

```sh
pnpm preflight --network robinhoodTestnet   # RPC, key, balance and WETH checks before spending gas
pnpm deploy:testnet                         # the launchpad, the market and the platform's Uniswap V3
pnpm quote:testnet -- --parameters ignition/config/quote-usdg-testnet.json --deployment-id chain-46630-quote-usdg
pnpm economy:testnet                        # RevenueRouter and OutbidBuyback, wired in
pnpm smoke --network robinhoodTestnet       # launches a coin and bids on it
```

The `*:mainnet` scripts do the same on Robinhood Chain mainnet with `ignition/config/base.json`.
`scripts/verify.mjs` verifies a whole deployment on the explorers, and
`scripts/transfer-ownership.ts` hands every contract to a multisig.

## Security

If you find a vulnerability, please report it privately through GitHub's private vulnerability
reporting on this repository (Security → Report a vulnerability) rather than opening a public
issue.

## License

MIT, except for third-party code, which keeps its own license. See [LICENSE](LICENSE) and
[NOTICE.md](NOTICE.md).
