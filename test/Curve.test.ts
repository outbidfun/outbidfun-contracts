import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { getAddress, parseEther, parseGwei, zeroAddress, type Address } from 'viem';
import { USD_CAP, WETH_CAP, LAUNCH_FEE, deployLaunchpad, netOfFee, usd } from './helpers/launchpad';

describe('The bonding curve', () => {
  async function launchedFixture() {
    const stack = await deployLaunchpad();
    const coin = await stack.launch(stack.alice, 'Front Page Pepe', 'PEPE');
    return { ...stack, coin };
  }

  describe('launching', () => {
    it('buys for the creator in the launch transaction (audit F-06)', async () => {
      const { launch, coinFactory, bob } = await loadFixture(launchedFixture);
      const value = parseEther('0.1');

      const coin = await launch(bob, 'Pre buy', 'PRE', { preBuy: value });
      // The 1% fee comes off first, and the rest is on the curve.
      expect(await coin.read.reserveBalance()).to.equal(netOfFee(value));
      expect(await coin.read.balanceOf([bob.account.address]) > 0n).to.equal(true);
      expect(await coinFactory.read.isMemeCoinLegit([coin.address])).to.equal(true);
    });

    it('refuses a pre-buy that would fill the cap', async () => {
      const { launch, bob } = await loadFixture(launchedFixture);
      await expect(launch(bob, 'Too big', 'BIG', { preBuy: WETH_CAP })).to.be.rejectedWith(
        'Pre-buy exceeds cap'
      );
    });

    it('refuses an asset the platform does not list', async () => {
      const { coinFactory, bob } = await loadFixture(launchedFixture);
      const stray = await hre.viem.deployContract('MockERC20', ['Stray', 'STRAY', 18, 0n]);
      await expect(
        coinFactory.write.deploy(
          [
            {
              name: 'Stray coin',
              symbol: 'SC',
              description: '',
              image: '',
              socials: '',
              quoteAsset: stray.address,
              preBuy: 0n,
              creatorFeeRecipient: zeroAddress,
              creatorTaxBps: 0,
              rewardFeeBps: 0,
              shareFeesWithHolders: false,
            },
            [],
          ],
          { account: bob.account, value: LAUNCH_FEE }
        )
      ).to.be.rejectedWith('Quote asset not enabled');
    });

    it('takes a coin priced in a six-decimal dollar and prices it at eighteen decimals', async () => {
      const { launch, buy, dollar, alice, coinFactory } = await loadFixture(launchedFixture);
      const coin = await launch(alice, 'Greenback', 'BUCK', { quote: dollar.address });
      expect(getAddress(await coin.read.reserveToken())).to.equal(getAddress(dollar.address));
      expect(await coin.read.reserveDecimals()).to.equal(6);
      expect(await coin.read.cap()).to.equal(USD_CAP);

      await buy(coin, alice, usd(1_000));
      const reserve = await coin.read.reserveBalance();
      const supply = await coin.read.totalSupply();
      expect(reserve).to.equal(usd(990));
      // 2.2 · reserve / supply, with the six-decimal reserve read at eighteen decimals so a coin
      // worth a fraction of a cent is not rounded to a price of zero.
      const expected = (reserve * 11n * 10n ** 12n * 10n ** 18n) / (supply * 5n);
      expect(await coin.read.price()).to.equal(expected);
      expect(expected > 0n).to.equal(true);

      // Where its pool will open: 2.2 × 14,000 dollars over the 687.5M coins the curve sells.
      expect(await coinFactory.read.graduationPrice([dollar.address])).to.equal(44_800_000_000_000n);
    });

    it('has no price until it has a coin (audit F-10)', async () => {
      const { coin } = await loadFixture(launchedFixture);
      expect(await coin.read.totalSupply()).to.equal(0n);
      expect(await coin.read.price()).to.equal(0n);
    });
  });

  describe('trading', () => {
    it('mints for a small buy instead of keeping the money (audit F-07)', async () => {
      const { coin, buy, alice, bob } = await loadFixture(launchedFixture);
      await buy(coin, alice, parseEther('1'));

      const before = await coin.read.totalSupply();
      await buy(coin, bob, parseGwei('1'));
      const minted = await coin.read.balanceOf([bob.account.address]);

      expect(minted > 0n, `minted ${minted}`).to.equal(true);
      expect(await coin.read.totalSupply()).to.equal(before + minted);
    });

    it('refuses a buy that mints nothing', async () => {
      const { coin, buy, alice } = await loadFixture(launchedFixture);
      await buy(coin, alice, parseEther('1'));
      await expect(buy(coin, alice, 0n)).to.be.rejectedWith('Zero output token amount');
    });

    it('takes only what was approved', async () => {
      const { coin, alice } = await loadFixture(launchedFixture);
      await expect(coin.write.buy([parseEther('1'), 0n], { account: alice.account })).to.be.rejected;
    });

    it('answers small buys after a partial sell (audit F-07)', async () => {
      const { coin, buy, sell, alice, bob } = await loadFixture(launchedFixture);
      await buy(coin, alice, parseEther('1'));

      const held = await coin.read.balanceOf([alice.account.address]);
      await sell(coin, alice, held / 2n);

      // The supply no longer sits on a whole coin, which used to make every buy from here on
      // fail with an arithmetic panic.
      for (const value of [1_000n, 1_000_000n, 10n ** 9n]) {
        const before = await coin.read.balanceOf([bob.account.address]);
        await buy(coin, bob, value);
        expect(await coin.read.balanceOf([bob.account.address]) > before).to.equal(true);
      }
    });

    it('pays a seller what the curve holds for them, not what it holds (audit F-18)', async () => {
      const { coin, buy, sell, alice } = await loadFixture(launchedFixture);
      await buy(coin, alice, parseEther('1'));

      const held = await coin.read.balanceOf([alice.account.address]);
      await sell(coin, alice, held / 2n);

      // Half the supply is worth 0.5 ^ 2.2 of the reserve, so 0.2155 of the 0.99 ETH stays.
      // The curve's power function, asked to raise the supply itself to 2.2, answered 87%
      // short and left 0.0256: a seller could take almost the whole reserve, and the next
      // buyer's money with it.
      const reserve = await coin.read.reserveBalance();
      expect(reserve > parseEther('0.2152') && reserve < parseEther('0.2157'), `${reserve}`).to.equal(
        true
      );
    });

    it('returns every buyer their share of the reserve, in any order (audit F-18)', async () => {
      const { coin, buy, sell, alice, bob, carol } = await loadFixture(launchedFixture);
      const buyers = [alice, bob, carol];
      for (const buyer of buyers) await buy(coin, buyer, parseEther('1'));
      // Three ETH in, 1% of each in fees.
      expect(await coin.read.reserveBalance()).to.equal(parseEther('2.97'));

      // Last in, first out: each recovers exactly the 0.99 ETH their buy put on the curve,
      // before the fee on the way out.
      for (const seller of [...buyers].reverse()) {
        const amount = await coin.read.balanceOf([seller.account.address]);
        expect(await coin.read.calculateSaleReturn([amount])).to.equal(parseEther('0.99'));
        await sell(coin, seller, amount);
      }
      expect(await coin.read.totalSupply()).to.equal(0n);
      expect(await coin.read.reserveBalance()).to.equal(0n);
    });

    it('does the same in dollars, to the cent', async () => {
      const { launch, buy, sell, dollar, alice, bob } = await loadFixture(launchedFixture);
      const coin = await launch(alice, 'Greenback', 'BUCK', { quote: dollar.address });
      for (const buyer of [alice, bob]) await buy(coin, buyer, usd(1_000));
      expect(await coin.read.reserveBalance()).to.equal(usd(1_980));

      for (const seller of [bob, alice]) {
        const amount = await coin.read.balanceOf([seller.account.address]);
        // A six-decimal reserve rounds at the millionth of a dollar; the curve gives back what
        // went in to within one of those.
        const quoted = await coin.read.calculateSaleReturn([amount]);
        expect(quoted >= usd(990) - 1n && quoted <= usd(990), `${quoted}`).to.equal(true);
        await sell(coin, seller, amount);
      }
      expect(await coin.read.totalSupply()).to.equal(0n);
      expect(await coin.read.reserveBalance() <= 1n).to.equal(true);
    });

    it('will not let a seller trade again while being paid (audit F-08)', async () => {
      const { coinFactory, launch, buy, erc20, owner, alice, publicClient } = await loadFixture(launchedFixture);

      // A reserve token that hands its recipient a turn on every transfer is how a contract
      // seller gets one while the curve is paying it out.
      const hooked = await hre.viem.deployContract('HookedERC20', ['Hooked', 'HOOK', parseEther('1000')]);
      await coinFactory.write.setQuoteAsset([hooked.address, WETH_CAP, true]);
      const coin = await launch(alice, 'Hooked Coin', 'HOOK', { quote: hooked.address });
      let hash = await hooked.write.transfer([alice.account.address, parseEther('10')], { account: owner.account });
      await publicClient.waitForTransactionReceipt({ hash });
      await buy(coin, alice, parseEther('1'));

      const trader = await hre.viem.deployContract('ReenteringTrader', [coin.address]);
      hash = await hooked.write.transfer([trader.address, parseEther('2')], { account: owner.account });
      await publicClient.waitForTransactionReceipt({ hash });
      hash = await trader.write.buy([parseEther('1')], { account: alice.account });
      await publicClient.waitForTransactionReceipt({ hash });
      expect((await coin.read.balanceOf([trader.address])) > 0n).to.equal(true);

      hash = await trader.write.sellAll({ account: alice.account });
      await publicClient.waitForTransactionReceipt({ hash });

      // It tried to buy from inside its own payout and the guard turned it away.
      expect(await trader.read.attempted()).to.equal(true);
      expect(await trader.read.reentered()).to.equal(false);
      expect(await coin.read.balanceOf([trader.address])).to.equal(0n);
      // One sale happened, so the curve is back where the first buyer left it.
      expect(await coin.read.reserveBalance()).to.equal(parseEther('0.99'));
      void erc20;
    });

    it('costs far less than it did with an on-chain trade log (audit F-13)', async () => {
      const { coin, buy, alice } = await loadFixture(launchedFixture);
      const receipt = await buy(coin, alice, parseEther('1'));
      // A buy cost 404,534 gas in the review, most of it the seven-field struct written to an
      // array nothing on chain read. Paying in a token rather than ether adds the transfer,
      // and paying the fee to two parties adds two more.
      expect(receipt.gasUsed < 400_000n, `gas ${receipt.gasUsed}`).to.equal(true);
    });
  });

  describe('the factory', () => {
    it('frees a nickname when its account gives it up (audit F-16)', async () => {
      const { coinFactory, alice, bob } = await loadFixture(launchedFixture);
      await coinFactory.write.updateAccountInfo(['pepe', ''], { account: alice.account });
      expect(await coinFactory.read.nicknamesToAccounts(['pepe'])).to.equal(
        getAddress(alice.account.address)
      );
      await expect(
        coinFactory.write.updateAccountInfo(['pepe', ''], { account: bob.account })
      ).to.be.rejectedWith('Nickname exists');

      // Alice renames herself, and the name she left is free again.
      await coinFactory.write.updateAccountInfo(['pug', ''], { account: alice.account });
      expect(await coinFactory.read.nicknamesToAccounts(['pepe'])).to.equal(zeroAddress);
      await coinFactory.write.updateAccountInfo(['pepe', ''], { account: bob.account });
      expect(await coinFactory.read.nicknamesToAccounts(['pepe'])).to.equal(
        getAddress(bob.account.address)
      );
    });

    it('fills the curve maths table once (audit F-16)', async () => {
      const { formula } = await loadFixture(launchedFixture);
      await expect(formula.write.init()).to.be.rejectedWith('Already initialised');
    });
  });

  describe('the registry', () => {
    it('answers false for a contract that fakes a coin index (audit F-09)', async () => {
      const { coinFactory, treasury, owner, bob, dollar, weth } = await loadFixture(launchedFixture);
      const fake = await hre.viem.deployContract('FakeCoin', []);
      expect(await coinFactory.read.isMemeCoinLegit([fake.address])).to.equal(false);

      const auction = await hre.viem.deployContract('OutbidMarket', [
        owner.account.address,
        dollar.address,
        weth.address,
        zeroAddress,
        treasury.address,
        treasury.address,
        parseEther('1'),
        parseEther('2'),
      ]);
      await auction.write.setRegistry([coinFactory.address]);
      // A named error, not a panic the web app has nothing to map.
      await expect(
        auction.write.bid([fake.address as Address, parseEther('0.01'), 0n, 0n], { account: bob.account })
      ).to.be.rejectedWith('TokenNotRegistered');
    });
  });
});
