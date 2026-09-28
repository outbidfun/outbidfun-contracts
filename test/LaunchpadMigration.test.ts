import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { parseEther, zeroAddress, type Address } from 'viem';
import { POOL_FEE, USD_CAP, WETH_CAP, deployLaunchpad, usd } from './helpers/launchpad';

/**
 * The move to a second launchpad beside the first (ignition/modules/LaunchpadV2.ts and
 * scripts/migrate-launchpad.ts), rehearsed on a local chain: a new Uniswap V3, listing manager,
 * creator and factory, the old factory paused, the market on a registry union of the two. Coins of
 * both factories trade, graduate into their own factory's pools, and take bids.
 */
describe('Launchpad migration', () => {
  async function migrated() {
    const stack = await loadFixture(deployLaunchpad);
    const { owner, alice, weth, dollar, coinFactory, feeEscrow, holderRewards, listingManager, treasury, launch, publicClient } = stack;
    const oldCoin = await launch(alice, 'Old Coin', 'OLD');
    const oldDollar = await launch(alice, 'Old Dollar', 'OLDD', { quote: dollar.address });

    // The LaunchpadV2 module, step for step.
    const v3Factory = await hre.viem.deployContract('UniswapV3Factory', []);
    const swapRouter = await hre.viem.deployContract('SwapRouter', [v3Factory.address, weth.address]);
    const quoter = await hre.viem.deployContract('QuoterV2', [v3Factory.address, weth.address]);
    const door = await listingManager.read.treasury();
    const newManager = await hre.viem.deployContract('CoinListingManager', [owner.account.address, door, v3Factory.address, feeEscrow.address, POOL_FEE]);
    const creator = await hre.viem.deployContract('CoinCreator', [owner.account.address]);
    const newFactory = await hre.viem.deployContract('CoinFactory', [newManager.address, feeEscrow.address, creator.address, holderRewards.address]);
    const union = await hre.viem.deployContract('TokenRegistryUnion', [coinFactory.address, newFactory.address]);
    const liquidityManager = await hre.viem.deployContract('LiquidityManager', [v3Factory.address]);
    await creator.write.setFactory([newFactory.address]);
    await newManager.write.setCoinFactory([newFactory.address]);
    await v3Factory.write.setOwner([newManager.address]);
    await newFactory.write.setQuoteAsset([weth.address, WETH_CAP, true]);

    // The migration script: every asset carried across with its cap, the old factory paused.
    for (const asset of await coinFactory.read.allQuoteAssets()) {
      const [cap, , enabled] = await coinFactory.read.quoteAssets([asset]);
      const [newCap, , newEnabled] = await newFactory.read.quoteAssets([asset]);
      if (newCap !== cap || !newEnabled) await newFactory.write.setQuoteAsset([asset, cap, enabled]);
      await coinFactory.write.setQuoteAsset([asset, cap, false]);
    }
    const market = await hre.viem.deployContract('OutbidMarket', [
      owner.account.address, dollar.address, weth.address, zeroAddress, treasury.address, treasury.address, parseEther('1'), parseEther('2'),
    ]);
    await market.write.setRegistry([union.address]);

    /** Launches on the new factory, the way the helper launches on the old. */
    async function launchNew(name: string, symbol: string, quote: Address) {
      const hash = await newFactory.write.deploy(
        [
          { name, symbol, description: '', image: '', socials: '', quoteAsset: quote, preBuy: 0n, creatorFeeRecipient: zeroAddress, creatorTaxBps: 0, rewardFeeBps: 0, shareFeesWithHolders: false },
          [],
        ],
        { account: alice.account, value: parseEther('0.0005') }
      );
      await publicClient.waitForTransactionReceipt({ hash });
      return hre.viem.getContractAt('Coin', await newFactory.read.getAddress([symbol]), { client: { wallet: alice } });
    }
    return { ...stack, oldCoin, oldDollar, v3Factory, swapRouter, quoter, newManager, creator, newFactory, union, liquidityManager, market, launchNew };
  }

  it('lists the same assets at the same caps on the new factory, and pauses the old one', async () => {
    const { coinFactory, newFactory, weth, dollar, launch, launchNew, alice } = await migrated();
    for (const asset of [weth.address, dollar.address]) {
      const [cap, decimals, enabled] = await coinFactory.read.quoteAssets([asset]);
      const [newCap, newDecimals, newEnabled] = await newFactory.read.quoteAssets([asset]);
      expect([newCap, newDecimals, newEnabled]).to.deep.equal([cap, decimals, true]);
      expect(enabled).to.equal(false);
    }
    await expect(launch(alice, 'Too Late', 'LATE')).to.be.rejectedWith('Quote asset not enabled');
    const fresh = await launchNew('New Coin', 'NEW', weth.address);
    expect(await fresh.read.virtualQuote()).to.equal(parseEther('1.68'));
    // Each coin keeps the listing manager it launched with.
    expect((await fresh.read.listingManager()).toLowerCase()).to.equal((await newFactory.read.listingManager()).toLowerCase());
    expect((await fresh.read.listingManager()).toLowerCase()).to.not.equal((await coinFactory.read.listingManager()).toLowerCase());
  });

  it('graduates each factory\'s coins into its own Uniswap V3', async () => {
    const { oldCoin, buy, alice, listingManager, newManager, v3Factory, launchNew, weth, publicClient } = await migrated();
    const oldV3 = await hre.viem.getContractAt('UniswapV3Factory', await listingManager.read.uniswapV3Factory());
    // The old curve fills and graduates as it always did, in the old factory.
    await buy(oldCoin, alice, parseEther('10'));
    const oldPool = await listingManager.read.poolOf([oldCoin.address]);
    expect(oldPool).to.not.equal(zeroAddress);
    expect((await oldV3.read.getPool([oldCoin.address, weth.address, POOL_FEE])).toLowerCase()).to.equal(oldPool.toLowerCase());
    expect(await v3Factory.read.getPool([oldCoin.address, weth.address, POOL_FEE])).to.equal(zeroAddress);

    // A new coin graduates into the new factory, opened by the new manager.
    const fresh = await launchNew('New Coin', 'NEW', weth.address);
    let hash = await weth.write.approve([fresh.address, parseEther('10')], { account: alice.account });
    await publicClient.waitForTransactionReceipt({ hash });
    hash = await fresh.write.buy([parseEther('10'), 0n], { account: alice.account });
    await publicClient.waitForTransactionReceipt({ hash });
    const newPool = await newManager.read.poolOf([fresh.address]);
    expect(newPool).to.not.equal(zeroAddress);
    expect((await v3Factory.read.getPool([fresh.address, weth.address, POOL_FEE])).toLowerCase()).to.equal(newPool.toLowerCase());
    expect(await listingManager.read.poolOf([fresh.address])).to.equal(zeroAddress);
    expect(await fresh.read.totalSupply()).to.equal(parseEther('1000000000'));
  });

  it('takes bids on both factories\' coins through the union', async () => {
    const { oldDollar, market, dollar, bob, launchNew, publicClient } = await migrated();
    const fresh = await launchNew('New Dollar', 'NEWD', dollar.address);
    const hash = await dollar.write.approve([market.address, usd(1_000)], { account: bob.account });
    await publicClient.waitForTransactionReceipt({ hash });
    for (const coin of [oldDollar.address, fresh.address]) {
      const bid = await market.write.bid([coin, usd(100), 1n, 0n], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash: bid });
      expect(await market.read.getTotalBid([coin])).to.equal(parseEther('100'));
    }
    void USD_CAP;
  });
});
