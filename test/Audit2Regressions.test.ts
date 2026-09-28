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
    it('evaluates a fresh curve to within a millionth of a percent, above and below one ETH', async () => {
      const { formula } = await loadFixture(fresh);
      // 800M · (R / 4.2)^(5/11) coins. Exact values from 90-digit decimal arithmetic; the formula
      // takes the supply as an argument, so this checks its precision, not the deployed figure.
      const cases: [bigint, bigint][] = [
        [WETH_CAP, 800_000_000_000_000_000_000_000_000n],
        [parseEther('2'), 570_987_592_537_575_852_063_128_134n],
        [parseEther('0.1'), 146_301_709_387_744_741_999_845_428n],
        [parseEther('0.001'), 18_036_758_539_348_182_354_485_877n],
      ];
      for (const [reserve, exact] of cases) {
        const supply = await formula.read.supplyAt([reserve, WETH_CAP, parseEther('800000000'), 6, 5]);
        expect(ppm(supply, exact), `reserve ${reserve}`).to.be.lessThan(0.01);
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

  describe('forced reserve (G-03)', () => {
    it('refuses a buy with a reason once pushed-in reserve has filled the cap, and resumes after a sell', async () => {
      const { coin, buy, sell, weth, alice, bob, publicClient } = await loadFixture(fresh);
      await buy(coin, alice, parseEther('1'));
      const cap = await coin.read.cap();
      // Anyone can send the reserve token straight to the coin, past the curve.
      const hash = await weth.write.transfer([coin.address, cap - (await coin.read.reserveBalance())], {
        account: bob.account,
      });
      await publicClient.waitForTransactionReceipt({ hash });

      await expect(buy(coin, bob, parseEther('0.1'))).to.be.rejectedWith('Curve is full');
      expect(await coin.read.cap()).to.equal(cap);

      await sell(coin, alice, (await coin.read.balanceOf([alice.account.address])) / 10n);
      await buy(coin, bob, parseEther('0.1'));
    });

    it('sweeps pushed-in reserve on an empty curve to the treasury rather than to the next buyer', async () => {
      const { coin, buy, sell, weth, alice, bob, publicClient, treasury } = await loadFixture(fresh);
      await buy(coin, alice, parseEther('1'));
      await sell(coin, alice, await coin.read.balanceOf([alice.account.address]));
      expect(await coin.read.totalSupply()).to.equal(0n);
      const hash = await weth.write.transfer([coin.address, parseEther('1')], { account: alice.account });
      await publicClient.waitForTransactionReceipt({ hash });

      // Before the fix bob paid 0.01 ETH and sold the whole curve for 0.9691.
      const treasuryBefore = await weth.read.balanceOf([treasury.address]);
      const before = await weth.read.balanceOf([bob.account.address]);
      await buy(coin, bob, parseEther('0.01'));
      await sell(coin, bob, await coin.read.balanceOf([bob.account.address]));
      const after = await weth.read.balanceOf([bob.account.address]);
      expect(after < before).to.equal(true);
      // The 1 ETH went to the treasury, along with bob's fees.
      const treasuryGain = (await weth.read.balanceOf([treasury.address])) - treasuryBefore;
      expect(treasuryGain > parseEther('1')).to.equal(true);
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
