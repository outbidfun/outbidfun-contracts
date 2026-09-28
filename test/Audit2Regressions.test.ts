import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { parseEther, type Address } from 'viem';
import { WETH_CAP, deployLaunchpad } from './helpers/launchpad';

/** Relative distance between two bigints, in parts per million. */
const ppm = (a: bigint, b: bigint) => Number(((a > b ? a - b : b - a) * 1_000_000_000n) / b) / 1000;

async function fresh() {
  const stack = await deployLaunchpad();
  const coin = await stack.launch(stack.alice, 'Regression', 'REG');
  return { ...stack, coin };
}

/** The supply a fresh curve reaches when `total` of value arrives in `steps` equal buys. */
async function supplyAfter(total: bigint, steps: number) {
  const stack = await deployLaunchpad();
  const coin = await stack.launch(stack.alice, 'Regression', 'REG');
  for (let i = 0; i < steps; i++) await stack.buy(coin, stack.bob, total / BigInt(steps));
  return { supply: await coin.read.totalSupply(), reserve: await coin.read.reserveBalance() };
}

describe('Second review regressions', () => {
  describe('the first buy (G-01)', () => {
    it('evaluates a fresh curve exactly, above and below one ETH', async () => {
      const { coin } = await loadFixture(fresh);
      // A billion · R / (1.68 + R) coins: a quarter of the phantom quote buys a fifth of the
      // model, the phantom quote itself half, and one and a half times it three fifths. The power
      // curve this replaced answered 0.2% short here; the constant product is exact to the wei.
      const cases: [bigint, bigint][] = [
        [parseEther('0.42'), parseEther('200000000')],
        [parseEther('1.68'), parseEther('500000000')],
        [parseEther('2.52'), parseEther('600000000')],
        // 10^27 · 0.001 / 1.681, floored.
        [parseEther('0.001'), 594_883_997_620_464_009_518_143n],
      ];
      for (const [deposit, exact] of cases) {
        expect(await coin.read.calculatePurchaseReturn([deposit]), `deposit ${deposit}`).to.equal(exact);
      }
    });

    it('reaches the same supply for the same reserve however many buys it took', async () => {
      const one = await supplyAfter(parseEther('3'), 1);
      for (const steps of [2, 10, 40]) {
        const many = await supplyAfter(parseEther('3'), steps);
        expect(many.reserve).to.equal(one.reserve);
        // Before the fix this was 503, 1318 and 1786 parts per million.
        expect(ppm(many.supply, one.supply), `${steps} buys`).to.be.lessThan(0.01);
      }
    });

    it('quotes the graduation price where the pool actually opens', async () => {
      const { coin, coinFactory, buy, weth, alice, bob, listingManager } = await loadFixture(fresh);
      await buy(coin, alice, parseEther('4'));
      await buy(coin, bob, parseEther('10'));
      const pool = await hre.viem.getContractAt(
        'UniswapV3Pool',
        (await listingManager.read.poolOf([coin.address])) as Address
      );
      const [sqrt] = await pool.read.slot0();
      const coinIsToken0 = (await pool.read.token0()).toLowerCase() === coin.address.toLowerCase();
      const ratio = sqrt * sqrt;
      const opened = coinIsToken0 ? (ratio * 10n ** 18n) / (1n << 192n) : ((1n << 192n) * 10n ** 18n) / ratio;
      // Was 8.4 basis points apart; the pool's own sqrt rounding is all that is left.
      expect(ppm(await coinFactory.read.graduationPrice([weth.address]), opened)).to.be.lessThan(1);
    });
  });

  describe('forced reserve (G-03; AUDIT-6 K-04)', () => {
    it('never counts reserve token sent past the curve: not for the cap, and not for a buy', async () => {
      const { coin, buy, weth, alice, bob, publicClient, treasury } = await loadFixture(fresh);
      await buy(coin, alice, parseEther('1'));
      const cap = await coin.read.cap();
      const reserve = await coin.read.reserveBalance();
      // Anyone can send the reserve token straight to the coin, past the curve. It used to fill
      // the cap and stop every buy until someone sold or graduated it (AUDIT-3 H-04).
      const hash = await weth.write.transfer([coin.address, cap - reserve], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      expect(await coin.read.reserveBalance()).to.equal(reserve);
      expect(await coin.read.excessReserve()).to.equal(cap - reserve);

      await buy(coin, bob, parseEther('0.1'));
      expect(await coin.read.cap()).to.equal(cap);
      expect(await coin.read.reserveBalance()).to.equal(reserve + parseEther('0.099'));

      // What the market would do on seeing the balance at the cap: a sweep, not a graduation.
      const treasuryBefore = await weth.read.balanceOf([treasury.address]);
      await coin.write.graduate({ account: bob.account });
      expect(await coin.read.cap()).to.equal(cap);
      expect((await weth.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(cap - reserve);
    });

    it('lets nobody buy an empty curve\'s pushed-in reserve, which only the sweep can move', async () => {
      const { coin, buy, sell, weth, alice, bob, carol, publicClient, treasury } = await loadFixture(fresh);
      await buy(coin, alice, parseEther('1'));
      await sell(coin, alice, await coin.read.balanceOf([alice.account.address]));
      expect(await coin.read.totalSupply()).to.equal(0n);
      const hash = await weth.write.transfer([coin.address, parseEther('1')], { account: alice.account });
      await publicClient.waitForTransactionReceipt({ hash });

      // Before the fix bob paid 0.01 ETH and sold the whole curve for 0.9691.
      const before = await weth.read.balanceOf([bob.account.address]);
      await buy(coin, bob, parseEther('0.01'));
      await sell(coin, bob, await coin.read.balanceOf([bob.account.address]));
      expect((await weth.read.balanceOf([bob.account.address])) < before).to.equal(true);
      expect((await coin.read.excessReserve()) >= parseEther('1')).to.equal(true);

      const treasuryBefore = await weth.read.balanceOf([treasury.address]);
      await coin.write.sweepExcess({ account: carol.account });
      expect((await weth.read.balanceOf([treasury.address])) - treasuryBefore >= parseEther('1')).to.equal(true);
      expect(await coin.read.excessReserve()).to.equal(0n);
    });
  });

  describe('small things (G-05, G-06)', () => {
    it('refuses a sale of nothing', async () => {
      const { coin, buy, alice } = await loadFixture(fresh);
      await buy(coin, alice, parseEther('1'));
      await expect(coin.write.sell([0n, 0n], { account: alice.account })).to.be.rejectedWith(
        'Zero sale amount'
      );
    });

    it('answers a quote for more than the supply with a reason', async () => {
      const { coin, buy, alice } = await loadFixture(fresh);
      await buy(coin, alice, parseEther('1'));
      const supply = await coin.read.totalSupply();
      await expect(coin.read.calculateSaleReturn([supply + 1n])).to.be.rejectedWith(
        'Retire Amount Exceeds Supply'
      );
    });
  });
});
