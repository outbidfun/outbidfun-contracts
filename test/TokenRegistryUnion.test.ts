import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { parseEther, zeroAddress } from 'viem';
import { deployLaunchpad } from './helpers/launchpad';
import { deployMarket } from './helpers/market';

/**
 * The outbid market holds one registry, and asks it one question. When a new CoinFactory
 * replaces an old one, the union answers for both, so the old factory's coins stay biddable.
 */
describe('TokenRegistryUnion', () => {
  async function twoFactories() {
    const stack = await loadFixture(deployLaunchpad);
    const { coinFactory, listingManager, feeEscrow, holderRewards, owner, alice, launch } = stack;
    // A second launchpad beside the first: its own creator and factory on the same listing
    // manager stand-in (the coins here never graduate).
    const creator = await hre.viem.deployContract('CoinCreator', [owner.account.address]);
    const second = await hre.viem.deployContract('CoinFactory', [
      listingManager.address,
      feeEscrow.address,
      creator.address,
      holderRewards.address,
    ]);
    await creator.write.setFactory([second.address]);
    await second.write.setQuoteAsset([stack.weth.address, parseEther('4.2'), true]);
    const union = await hre.viem.deployContract('TokenRegistryUnion', [coinFactory.address, second.address]);

    const oldCoin = await launch(alice, 'Old Coin', 'OLD');
    const hash = await second.write.deploy(
      [
        {
          name: 'New Coin',
          symbol: 'NEW',
          description: '',
          image: '',
          socials: '',
          quoteAsset: stack.weth.address,
          preBuy: 0n,
          creatorFeeRecipient: zeroAddress,
          creatorTaxBps: 0,
          rewardFeeBps: 0,
          shareFeesWithHolders: false,
        },
        [],
      ],
      { account: alice.account, value: parseEther('0.0005') }
    );
    await stack.publicClient.waitForTransactionReceipt({ hash });
    const newCoin = await second.read.getAddress(['NEW']);
    return { ...stack, second, union, oldCoin: oldCoin.address, newCoin };
  }

  it('answers for the coins of both factories, and for nothing else', async () => {
    const { coinFactory, second, union, oldCoin, newCoin, bob } = await twoFactories();
    expect(await coinFactory.read.isMemeCoinLegit([oldCoin])).to.equal(true);
    expect(await second.read.isMemeCoinLegit([oldCoin])).to.equal(false);
    expect(await union.read.isMemeCoinLegit([oldCoin])).to.equal(true);
    expect(await union.read.isMemeCoinLegit([newCoin])).to.equal(true);
    expect(await union.read.isMemeCoinLegit([bob.account.address])).to.equal(false);
    expect(await union.read.isMemeCoinLegit([zeroAddress])).to.equal(false);
  });

  it('refuses a missing side', async () => {
    const { coinFactory } = await loadFixture(deployLaunchpad);
    await expect(hre.viem.deployContract('TokenRegistryUnion', [coinFactory.address, zeroAddress])).to.be.rejectedWith(
      'ZeroAddress'
    );
  });

  it('lets the market take bids on both factories\' coins', async () => {
    const { union, oldCoin, newCoin, owner, dollar, weth, treasury, bob, publicClient, launch, second, alice } =
      await twoFactories();
    // Coins priced in the dollar on each factory, since bids are in it.
    await second.write.setQuoteAsset([dollar.address, 14_000n * 10n ** 6n, true]);
    const oldDollar = await launch(alice, 'Old Dollar', 'OLDD', { quote: dollar.address });
    let hash = await second.write.deploy(
      [
        { name: 'New Dollar', symbol: 'NEWD', description: '', image: '', socials: '', quoteAsset: dollar.address, preBuy: 0n, creatorFeeRecipient: zeroAddress, creatorTaxBps: 0, rewardFeeBps: 0, shareFeesWithHolders: false },
        [],
      ],
      { account: alice.account, value: parseEther('0.0005') }
    );
    await publicClient.waitForTransactionReceipt({ hash });
    const newDollar = await second.read.getAddress(['NEWD']);

    const market = await deployMarket([
      owner.account.address, dollar.address, weth.address, zeroAddress, treasury.address, treasury.address, parseEther('1'), parseEther('2'),
    ]);
    await market.write.setRegistry([union.address]);
    hash = await dollar.write.approve([market.address, 1_000n * 10n ** 6n], { account: bob.account });
    await publicClient.waitForTransactionReceipt({ hash });
    for (const coin of [oldDollar.address, newDollar]) {
      hash = await market.write.bid([coin, 100n * 10n ** 6n, 1n, 0n], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      expect(await market.read.getTotalBid([coin])).to.equal(parseEther('100'));
    }
    void oldCoin;
    void newCoin;
  });
});
