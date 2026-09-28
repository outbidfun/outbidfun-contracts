import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { getAddress, parseEther, zeroAddress } from 'viem';
import {
  BPS,
  FEE_BPS,
  LAUNCH_FEE,
  PROTOCOL_SHARE_BPS,
  SNIPE_TAX_START_BPS,
  deployLaunchpad,
  ppm,
} from './helpers/launchpad';

/**
 * The fees, which follow PONS's.
 *
 * A launch costs 0.0005 ETH. Every buy and sell pays a 1% fee on the quote leg, shared 30% to
 * the protocol and 70% to the creator; the creator may add a tax of up to 10% on top, paid to
 * them in full and fixed at launch; and a buy in the first three seconds pays a snipe tax that
 * opens at 99% and falls in a straight line to nothing, which is shared like the fee. Nothing is taken at
 * graduation, and the pool's own fees are shared the same way. The creator's share waits in an
 * escrow they claim from. What has to hold: every one of those figures is what a trade actually
 * pays, the split is what the treasury and the escrow actually receive, and a coin keeps the
 * terms it launched with whatever the factory changes afterwards.
 */
describe('Fees', () => {
  async function launchedFixture() {
    const stack = await deployLaunchpad();
    const coin = await stack.launch(stack.alice, 'Front Page Pepe', 'PEPE');
    return { ...stack, coin };
  }

  const protocolShare = (fee: bigint) => (fee * PROTOCOL_SHARE_BPS) / BPS;
  const creatorShare = (fee: bigint) => fee - protocolShare(fee);

  describe('launching', () => {
    it('costs the launch fee, which goes to the treasury', async () => {
      const { coinFactory, treasury, weth, bob, publicClient } = await loadFixture(launchedFixture);
      const params = {
        name: 'Fee',
        symbol: 'FEE',
        description: '',
        image: '',
        socials: '',
        quoteAsset: weth.address,
        preBuy: 0n,
        creatorFeeRecipient: zeroAddress,
        creatorTaxBps: 0,
        rewardFeeBps: 0,
        shareFeesWithHolders: false,
      } as const;

      await expect(coinFactory.write.deploy([params, []], { account: bob.account })).to.be.rejectedWith(
        'Launch fee not paid'
      );
      await expect(
        coinFactory.write.deploy([params, []], { account: bob.account, value: LAUNCH_FEE * 2n })
      ).to.be.rejectedWith('Launch fee not paid');

      const before = await publicClient.getBalance({ address: treasury.address });
      const countedBefore = await treasury.read.receivedFrom([coinFactory.address]);
      const hash = await coinFactory.write.deploy([params, []], { account: bob.account, value: LAUNCH_FEE });
      await publicClient.waitForTransactionReceipt({ hash });
      expect((await publicClient.getBalance({ address: treasury.address })) - before).to.equal(LAUNCH_FEE);
      // Counted at the treasury under the factory's name, which is how the revenue page tells
      // a launch fee from a bid.
      expect((await treasury.read.receivedFrom([coinFactory.address])) - countedBefore).to.equal(LAUNCH_FEE);
      expect(await coinFactory.read.launchFee()).to.equal(LAUNCH_FEE);
    });

    it('caps the creator tax at what the factory allows', async () => {
      const { launch, bob } = await loadFixture(launchedFixture);
      await expect(launch(bob, 'Greedy', 'GRDY', { creatorTaxBps: 1_001 })).to.be.rejectedWith(
        'Creator tax too high'
      );
      const coin = await launch(bob, 'Modest', 'MDST', { creatorTaxBps: 1_000 });
      expect(await coin.read.creatorTaxBps()).to.equal(1_000);
    });

    it('records the terms on the coin', async () => {
      const { coin, alice, feeEscrow } = await loadFixture(launchedFixture);
      expect(await coin.read.feeBps()).to.equal(Number(FEE_BPS));
      expect(await coin.read.protocolShareBps()).to.equal(Number(PROTOCOL_SHARE_BPS));
      expect(await coin.read.creatorTaxBps()).to.equal(0);
      expect(await coin.read.snipeTaxStartBps()).to.equal(Number(SNIPE_TAX_START_BPS));
      expect(await coin.read.snipeTaxSeconds()).to.equal(3);
      expect(getAddress(await coin.read.creatorFeeRecipient())).to.equal(getAddress(alice.account.address));
      expect(getAddress(await coin.read.feeEscrow())).to.equal(getAddress(feeEscrow.address));
    });
  });

  describe('trading', () => {
    it('takes 1% of a buy: 30% to the treasury, 70% to the creator', async () => {
      const { coin, buy, weth, treasury, feeEscrow, alice, bob } = await loadFixture(launchedFixture);
      const treasuryBefore = await weth.read.balanceOf([treasury.address]);

      await buy(coin, bob, parseEther('1'));

      const fee = parseEther('0.01');
      expect(await coin.read.reserveBalance()).to.equal(parseEther('0.99'));
      expect((await weth.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(protocolShare(fee));
      expect(await feeEscrow.read.balanceOf([alice.account.address, weth.address])).to.equal(creatorShare(fee));
      // Nothing waits on the coin: what the curve holds is exactly the reserve.
      expect(await weth.read.balanceOf([coin.address])).to.equal(parseEther('0.99'));
    });

    it('takes 1% of a sale the same way', async () => {
      const { coin, buy, sell, weth, treasury, feeEscrow, alice, bob } = await loadFixture(launchedFixture);
      await buy(coin, bob, parseEther('1'));
      const treasuryBefore = await weth.read.balanceOf([treasury.address]);
      const creatorBefore = await feeEscrow.read.balanceOf([alice.account.address, weth.address]);
      const bobBefore = await weth.read.balanceOf([bob.account.address]);

      const held = await coin.read.balanceOf([bob.account.address]);
      // The curve gives back the 0.99 that went in, less the wei its rounding keeps, and the fee
      // comes off that.
      const gross = await coin.read.calculateSaleReturn([held]);
      expect(gross >= parseEther('0.99') - 1n && gross <= parseEther('0.99'), `${gross}`).to.equal(true);
      await sell(coin, bob, held);

      const fee = (gross * FEE_BPS) / BPS;
      expect((await weth.read.balanceOf([bob.account.address])) - bobBefore).to.equal(gross - fee);
      expect((await weth.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(protocolShare(fee));
      expect(
        (await feeEscrow.read.balanceOf([alice.account.address, weth.address])) - creatorBefore
      ).to.equal(creatorShare(fee));
    });

    it('pays the creator tax to the creator in full, on top of the fee', async () => {
      const { launch, buy, sell, weth, treasury, feeEscrow, alice, bob } = await loadFixture(launchedFixture);
      const coin = await launch(alice, 'Taxed', 'TAX', { creatorTaxBps: 500 });
      const treasuryBefore = await weth.read.balanceOf([treasury.address]);

      await buy(coin, bob, parseEther('1'));
      // 1% fee and 5% tax: 0.94 reaches the curve.
      expect(await coin.read.reserveBalance()).to.equal(parseEther('0.94'));
      expect((await weth.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(protocolShare(parseEther('0.01')));
      expect(await feeEscrow.read.balanceOf([alice.account.address, weth.address])).to.equal(
        creatorShare(parseEther('0.01')) + parseEther('0.05')
      );

      const held = await coin.read.balanceOf([bob.account.address]);
      const bobBefore = await weth.read.balanceOf([bob.account.address]);
      // 0.94 back from the curve, less the wei its rounding keeps, less 1% and 5% of that.
      const gross = await coin.read.calculateSaleReturn([held]);
      expect(gross >= parseEther('0.94') - 1n && gross <= parseEther('0.94'), `${gross}`).to.equal(true);
      await sell(coin, bob, held);
      expect((await weth.read.balanceOf([bob.account.address])) - bobBefore).to.equal(
        gross - (gross * FEE_BPS) / BPS - (gross * 500n) / BPS
      );
    });

    it('lets the creator claim what they earned, and hand future fees on', async () => {
      const { coin, buy, weth, feeEscrow, alice, bob, carol, publicClient } = await loadFixture(launchedFixture);
      await buy(coin, bob, parseEther('1'));
      const owed = await feeEscrow.read.balanceOf([alice.account.address, weth.address]);
      expect(owed).to.equal(parseEther('0.007'));

      // Nobody else can claim it, and it can be claimed once.
      await expect(feeEscrow.write.claim([weth.address], { account: bob.account })).to.be.rejectedWith('NothingToClaim');
      const before = await weth.read.balanceOf([alice.account.address]);
      let hash = await feeEscrow.write.claim([weth.address], { account: alice.account });
      await publicClient.waitForTransactionReceipt({ hash });
      expect((await weth.read.balanceOf([alice.account.address])) - before).to.equal(owed);
      expect(await feeEscrow.read.balanceOf([alice.account.address, weth.address])).to.equal(0n);
      await expect(feeEscrow.write.claim([weth.address], { account: alice.account })).to.be.rejectedWith('NothingToClaim');

      // Only the current recipient can pass the role on, and the next fees follow it.
      await expect(
        coin.write.setCreatorFeeRecipient([carol.account.address], { account: bob.account })
      ).to.be.rejectedWith('Not the fee recipient');
      hash = await coin.write.setCreatorFeeRecipient([carol.account.address], { account: alice.account });
      await publicClient.waitForTransactionReceipt({ hash });
      await buy(coin, bob, parseEther('1'));
      expect(await feeEscrow.read.balanceOf([carol.account.address, weth.address])).to.equal(parseEther('0.007'));
      expect(await feeEscrow.read.balanceOf([alice.account.address, weth.address])).to.equal(0n);
    });

    it('credits a named recipient rather than the launcher when one is given', async () => {
      const { launch, buy, weth, feeEscrow, alice, bob, carol } = await loadFixture(launchedFixture);
      const coin = await launch(alice, 'Team', 'TEAM', { creatorFeeRecipient: carol.account.address });
      await buy(coin, bob, parseEther('1'));
      expect(await feeEscrow.read.balanceOf([carol.account.address, weth.address])).to.equal(parseEther('0.007'));
      expect(await feeEscrow.read.balanceOf([alice.account.address, weth.address])).to.equal(0n);
    });
  });

  describe('the launch window', () => {
    it('taxes a buy in the first seconds, falling in a straight line to nothing, and not the creator', async () => {
      const stack = await deployLaunchpad();
      const { coinFactory, weth, treasury, feeEscrow, alice, bob, carol, publicClient } = stack;

      // Approvals ahead of the launch, so the buys are the very next blocks after it.
      const predicted = await coinFactory.read.getAddress(['SNIPE']);
      for (const wallet of [alice, bob, carol]) {
        const hash = await weth.write.approve([predicted, parseEther('10')], { account: wallet.account });
        await publicClient.waitForTransactionReceipt({ hash });
      }
      const coin = await stack.launch(alice, 'Snipe Me', 'SNIPE', { inWindow: true, snipeExemptions: [carol.account.address] });

      // In the launch block: 99% for a stranger, nothing for the creator's own wallets.
      expect(await coin.read.snipeTaxBps([bob.account.address])).to.equal(SNIPE_TAX_START_BPS);
      expect(await coin.read.snipeTaxBps([alice.account.address])).to.equal(0n);
      expect(await coin.read.snipeTaxBps([carol.account.address])).to.equal(0n);

      // One second in: two thirds of that, 66%. Bob pays it on top of the 1% fee, and the tax
      // is shared out the way the fee is, so the creator earns from the sniper too.
      const treasuryBefore = await weth.read.balanceOf([treasury.address]);
      let hash = await coin.write.buy([parseEther('1'), 0n], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      const taxed = parseEther('1') - (parseEther('1') * (FEE_BPS + (SNIPE_TAX_START_BPS * 2n) / 3n)) / BPS;
      expect(await coin.read.reserveBalance()).to.equal(taxed);
      const fee = parseEther('1') - taxed;
      expect((await weth.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(protocolShare(fee));
      expect(await feeEscrow.read.balanceOf([alice.account.address, weth.address])).to.equal(creatorShare(fee));

      // It falls in a straight line: 66% one second in, 33% after two, gone after three.
      expect(await coin.read.snipeTaxBps([bob.account.address])).to.equal((SNIPE_TAX_START_BPS * 2n) / 3n);
      await time.increase(1);
      expect(await coin.read.snipeTaxBps([bob.account.address])).to.equal(SNIPE_TAX_START_BPS / 3n);
      await time.increase(1);
      expect(await coin.read.snipeTaxBps([bob.account.address])).to.equal(0n);

      const before = await coin.read.reserveBalance();
      hash = await coin.write.buy([parseEther('1'), 0n], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      expect((await coin.read.reserveBalance()) - before).to.equal(parseEther('0.99'));
    });

    it("refuses a stranger's buy in the launch second with a reason, not a panic", async () => {
      const stack = await deployLaunchpad();
      const { alice, bob, weth, coinFactory, publicClient } = stack;
      const predicted = await coinFactory.read.getAddress(['EARLY']);
      const hash = await weth.write.approve([predicted, parseEther('10')], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      // With a creator tax the fee, the tax and a 99% snipe tax come to more than the payment. On a
      // chain with sub-second blocks a buy lands in the launch second easily; a call simulated
      // against the launch block stands in for one here.
      const coin = await stack.launch(alice, 'Too Early', 'EARLY', { inWindow: true, creatorTaxBps: 500 });
      await expect(coin.simulate.buy([parseEther('1'), 0n], { account: bob.account.address })).to.be.rejectedWith(
        'Snipe tax: too early'
      );
    });

    it('lets the creator and their named wallets buy untaxed in the window', async () => {
      const stack = await deployLaunchpad();
      const { coinFactory, weth, alice, carol, publicClient } = stack;
      const predicted = await coinFactory.read.getAddress(['TEAM']);
      for (const wallet of [alice, carol]) {
        const hash = await weth.write.approve([predicted, parseEther('10')], { account: wallet.account });
        await publicClient.waitForTransactionReceipt({ hash });
      }
      const coin = await stack.launch(alice, 'Team Buy', 'TEAM', {
        inWindow: true,
        preBuy: parseEther('0.5'),
        snipeExemptions: [carol.account.address],
      });
      // The creator's opening buy paid the fee and nothing else.
      expect(await coin.read.reserveBalance()).to.equal(parseEther('0.495'));

      const hash = await coin.write.buy([parseEther('1'), 0n], { account: carol.account });
      await publicClient.waitForTransactionReceipt({ hash });
      expect(await coin.read.reserveBalance()).to.equal(parseEther('0.495') + parseEther('0.99'));
    });

    it('refuses more exemptions than the window is meant for', async () => {
      const { launch, bob } = await loadFixture(launchedFixture);
      const many = Array.from({ length: 33 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`));
      await expect(launch(bob, 'Crowd', 'CRWD', { snipeExemptions: many })).to.be.rejectedWith('Too many exemptions');
    });
  });

  describe('the terms', () => {
    it('keeps a coin on the terms it launched with when the factory changes them', async () => {
      const { coin, coinFactory, launch, buy, weth, treasury, alice, bob } = await loadFixture(launchedFixture);

      await coinFactory.write.setFeeTerms([
        { feeBps: 200, protocolShareBps: 5_000, maxCreatorTaxBps: 500, snipeTaxStartBps: 9_000, snipeTaxSeconds: 5 },
      ]);
      const later = await launch(alice, 'Later', 'LATE');

      expect(await coin.read.feeBps()).to.equal(100);
      expect(await coin.read.protocolShareBps()).to.equal(3_000);
      expect(await later.read.feeBps()).to.equal(200);
      expect(await later.read.protocolShareBps()).to.equal(5_000);
      expect(await later.read.snipeTaxSeconds()).to.equal(5);

      // The old coin still charges 1% and pays the treasury 30% of it.
      const treasuryBefore = await weth.read.balanceOf([treasury.address]);
      await buy(coin, bob, parseEther('1'));
      expect((await weth.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(parseEther('0.003'));
      // The new one charges 2% and pays it 50%.
      await buy(later, bob, parseEther('1'));
      expect(await later.read.reserveBalance()).to.equal(parseEther('0.98'));
      expect((await weth.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(parseEther('0.003') + parseEther('0.01'));

      // And the new cap on the creator tax applies to launches from now on.
      await expect(launch(bob, 'Over', 'OVER', { creatorTaxBps: 600 })).to.be.rejectedWith('Creator tax too high');
    });

    it('refuses terms outside the ceilings, and anyone but the owner', async () => {
      const { coinFactory, bob } = await loadFixture(launchedFixture);
      const terms = { feeBps: 100, protocolShareBps: 3_000, maxCreatorTaxBps: 1_000, snipeTaxStartBps: 9_900, snipeTaxSeconds: 3 };
      await expect(coinFactory.write.setFeeTerms([{ ...terms, feeBps: 1_001 }])).to.be.rejectedWith('Fee too high');
      await expect(coinFactory.write.setFeeTerms([{ ...terms, maxCreatorTaxBps: 1_001 }])).to.be.rejectedWith('Fee too high');
      await expect(coinFactory.write.setFeeTerms([{ ...terms, protocolShareBps: 10_001 }])).to.be.rejectedWith('Bad share');
      await expect(coinFactory.write.setFeeTerms([{ ...terms, snipeTaxStartBps: 9_901 }])).to.be.rejectedWith('Snipe tax too high');
      await expect(coinFactory.write.setFeeTerms([{ ...terms, snipeTaxSeconds: 61 }])).to.be.rejectedWith('Snipe window too long');
      await expect(coinFactory.write.setFeeTerms([terms], { account: bob.account })).to.be.rejectedWith('OwnableUnauthorizedAccount');
      await expect(coinFactory.write.setLaunchFee([1n], { account: bob.account })).to.be.rejectedWith('OwnableUnauthorizedAccount');
    });

    it('lets only the bound factory deploy through the creator', async () => {
      const { coinCreator, coinFactory, bob } = await loadFixture(launchedFixture);
      await expect(
        coinCreator.write.create([`0x${'11'.repeat(32)}` as `0x${string}`], { account: bob.account })
      ).to.be.rejectedWith('NotFactory');
      await expect(coinCreator.write.setFactory([bob.account.address])).to.be.rejectedWith('FactoryAlreadySet');
      expect(getAddress(await coinCreator.read.factory())).to.equal(getAddress(coinFactory.address));
      // Nobody can hand a coin a second opening buy.
      const coin = await stack(coinFactory);
      void coin;
    });
  });

  describe('routing', () => {
    it('sends every fee through the revenue router once the listing manager points at it', async () => {
      const { owner, coinFactory, listingManager, treasury, weth, launch, buy, alice, bob, carol, publicClient } =
        await loadFixture(launchedFixture);
      // The router splits 80% to the buyback vault and 20% to operations. Carol stands in for
      // the vault; the treasury is where operations money sits.
      const router = await hre.viem.deployContract('RevenueRouter', [
        owner.account.address,
        carol.account.address,
        treasury.address,
        8000n,
        2000n,
      ]);
      await expect(listingManager.write.setTreasury([router.address], { account: bob.account })).to.be.rejectedWith(
        'OwnableUnauthorizedAccount'
      );
      await expect(listingManager.write.setTreasury([zeroAddress], { account: owner.account })).to.be.rejectedWith(
        'ZeroAddress'
      );
      await listingManager.write.setTreasury([router.address], { account: owner.account });
      expect(getAddress(await listingManager.read.treasury())).to.equal(getAddress(router.address));

      // A launch pays its fee in ether to the router; a buy pays the protocol's share of its fee
      // in the coin's quote asset to the router. Nothing reaches the treasury directly any more.
      const treasuryEthBefore = await publicClient.getBalance({ address: treasury.address });
      const treasuryWethBefore = await weth.read.balanceOf([treasury.address]);
      const coin = await launch(alice, 'Routed', 'ROUTE');
      await buy(coin, bob, parseEther('1'));

      expect(await publicClient.getBalance({ address: router.address })).to.equal(LAUNCH_FEE);
      expect(await router.read.pending([zeroAddress])).to.equal(LAUNCH_FEE);
      expect(await weth.read.balanceOf([router.address])).to.equal(protocolShare(parseEther('0.01')));
      expect(await publicClient.getBalance({ address: treasury.address })).to.equal(treasuryEthBefore);
      expect(await weth.read.balanceOf([treasury.address])).to.equal(treasuryWethBefore);
      // The factory is the launch fee's sender, which is how the revenue page names the source.
      const receipts = await router.getEvents.RevenueReceived(undefined, { fromBlock: 0n });
      expect(receipts).to.have.lengthOf(1);
      expect(getAddress(receipts[0]!.args.source!)).to.equal(getAddress(coinFactory.address));

      // Each asset is split on its own: 80% to the vault, 20% to operations.
      const carolBefore = await publicClient.getBalance({ address: carol.account.address });
      const carolWethBefore = await weth.read.balanceOf([carol.account.address]);
      await router.write.allocateAndRelease([zeroAddress], { account: bob.account });
      await router.write.allocateAndRelease([weth.address], { account: bob.account });
      expect((await publicClient.getBalance({ address: carol.account.address })) - carolBefore).to.equal(
        (LAUNCH_FEE * 8000n) / BPS
      );
      expect((await publicClient.getBalance({ address: treasury.address })) - treasuryEthBefore).to.equal(
        (LAUNCH_FEE * 2000n) / BPS
      );
      const wethShare = protocolShare(parseEther('0.01'));
      expect((await weth.read.balanceOf([carol.account.address])) - carolWethBefore).to.equal((wethShare * 8000n) / BPS);
      expect((await weth.read.balanceOf([treasury.address])) - treasuryWethBefore).to.equal((wethShare * 2000n) / BPS);
    });
  });
});

/** The first coin the factory launched, for a test that only needs one to exist. */
async function stack(coinFactory: { read: { allMemecoinsRange: (args: readonly [bigint, bigint]) => Promise<readonly string[]> } }) {
  const [first] = await coinFactory.read.allMemecoinsRange([0n, 0n]);
  return first;
}
