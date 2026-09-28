# Deployments

The address tables below are generated from the Hardhat Ignition records in
`ignition/deployments/`. Every contract listed is owned by the deployer account
`0x789Cd51Fcc5326508ab7f66ab45d2f3a8bb6f888`.

Each deployed contract's verified source is on the chain's explorer. That source is the one that
matches its bytecode. Where it differs from this repository, the notes under each network say so.

## Robinhood Chain mainnet (chain id 4663)

Deployed from 27 September 2026, starting at block 73821560.

| Asset | Address |
| ----- | ------- |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG (6 decimals) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

| Contract | Ignition future | Address |
| -------- | --------------- | ------- |
| CoinCreator | `Launchpad#CoinCreator` | [`0xe7AB0F13C070632EFD76cb90F6BbFBe581b22Da2`](https://robinhoodchain.blockscout.com/address/0xe7AB0F13C070632EFD76cb90F6BbFBe581b22Da2) |
| CoinFactory | `Launchpad#CoinFactory` | [`0xDadC43dbf60eA5d4598C39500Ede46De6A14c0d0`](https://robinhoodchain.blockscout.com/address/0xDadC43dbf60eA5d4598C39500Ede46De6A14c0d0) |
| CoinListingManager | `Launchpad#CoinListingManager` | [`0xcF4EEc2a27ff46f1dB10Ef6ce3a65704EF5997E4`](https://robinhoodchain.blockscout.com/address/0xcF4EEc2a27ff46f1dB10Ef6ce3a65704EF5997E4) |
| FeeEscrow | `Launchpad#FeeEscrow` | [`0x836a770fB5f88E19282D2Dc7342d81b2B6fA6178`](https://robinhoodchain.blockscout.com/address/0x836a770fB5f88E19282D2Dc7342d81b2B6fA6178) |
| Formula | `Launchpad#Formula` | [`0x3f701DA02e313da123ba502CaDd989841fB30547`](https://robinhoodchain.blockscout.com/address/0x3f701DA02e313da123ba502CaDd989841fB30547) |
| HolderRewards | `Launchpad#HolderRewards` | [`0xEa5AFB7bA39c6259f5717550884D441E3B1dD9aC`](https://robinhoodchain.blockscout.com/address/0xEa5AFB7bA39c6259f5717550884D441E3B1dD9aC) |
| LiquidityManager | `Launchpad#LiquidityManager` | [`0x921b8c2E5096187460a1d95EF7ebb7CbC30E8154`](https://robinhoodchain.blockscout.com/address/0x921b8c2E5096187460a1d95EF7ebb7CbC30E8154) |
| OutbidBuyback | `OutbidEconomy#OutbidBuyback` | [`0x9FBb9614bA47F2FD7ECFaa16880B535034a4eEF5`](https://robinhoodchain.blockscout.com/address/0x9FBb9614bA47F2FD7ECFaa16880B535034a4eEF5) |
| OutbidMarket | `Outbidfun#OutbidMarket` | [`0x1Eaca99186F58A258B08fd7A25524A20c31def63`](https://robinhoodchain.blockscout.com/address/0x1Eaca99186F58A258B08fd7A25524A20c31def63) |
| OutbidMarket | `OutbidMarketV2#OutbidMarket` | [`0xad7ca6bf8c0ab7793eBEC811Da5F54304383669A`](https://robinhoodchain.blockscout.com/address/0xad7ca6bf8c0ab7793eBEC811Da5F54304383669A) |
| QuoterV2 | `UniswapV3#QuoterV2` | [`0xd7fE45aA87fBaF6c5Ff58e897b985156f70BB064`](https://robinhoodchain.blockscout.com/address/0xd7fE45aA87fBaF6c5Ff58e897b985156f70BB064) |
| RevenueRouter | `OutbidEconomy#RevenueRouter` | [`0xeEc171B409788644acBf1c50B825Cc6d9682D9b7`](https://robinhoodchain.blockscout.com/address/0xeEc171B409788644acBf1c50B825Cc6d9682D9b7) |
| SwapExecutor | `SwapExecutor#SwapExecutor` | [`0x4Db20d13fB8016632164f1381317e7Cfc51C1ffF`](https://robinhoodchain.blockscout.com/address/0x4Db20d13fB8016632164f1381317e7Cfc51C1ffF) |
| SwapRouter | `UniswapV3#SwapRouter` | [`0xf5f476d0F06f20E5932Fbf599FA3C8be53081a9B`](https://robinhoodchain.blockscout.com/address/0xf5f476d0F06f20E5932Fbf599FA3C8be53081a9B) |
| Treasury | `Outbidfun#Treasury` | [`0xE693C039cc91F8dbe64586245565388e2e44C0A4`](https://robinhoodchain.blockscout.com/address/0xE693C039cc91F8dbe64586245565388e2e44C0A4) |
| UniswapV3Factory | `UniswapV3#UniswapV3Factory` | [`0x9ea072F355B8c92949b6799579062B6Eb8d10732`](https://robinhoodchain.blockscout.com/address/0x9ea072F355B8c92949b6799579062B6Eb8d10732) |

- `Outbidfun#OutbidMarket` is the first outbid market. It is frozen, and its board was carried
  over to `OutbidMarketV2#OutbidMarket` on 28 September 2026.
- `SwapExecutor` and `OutbidMarketV2#OutbidMarket` were deployed from this source, apart from
  license headers.
- The `Launchpad` and `OutbidEconomy` modules were deployed from an earlier revision.
  `Coin`, `HolderRewards` and `RevenueRouter` have changed in this repository since then, and
  so have the license headers of the files that were `UNLICENSED`. A redeployment from this source
  will replace them. Until then, each one's verified source on the explorer is authoritative.

## Robinhood Chain testnet (chain id 46630)

| Asset | Address |
| ----- | ------- |
| WETH9 (deployed for the testnet) | `0xe7AB0F13C070632EFD76cb90F6BbFBe581b22Da2` |
| Test USDG (`MockERC20`, 6 decimals, open `mint`) | `0x836a770fB5f88E19282D2Dc7342d81b2B6fA6178` |

| Contract | Ignition future | Address |
| -------- | --------------- | ------- |
| CoinCreator | `Launchpad#CoinCreator` | [`0x4Db20d13fB8016632164f1381317e7Cfc51C1ffF`](https://explorer.testnet.chain.robinhood.com/address/0x4Db20d13fB8016632164f1381317e7Cfc51C1ffF) |
| CoinFactory | `Launchpad#CoinFactory` | [`0xCB4F4Efa81fc954dB79936C79A580Fce3fd38C62`](https://explorer.testnet.chain.robinhood.com/address/0xCB4F4Efa81fc954dB79936C79A580Fce3fd38C62) |
| CoinListingManager | `Launchpad#CoinListingManager` | [`0xe54e5d8Fe57a6a4bc49777B89b43bE57C57CE28d`](https://explorer.testnet.chain.robinhood.com/address/0xe54e5d8Fe57a6a4bc49777B89b43bE57C57CE28d) |
| FeeEscrow | `Launchpad#FeeEscrow` | [`0x020db5b426a8E8cb30c21dEdEd9b5991E94A2A87`](https://explorer.testnet.chain.robinhood.com/address/0x020db5b426a8E8cb30c21dEdEd9b5991E94A2A87) |
| Formula | `Launchpad#Formula` | [`0x67b2125AD581FD12E562386f9151F27f8C4142E5`](https://explorer.testnet.chain.robinhood.com/address/0x67b2125AD581FD12E562386f9151F27f8C4142E5) |
| HolderRewards | `Launchpad#HolderRewards` | [`0x103db871e25732272f035714ebfE37dC6831Bd28`](https://explorer.testnet.chain.robinhood.com/address/0x103db871e25732272f035714ebfE37dC6831Bd28) |
| LiquidityManager | `Launchpad#LiquidityManager` | [`0xdb3b493D371103847D189cbEf6866Af3e374bfC9`](https://explorer.testnet.chain.robinhood.com/address/0xdb3b493D371103847D189cbEf6866Af3e374bfC9) |
| OutbidBuyback | `OutbidEconomy#OutbidBuyback` | [`0x0e4ecbc6867cAAC2D15E82927EaF9754230ba15c`](https://explorer.testnet.chain.robinhood.com/address/0x0e4ecbc6867cAAC2D15E82927EaF9754230ba15c) |
| OutbidMarket | `Outbidfun#OutbidMarket` | [`0xB2D1E7c1b9D7Aa632cD73984D3fb1526Bc5EA235`](https://explorer.testnet.chain.robinhood.com/address/0xB2D1E7c1b9D7Aa632cD73984D3fb1526Bc5EA235) |
| QuoterV2 | `UniswapV3#QuoterV2` | [`0x3C1520e975910f84D94048E863Ca2176D70588f2`](https://explorer.testnet.chain.robinhood.com/address/0x3C1520e975910f84D94048E863Ca2176D70588f2) |
| RevenueRouter | `OutbidEconomy#RevenueRouter` | [`0x5F4f566cd20A140A7902Cb4b8d77D09eB0001D92`](https://explorer.testnet.chain.robinhood.com/address/0x5F4f566cd20A140A7902Cb4b8d77D09eB0001D92) |
| SwapRouter | `UniswapV3#SwapRouter` | [`0x4295f435208c4D161681426Cd586f454961CFD05`](https://explorer.testnet.chain.robinhood.com/address/0x4295f435208c4D161681426Cd586f454961CFD05) |
| Treasury | `Outbidfun#Treasury` | [`0xe5d9Bb7231792591F92B6538622691E65b80cD5b`](https://explorer.testnet.chain.robinhood.com/address/0xe5d9Bb7231792591F92B6538622691E65b80cD5b) |
| UniswapV3Factory | `UniswapV3#UniswapV3Factory` | [`0x6F72dD1C961Bc7883921d6D6aE914264AB4CE363`](https://explorer.testnet.chain.robinhood.com/address/0x6F72dD1C961Bc7883921d6D6aE914264AB4CE363) |

- The launchpad and economy contracts match this source, apart from license headers.
- The testnet's `OutbidMarket` predates `bidVia` and the `SwapExecutor`, which is not deployed there.
