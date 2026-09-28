/**
 * Fills a local Hardhat node with the whole platform, so every write path (launch,
 * buy on the curve, graduate, trade in the pool, outbid, lose a race) can be
 * exercised end to end from the web app.
 *
 *   pnpm --filter @outbidfun/protocol node          # terminal 1
 *   pnpm --filter @outbidfun/protocol seed:local    # terminal 2
 *
 * Deploys WETH9, two stand-ins for the real-world assets the platform lists (a six-decimal
 * dollar and an eighteen-decimal tokenised share), the Uniswap V3 factory, router and quoter,
 * the curve, the treasury, the listing manager, the CoinFactory and the OutbidMarket, then the
 * OUTBID economy, points the listing manager at its revenue router and the market at its vault;
 * lists the
 * three assets; launches coins priced in each of them, trades some, graduates one in ether and
 * one in dollars into their pools, places bids, and splits what the router took in. Prints the
 * environment lines to paste into apps/web/.env.
 */
import hre from 'hardhat';
import { formatUnits, parseEther, parseUnits, zeroAddress, type Address } from 'viem';

/** The board's minimum bid and step, in dollars at eighteen decimals. */
const MIN_BID = parseEther('1');
const INCREMENT = parseEther('5');
const POOL_FEE = 10_000;
/** What a launch costs, as the factory ships it. */
const LAUNCH_FEE = parseEther('0.0005');

/** An asset a coin can be priced in, as the seed deploys it. */
type SeedAsset = {
  key: 'WETH' | 'USDG' | 'AAPLX';
  name: string;
  symbol: string;
  decimals: number;
  /** Whole units at which a coin priced in it graduates. */
  cap: string;
  /** Whole units every wallet starts with. */
  balance: string;
};

const ASSETS: SeedAsset[] = [
  // Every cap is about 4.2 ETH worth, PONS's graduation target, at the rates the docs assume.
  { key: 'WETH', name: 'Wrapped Ether', symbol: 'WETH', decimals: 18, cap: '4.2', balance: '400' },
  { key: 'USDG', name: 'Global Dollar', symbol: 'USDG', decimals: 6, cap: '14000', balance: '2000000' },
  { key: 'AAPLX', name: 'Tokenized Apple', symbol: 'AAPLx', decimals: 18, cap: '56', balance: '5000' },
];

type SeedCoin = {
  name: string;
  symbol: string;
  quote: SeedAsset['key'];
  /** The creator's own tax on trades, in basis points. Most coins set none. */
  creatorTaxBps?: number;
  /** A reward coin's share of every transfer for its holders, in basis points, and whether the
   *  creator gives their fees to the holders too. Most coins are standard. */
  rewardFeeBps?: number;
  shareFeesWithHolders?: boolean;
  /** Whole units of the quote asset bought on the curve, in order. */
  buys: string[];
  /** Whole USDG bid on the outbid board, which takes only coins priced in USDG: 75% of each buys
   *  the coin and burns it. */
  bids: string[];
  /** Whole units of the quote asset swapped into the coin's pool, for a coin that graduates. */
  swaps?: string[];
};

const COINS: SeedCoin[] = [
  { name: 'Front Page Pepe', symbol: 'PEPE', quote: 'WETH', buys: ['1.2', '0.8'], bids: [] },
  { name: 'Federal Reserve', symbol: 'FED', quote: 'USDG', creatorTaxBps: 300, buys: ['1500', '900'], bids: ['800', '1500'] },
  { name: 'Congress Coin', symbol: 'CONGRESS', quote: 'AAPLX', buys: ['12'], bids: [] },
  { name: 'Bureau of Memes', symbol: 'BUREAU', quote: 'USDG', buys: [], bids: ['900'] },
  // Graduates in ether: a buy well past the 4.2 ETH cap fills the curve and seeds the pool.
  { name: 'Bull Market Enjoyer', symbol: 'BULL', quote: 'WETH', buys: ['1', '6'], bids: [], swaps: ['0.75', '2.5', '0.4'] },
  // Graduates in dollars, so the dollar path through the pool is exercised too. A reward coin
  // whose creator gives their fees to holders, so rewards run through the curve, a bid and the pool.
  { name: 'Greenback', symbol: 'BUCK', quote: 'USDG', creatorTaxBps: 100, rewardFeeBps: 300, shareFeesWithHolders: true, buys: ['4000', '14000'], bids: ['300'], swaps: ['250', '1200'] },
];

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const wallets = await hre.viem.getWalletClients();
  const [owner] = wallets;
  if (!owner) throw new Error('no wallet clients available');
  const fromBlock = await publicClient.getBlockNumber();

  // The assets coins can be priced in. WETH is the real thing; the others stand in for the
  // stablecoins and tokenised shares a production deployment would list.
  const weth = await hre.viem.deployContract('WETH9', []);
  const tokens = new Map<SeedAsset['key'], { address: Address; decimals: number }>();
  tokens.set('WETH', { address: weth.address, decimals: 18 });
  for (const asset of ASSETS) {
    if (asset.key === 'WETH') continue;
    const token = await hre.viem.deployContract('MockERC20', [asset.name, asset.symbol, asset.decimals, 0n]);
    tokens.set(asset.key, { address: token.address, decimals: asset.decimals });
  }
  for (const wallet of wallets) {
    for (const asset of ASSETS) {
      const token = tokens.get(asset.key)!;
      const amount = parseUnits(asset.balance, asset.decimals);
      if (asset.key === 'WETH') {
        await weth.write.deposit({ value: amount, account: wallet.account });
      } else {
        const mock = await hre.viem.getContractAt('MockERC20', token.address);
        await mock.write.mint([wallet.account.address, amount]);
      }
    }
  }

  // The platform, in the order the Launchpad Ignition module deploys it.
  const v3Factory = await hre.viem.deployContract('UniswapV3Factory', []);
  const swapRouter = await hre.viem.deployContract('SwapRouter', [v3Factory.address, weth.address]);
  const quoter = await hre.viem.deployContract('QuoterV2', [v3Factory.address, weth.address]);
  const treasury = await hre.viem.deployContract('Treasury', [owner.account.address]);
  const feeEscrow = await hre.viem.deployContract('FeeEscrow', []);
  const listingManager = await hre.viem.deployContract('CoinListingManager', [
    owner.account.address,
    treasury.address,
    v3Factory.address,
    feeEscrow.address,
    POOL_FEE,
  ]);
  const coinCreator = await hre.viem.deployContract('CoinCreator', [owner.account.address]);
  const holderRewards = await hre.viem.deployContract('HolderRewards', []);
  const coinFactory = await hre.viem.deployContract('CoinFactory', [
    listingManager.address,
    feeEscrow.address,
    coinCreator.address,
    holderRewards.address,
  ]);
  await coinCreator.write.setFactory([coinFactory.address]);
  await listingManager.write.setCoinFactory([coinFactory.address]);
  await v3Factory.write.setOwner([listingManager.address]);
  const liquidityManager = await hre.viem.deployContract('LiquidityManager', [v3Factory.address]);
  // Bids are paid in USDG. A local node has no Uniswap V4 PoolManager, so the market is given
  // none and takes USDG only; paying with ether needs the real chain. The treasury stands in for
  // the buyback vault until the vault exists, below.
  const auction = await hre.viem.deployContract('OutbidMarket', [
    owner.account.address,
    tokens.get('USDG')!.address,
    weth.address,
    zeroAddress,
    treasury.address,
    treasury.address,
    MIN_BID,
    INCREMENT,
  ]);
  await auction.write.setRegistry([coinFactory.address]);
  for (const asset of ASSETS) {
    const token = tokens.get(asset.key)!;
    await coinFactory.write.setQuoteAsset([token.address, parseUnits(asset.cap, asset.decimals), true]);
  }

  // The OUTBID economy, so every fee below goes through the router — 80% to the buyback vault, 20%
  // to operations (the treasury) — and every bid is split by the market itself: 75% buys and burns
  // the coin, 20% to the vault, 5% to the treasury. $OUTBID launches on PONS, which is not on a
  // local node, so the vault is left as it is before launch: collecting, not yet enabled.
  const buyback = await hre.viem.deployContract('OutbidBuyback', [
    owner.account.address,
    weth.address,
    v3Factory.address,
    6n * 60n * 60n, // cooldown
  ]);
  const revenueRouter = await hre.viem.deployContract('RevenueRouter', [
    owner.account.address,
    buyback.address,
    treasury.address,
    8000n,
    2000n,
  ]);
  await listingManager.write.setTreasury([revenueRouter.address]);
  await auction.write.setDestinations([buyback.address, treasury.address]);

  /** Approves and spends `amount` of a coin's quote asset on its curve. */
  async function buy(coin: Address, quote: SeedAsset['key'], wallet: (typeof wallets)[number], amount: bigint) {
    const token = await hre.viem.getContractAt('MockERC20', tokens.get(quote)!.address, { client: { wallet } });
    let hash = await token.write.approve([coin, amount], { account: wallet.account });
    await publicClient.waitForTransactionReceipt({ hash });
    const contract = await hre.viem.getContractAt('Coin', coin);
    hash = await contract.write.buy([amount, 0n], { account: wallet.account });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  // Launch, trade and bid.
  const launched: { symbol: string; address: Address; quote: SeedAsset['key'] }[] = [];
  let index = 0;
  for (const coin of COINS) {
    const creator = wallets[(index + 1) % wallets.length] ?? owner;
    const quote = tokens.get(coin.quote)!;
    let hash = await coinFactory.write.deploy(
      [
        {
          name: coin.name,
          symbol: coin.symbol,
          description: '',
          image: '',
          socials: '',
          quoteAsset: quote.address,
          preBuy: 0n,
          creatorFeeRecipient: zeroAddress,
          creatorTaxBps: coin.creatorTaxBps ?? 0,
          rewardFeeBps: coin.rewardFeeBps ?? 0,
          shareFeesWithHolders: coin.shareFeesWithHolders ?? false,
        },
        [],
      ],
      { account: creator.account, value: LAUNCH_FEE }
    );
    await publicClient.waitForTransactionReceipt({ hash });
    // The snipe tax runs for the first seconds after a launch; the seed's buyers are not snipers.
    await hre.network.provider.send('evm_increaseTime', [5]);
    await hre.network.provider.send('evm_mine', []);
    const address = await coinFactory.read.getAddress([coin.symbol]);
    launched.push({ symbol: coin.symbol, address, quote: coin.quote });

    for (const amount of coin.buys) {
      const buyer = wallets[index % wallets.length] ?? owner;
      await buy(address, coin.quote, buyer, parseUnits(amount, quote.decimals));
      index += 1;
    }
    for (const amount of coin.bids) {
      const bidder = wallets[index % wallets.length] ?? owner;
      const paid = parseUnits(amount, quote.decimals);
      const token = await hre.viem.getContractAt('MockERC20', quote.address, { client: { wallet: bidder } });
      hash = await token.write.approve([auction.address, paid], { account: bidder.account });
      await publicClient.waitForTransactionReceipt({ hash });
      hash = await auction.write.bid([address, paid, 0n, 0n], { account: bidder.account });
      await publicClient.waitForTransactionReceipt({ hash });
      index += 1;
    }

    // A graduated coin trades in its pool, so the chart and the trade list have both venues.
    for (const amount of coin.swaps ?? []) {
      const trader = wallets[index % wallets.length] ?? owner;
      const amountIn = parseUnits(amount, quote.decimals);
      const token = await hre.viem.getContractAt('MockERC20', quote.address, { client: { wallet: trader } });
      hash = await token.write.approve([swapRouter.address, amountIn], { account: trader.account });
      await publicClient.waitForTransactionReceipt({ hash });
      hash = await swapRouter.write.exactInputSingle(
        [
          {
            tokenIn: quote.address,
            tokenOut: address,
            fee: POOL_FEE,
            recipient: trader.account.address,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
            amountIn,
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: 0n,
          },
        ],
        { account: trader.account }
      );
      await publicClient.waitForTransactionReceipt({ hash });
      index += 1;
    }
  }

  // Split what the router took in, asset by asset: ether from launches, and every asset the
  // coins' fees were paid in. Bids never reach it. What has nothing pending is skipped.
  const revenueAssets: { label: string; address: Address; decimals: number }[] = [
    { label: 'ETH', address: zeroAddress, decimals: 18 },
    ...ASSETS.map((asset) => ({ label: asset.symbol, address: tokens.get(asset.key)!.address, decimals: asset.decimals })),
  ];
  for (const asset of revenueAssets) {
    if ((await revenueRouter.read.pending([asset.address])) > 0n) {
      await revenueRouter.write.allocateAndRelease([asset.address]);
    }
  }

  console.log('\nQuote assets');
  for (const asset of ASSETS) {
    console.log(`  ${asset.symbol.padEnd(6)} ${tokens.get(asset.key)!.address}  graduates at ${asset.cap} ${asset.symbol}`);
  }

  console.log('\nCoins');
  for (const coin of launched) {
    const token = await hre.viem.getContractAt('Coin', coin.address);
    const asset = ASSETS.find((entry) => entry.key === coin.quote)!;
    const cap = await token.read.cap();
    const reserve = await token.read.reserveBalance();
    const state =
      cap === 0n
        ? `graduated, pool ${await listingManager.read.poolOf([coin.address])}`
        : `${formatUnits(reserve, asset.decimals)} / ${formatUnits(cap, asset.decimals)} ${asset.symbol}`;
    console.log(`  $${coin.symbol.padEnd(9)} ${coin.address}  ${state}`);
  }

  const ranked = await auction.read.getTopTokens([BigInt(launched.length)]);
  console.log('\nOutbid board');
  for (const [position, address] of ranked.entries()) {
    const value = await auction.read.getTotalBid([address]);
    const symbol = launched.find((t) => t.address.toLowerCase() === address.toLowerCase())?.symbol;
    console.log(`  #${position + 1} $${symbol ?? address}  ${Number(formatUnits(value, 18)).toFixed(2)} USDG bid`);
  }

  console.log('\nRevenue router received / to buyback / to operations');
  for (const asset of revenueAssets) {
    const received = await revenueRouter.read.totalReceived([asset.address]);
    if (received === 0n) continue;
    const toBuyback = await revenueRouter.read.totalAllocatedToBuyback([asset.address]);
    const toOperations = await revenueRouter.read.totalAllocatedToOperations([asset.address]);
    console.log(
      `  ${asset.label.padEnd(6)} ${formatUnits(received, asset.decimals)} / ${formatUnits(toBuyback, asset.decimals)} / ${formatUnits(toOperations, asset.decimals)}`
    );
  }

  console.log('\nBuyback vault holds');
  console.log(`  ${formatUnits(await buyback.read.pendingBuyback(), 18)} ETH (ether and wrapped ether)`);
  for (const asset of ASSETS) {
    if (asset.key === 'WETH') continue;
    const held = await buyback.read.heldOf([tokens.get(asset.key)!.address]);
    if (held > 0n) console.log(`  ${formatUnits(held, asset.decimals)} ${asset.symbol}, waiting to be converted`);
  }

  console.log('\nTreasury (operations) holds');
  console.log(`  ${formatUnits(await publicClient.getBalance({ address: treasury.address }), 18)} ETH`);
  for (const asset of ASSETS) {
    const token = await hre.viem.getContractAt('MockERC20', tokens.get(asset.key)!.address);
    console.log(`  ${formatUnits(await token.read.balanceOf([treasury.address]), asset.decimals)} ${asset.symbol}`);
  }

  console.log('\nCreators can claim');
  for (const coin of launched) {
    const token = await hre.viem.getContractAt('Coin', coin.address);
    const asset = ASSETS.find((entry) => entry.key === coin.quote)!;
    const recipient = await token.read.creatorFeeRecipient();
    const owed = await feeEscrow.read.balanceOf([recipient, tokens.get(coin.quote)!.address]);
    console.log(`  $${coin.symbol.padEnd(9)} ${formatUnits(owed, asset.decimals)} ${asset.symbol} for ${recipient}`);
  }

  console.log('\napps/web/.env');
  console.log(`NEXT_PUBLIC_COIN_FACTORY_ADDRESS=${coinFactory.address}`);
  console.log(`NEXT_PUBLIC_FEE_ESCROW_ADDRESS=${feeEscrow.address}`);
  console.log(`NEXT_PUBLIC_LISTING_MANAGER_ADDRESS=${listingManager.address}`);
  console.log(`NEXT_PUBLIC_WETH_ADDRESS=${weth.address}`);
  console.log(`NEXT_PUBLIC_SWAP_ROUTER_ADDRESS=${swapRouter.address}`);
  console.log(`NEXT_PUBLIC_QUOTER_ADDRESS=${quoter.address}`);
  console.log(`NEXT_PUBLIC_LIQUIDITY_MANAGER_ADDRESS=${liquidityManager.address}`);
  console.log(`NEXT_PUBLIC_V3_FACTORY_ADDRESS=${v3Factory.address}`);
  console.log(`NEXT_PUBLIC_OUTBID_MARKET_ADDRESS=${auction.address}`);
  console.log(`NEXT_PUBLIC_OUTBID_BUYBACK_ADDRESS=${buyback.address}`);
  console.log(`NEXT_PUBLIC_REVENUE_ROUTER_ADDRESS=${revenueRouter.address}`);
  console.log(`NEXT_PUBLIC_TREASURY_ADDRESS=${treasury.address}`);
  console.log(`NEXT_PUBLIC_EVENTS_FROM_BLOCK=${fromBlock}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
