import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { getAddress, parseEther, zeroAddress } from 'viem';
import { POOL_FEE, USD_CAP, WETH_CAP, deployLaunchpad, poolPriceX18, usd } from './helpers/launchpad';
import { deployMarket } from './helpers/market';

const DEAD = getAddress('0x000000000000000000000000000000000000dEaD');
const DEADLINE = 4_102_444_800n; // 2100-01-01

/** |a - b| / b, as a plain fraction. */
const off = (a: number, b: number) => Math.abs(a - b) / b;

/**
 * The sixth review (docs/AUDIT-6.md): the constant-product curve. Each test here failed on the
 * curve as first written, and passes on the fixed one.
 */
describe('Sixth review regressions', () => {
  async function fresh() {
    const stack = await loadFixture(deployLaunchpad);
    const coin = await stack.launch(stack.alice, 'Regression', 'REG');
    return { ...stack, coin };
  }

  describe('a donation to a live curve (K-01)', () => {
    it('pays every seller what their buy put on the curve, and never a stranger\'s money', async () => {
      const { coin, buy, sell, weth, alice, bob, carol, treasury, publicClient } = await fresh();
      await buy(coin, alice, parseEther('1'));
      await buy(coin, bob, parseEther('0.01'));
      // Carol sends the coin 1 ETH straight, past the curve.
      const hash = await weth.write.transfer([coin.address, parseEther('1')], { account: carol.account });
      await publicClient.waitForTransactionReceipt({ hash });

      // As first written the curve read its balance: Alice, 99.4% of the supply, sold at the
      // price the donation lifted, 1.37 ETH for her 0.99, and Bob, selling last, was handed the
      // 0.63 ETH left — 118 times the 0.0099 he had on the curve. Now the donation is not the
      // curve's: each gets what their buy put on, to the wei, in either order.
      const aliceHeld = await coin.read.balanceOf([alice.account.address]);
      const bobHeld = await coin.read.balanceOf([bob.account.address]);
      const bobGets = await coin.read.calculateSaleReturn([bobHeld]);
      expect(bobGets >= parseEther('0.0099') - 1n && bobGets <= parseEther('0.0099'), `${bobGets}`).to.equal(true);
      await sell(coin, bob, bobHeld);
      const aliceGets = await coin.read.calculateSaleReturn([aliceHeld]);
      expect(aliceGets >= parseEther('0.99') - 1n && aliceGets <= parseEther('0.99'), `${aliceGets}`).to.equal(true);
      await sell(coin, alice, aliceHeld);
      expect(await coin.read.totalSupply()).to.equal(0n);
      expect((await coin.read.reserveBalance()) <= 2n).to.equal(true);
      expect(await coin.read.excessReserve()).to.equal(parseEther('1'));

      // Carol's ETH is protocol revenue, and the sweep is the only way it moves.
      const treasuryBefore = await weth.read.balanceOf([treasury.address]);
      await coin.write.sweepExcess({ account: bob.account });
      expect((await weth.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(parseEther('1'));
    });
  });

  describe('a curve nobody has bought from (K-02)', () => {
    it('sends reserve pushed to its cap to the treasury and stays open, rather than opening a pool with every coin in it', async () => {
      const { coin, buy, weth, alice, bob, carol, treasury, listingManager, publicClient } = await fresh();
      let hash = await weth.write.transfer([coin.address, WETH_CAP], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });

      // Before the fix this opened a pool holding 714.3M coins against the 4.2 ETH, with the
      // other 285.7M at the dead address and nobody holding any: a coin with no holders at a
      // price nobody paid. The 4.2 ETH is not the curve's, and `graduate` sweeps it.
      expect(await coin.read.reserveBalance()).to.equal(0n);
      expect(await coin.read.excessReserve()).to.equal(WETH_CAP);
      const treasuryBefore = await weth.read.balanceOf([treasury.address]);
      hash = await coin.write.graduate({ account: carol.account });
      await publicClient.waitForTransactionReceipt({ hash });
      expect(await coin.read.cap()).to.equal(WETH_CAP);
      expect(await listingManager.read.poolOf([coin.address])).to.equal(zeroAddress);
      expect(await coin.read.totalSupply()).to.equal(0n);
      expect(await coin.read.excessReserve()).to.equal(0n);
      expect((await weth.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(WETH_CAP);

      // And it trades on from the bottom, as if nothing had happened.
      expect(await coin.read.price()).to.equal(1_680_000_000n);
      await buy(coin, alice, parseEther('1'));
      expect(await coin.read.reserveBalance()).to.equal(parseEther('0.99'));
    });

    it('lands a bid on such a coin: the market sweeps it, then buys on the fresh curve (AUDIT-3 H-04)', async () => {
      const { launch, owner, alice, bob, carol, weth, dollar, coinFactory, treasury, listingManager, publicClient } =
        await loadFixture(deployLaunchpad);
      const market = await deployMarket([
        owner.account.address,
        dollar.address,
        weth.address,
        zeroAddress,
        treasury.address,
        treasury.address,
        parseEther('1'),
        parseEther('2'),
      ]);
      await market.write.setRegistry([coinFactory.address]);
      let hash = await dollar.write.approve([market.address, usd(1_000)], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });

      const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
      hash = await dollar.write.transfer([fed.address, USD_CAP], { account: carol.account });
      await publicClient.waitForTransactionReceipt({ hash });

      const treasuryBefore = await dollar.read.balanceOf([treasury.address]);
      hash = await market.write.bid([fed.address, usd(100), 1n, 0n], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      expect(await fed.read.cap()).to.equal(USD_CAP);
      expect(await listingManager.read.poolOf([fed.address])).to.equal(zeroAddress);
      expect((await fed.read.balanceOf([DEAD])) > 0n).to.equal(true);
      expect(await market.read.getTotalBid([fed.address])).to.equal(parseEther('100'));
      // The 14,000 pushed in went to the treasury, with the bid's own 5%.
      expect((await dollar.read.balanceOf([treasury.address])) - treasuryBefore >= USD_CAP + usd(5)).to.equal(true);
    });
  });

  describe('an asset with a cap too small for a phantom quote (K-03)', () => {
    it('is refused at listing, and priced with a reason rather than a panic', async () => {
      const { coinFactory, launch, alice } = await loadFixture(deployLaunchpad);
      const tiny = await hre.viem.deployContract('MockERC20', ['Tiny', 'TINY', 18, 0n]);
      // Two raw units at 40% is no phantom quote at all; three is one unit of it. (A cap that
      // small still closes at a price too low to state at eighteen decimals, which reads zero:
      // the check is about the curve, not the display.)
      await expect(coinFactory.write.setQuoteAsset([tiny.address, 2n, true])).to.be.rejectedWith('Cap too small');
      await coinFactory.write.setQuoteAsset([tiny.address, 3n, true]);
      await coinFactory.read.graduationPrice([tiny.address]);

      // Lowering the phantom share afterwards can strand an asset already listed: the price
      // and the launch both say so. Before the fix the price divided by zero.
      await coinFactory.write.setParameters([1, parseEther('1000000000'), parseEther('1000000000')]);
      await expect(coinFactory.read.graduationPrice([tiny.address])).to.be.rejectedWith('Cap too small');
      await expect(launch(alice, 'Tiny Coin', 'TINYC', { quote: tiny.address })).to.be.rejectedWith('Cap too small');
    });
  });

  describe('forced donations: untracked reserve (K-04)', () => {
    /** A live curve with two holders, then 1 ETH sent straight to the coin. */
    async function donated() {
      const stack = await fresh();
      const { coin, buy, weth, alice, bob, carol, publicClient } = stack;
      await buy(coin, alice, parseEther('1'));
      await buy(coin, bob, parseEther('0.5'));
      const before = {
        price: await coin.read.price(),
        reserves: await coin.read.getReserves(),
        reserve: await coin.read.reserveBalance(),
        forDeposit: await coin.read.calculatePurchaseReturn([parseEther('0.1')]),
        forSale: await coin.read.calculateSaleReturn([parseEther('1000000')]),
      };
      const hash = await weth.write.transfer([coin.address, parseEther('1')], { account: carol.account });
      await publicClient.waitForTransactionReceipt({ hash });
      return { ...stack, before };
    }

    it('1. does not change the price, or what a trade is quoted', async () => {
      const { coin, before } = await donated();
      expect(await coin.read.price()).to.equal(before.price);
      expect(await coin.read.getReserves()).to.deep.equal(before.reserves);
      expect(await coin.read.calculatePurchaseReturn([parseEther('0.1')])).to.equal(before.forDeposit);
      expect(await coin.read.calculateSaleReturn([parseEther('1000000')])).to.equal(before.forSale);
    });

    it('2. does not count toward graduation, however much is sent', async () => {
      const { coin, before, buy, weth, bob, carol, listingManager, publicClient } = await donated();
      expect(await coin.read.reserveBalance()).to.equal(before.reserve);
      expect(await coin.read.excessReserve()).to.equal(parseEther('1'));
      // More than the cap, on top: the curve is no fuller, buys still land, and nothing lists.
      const hash = await weth.write.transfer([coin.address, WETH_CAP], { account: carol.account });
      await publicClient.waitForTransactionReceipt({ hash });
      expect(await coin.read.reserveBalance()).to.equal(before.reserve);
      await buy(coin, bob, parseEther('0.1'));
      expect(await coin.read.cap()).to.equal(WETH_CAP);
      expect(await coin.read.reserveBalance()).to.equal(before.reserve + parseEther('0.099'));
      await coin.write.graduate({ account: carol.account });
      expect(await coin.read.cap()).to.equal(WETH_CAP);
      expect(await listingManager.read.poolOf([coin.address])).to.equal(zeroAddress);
    });

    it('3. cannot be withdrawn by a seller', async () => {
      const { coin, sell, alice, bob } = await donated();
      // No sale is quoted against it: a wei past the curve's own reserve is a reason, not a quote.
      await expect(coin.read.calculateSaleAmount([(await coin.read.reserveBalance()) + 1n])).to.be.rejectedWith(
        'Value exceeds reserve'
      );
      // Both holders sell everything: each gets what their buy put on the curve, and no more.
      const aliceHeld = await coin.read.balanceOf([alice.account.address]);
      const bobHeld = await coin.read.balanceOf([bob.account.address]);
      const bobGets = await coin.read.calculateSaleReturn([bobHeld]);
      expect(bobGets <= parseEther('0.495') && bobGets >= parseEther('0.495') - 2n, `${bobGets}`).to.equal(true);
      await sell(coin, bob, bobHeld);
      const aliceGets = await coin.read.calculateSaleReturn([aliceHeld]);
      expect(aliceGets <= parseEther('0.99') && aliceGets >= parseEther('0.99') - 2n, `${aliceGets}`).to.equal(true);
      await sell(coin, alice, aliceHeld);
      expect(await coin.read.totalSupply()).to.equal(0n);
      expect((await coin.read.reserveBalance()) <= 4n).to.equal(true);
      expect(await coin.read.excessReserve()).to.equal(parseEther('1'));
    });

    it('4. moves only through the sweep, to the treasury, and never as a buyer\'s change', async () => {
      const { coin, buy, weth, alice, carol, treasury, publicClient } = await donated();
      // Anyone may sweep; only the treasury receives; the curve's own reserve stays.
      const reserve = await coin.read.reserveBalance();
      let treasuryBefore = await weth.read.balanceOf([treasury.address]);
      const carolBefore = await weth.read.balanceOf([carol.account.address]);
      await coin.write.sweepExcess({ account: carol.account });
      expect((await weth.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(parseEther('1'));
      expect(await weth.read.balanceOf([carol.account.address])).to.equal(carolBefore);
      expect(await coin.read.excessReserve()).to.equal(0n);
      expect(await coin.read.reserveBalance()).to.equal(reserve);
      expect(await weth.read.balanceOf([coin.address])).to.equal(reserve);
      // Only the sweep: the contract has no other function that pays out anything but a sale.
      const names = coin.abi.filter((entry) => entry.type === 'function' && entry.stateMutability !== 'view').map((entry) => entry.name);
      expect(names.filter((name) => /withdraw|rescue|skim|claim/i.test(name))).to.deep.equal([]);

      // A second donation, then the buy that fills the curve: the buyer's change is exactly
      // what the curve did not spend, and the donation waits for the sweep, graduated or not.
      let hash = await weth.write.transfer([coin.address, parseEther('1')], { account: carol.account });
      await publicClient.waitForTransactionReceipt({ hash });
      const aliceBefore = await weth.read.balanceOf([alice.account.address]);
      await buy(coin, alice, parseEther('20'));
      expect(await coin.read.cap()).to.equal(0n);
      const room = WETH_CAP - reserve;
      const spent = (room * 10_000n + 9_899n) / 9_900n;
      expect(aliceBefore - (await weth.read.balanceOf([alice.account.address]))).to.equal(spent);
      expect(await coin.read.excessReserve()).to.equal(parseEther('1'));
      treasuryBefore = await weth.read.balanceOf([treasury.address]);
      hash = await coin.write.sweepExcess({ account: carol.account });
      await publicClient.waitForTransactionReceipt({ hash });
      expect((await weth.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(parseEther('1'));
      expect(await weth.read.balanceOf([coin.address])).to.equal(0n);
    });

    it('5. leaves buy and sell exactly as they are on a coin nobody donated to', async () => {
      const { launch, buy, sell, weth, alice, bob, carol, publicClient } = await loadFixture(deployLaunchpad);
      const plain = await launch(alice, 'Plain', 'PLAIN');
      const gifted = await launch(alice, 'Gifted', 'GIFT');
      const hash = await weth.write.transfer([gifted.address, parseEther('3')], { account: carol.account });
      await publicClient.waitForTransactionReceipt({ hash });

      const trades: [typeof alice, 'buy' | 'sell', bigint][] = [
        [alice, 'buy', parseEther('0.7')],
        [bob, 'buy', parseEther('1.3')],
        [alice, 'sell', parseEther('100000000')],
        [bob, 'buy', parseEther('0.05')],
        [bob, 'sell', parseEther('250000000')],
      ];
      for (const [wallet, side, amount] of trades) {
        for (const coin of [plain, gifted]) {
          if (side === 'buy') await buy(coin, wallet, amount);
          else await sell(coin, wallet, amount);
        }
        // The same coins and the same reserve on both, to the wei, after every trade.
        expect(await gifted.read.balanceOf([wallet.account.address])).to.equal(await plain.read.balanceOf([wallet.account.address]));
        expect(await gifted.read.reserveBalance()).to.equal(await plain.read.reserveBalance());
        expect(await gifted.read.price()).to.equal(await plain.read.price());
      }
      expect(await gifted.read.excessReserve()).to.equal(parseEther('3'));
      expect(await plain.read.excessReserve()).to.equal(0n);
    });
  });

  describe('measured facts', () => {
    it('states the figures the copy quotes: 1.68 ETH of FDV at launch, 4.9× the raise at graduation, 20% backed', async () => {
      const { coin, coinFactory, weth } = await fresh();
      const billion = 1_000_000_000;
      const whole = (raw: bigint) => Number(raw) / 1e18;
      // Before the first buy: 1.68 ETH over a billion coins.
      expect(whole(await coin.read.price()) * billion).to.equal(1.68);
      // At the cap: 12.25 times that, 20.58 ETH of FDV on a 4.2 ETH raise, of which the pool's
      // 4.2 ETH is 20.4%.
      const closing = whole(await coinFactory.read.graduationPrice([weth.address]));
      expect(off(closing / 1.68e-9, 12.25) < 1e-6).to.equal(true);
      expect(off((closing * billion) / 4.2, 4.9) < 1e-6).to.equal(true);
      expect(off(4.2 / (closing * billion), 0.2041) < 1e-3).to.equal(true);
      // The first ninth of the raise buys 21.7% of the supply; three quarters of what the curve
      // sells, the most an opening buy may take, costs 46.2% of the raise.
      const ninth = whole(await coin.read.calculatePurchaseReturn([WETH_CAP / 9n]));
      expect(off(ninth / billion, 0.2174) < 1e-3).to.equal(true);
      const ceiling = ((await coin.read.supplyAtCap()) * 7_500n) / 10_000n;
      const cost = whole(await coin.read.calculatePurchaseCost([ceiling]));
      expect(off(cost / 4.2, 0.4615) < 1e-3).to.equal(true);
    });

    it('moves the graduated pool three quarters when a holder sells a fifth of the supply into it', async () => {
      const { coin, buy, alice, weth, swapRouter, listingManager, publicClient } = await fresh();
      await buy(coin, alice, parseEther('10'));
      const pool = await hre.viem.getContractAt('UniswapV3Pool', await listingManager.read.poolOf([coin.address]));
      const coinIsToken0 = coin.address.toLowerCase() < weth.address.toLowerCase();
      const [before] = await pool.read.slot0();

      const fifth = parseEther('200000000');
      let hash = await coin.write.approve([swapRouter.address, fifth], { account: alice.account });
      await publicClient.waitForTransactionReceipt({ hash });
      hash = await swapRouter.write.exactInputSingle(
        [
          {
            tokenIn: coin.address,
            tokenOut: weth.address,
            fee: POOL_FEE,
            recipient: alice.account.address,
            deadline: DEADLINE,
            amountIn: fifth,
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: 0n,
          },
        ],
        { account: alice.account }
      );
      await publicClient.waitForTransactionReceipt({ hash });
      const [after] = await pool.read.slot0();
      const drop = 1 - Number(poolPriceX18(after, coinIsToken0)) / Number(poolPriceX18(before, coinIsToken0));
      // 204.1M coins against 4.2 ETH; 198M more coins (after the pool's 1% fee) leave 2.13 ETH.
      expect(drop > 0.7 && drop < 0.78, `${drop}`).to.equal(true);
    });
  });
});
