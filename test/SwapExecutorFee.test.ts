import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { getAddress, maxUint256, parseEther, zeroAddress, type Address } from 'viem';
import { BPS, POOL_FEE, USD_CAP, WETH_CAP, deployLaunchpad, usd } from './helpers/launchpad';
import { DEADLINE, FORK_FEE, openForkPool, twoAmmsFixture } from './helpers/twoAmms';
import { encodeSwapPath } from './helpers/path';

const PERIPHERY = 1;
/** Where fees are paid in these tests: an address with nothing else, so its balance is the fees. */
const FEE_TO = getAddress('0x000000000000000000000000000000000000fee0');
const FEE_BPS = 5; // 0.05%, the rate the site starts at
const feeOf = (amount: bigint, bps = FEE_BPS) => (amount * BigInt(bps)) / BPS;

/**
 * The executor's trading fee (`setFee`, at most 0.25%) and its trades on this platform's bonding
 * curves (`buyCurve`, `sellCurve`): that the fee is the rate of what it is taken from, taken in
 * ether or a fee asset where the trade has one, paid to the recipient in the same transaction; that
 * a curve trade through the executor gets what the same trade direct would, less the fee; and that
 * the executor holds nothing afterwards. At a fee of zero it is the executor `SwapExecutor.test.ts`
 * covers.
 */
describe('SwapExecutor fee and curve trades', () => {
  async function balanceOf(token: Address, holder: Address) {
    const erc20 = await hre.viem.getContractAt('MockERC20', token);
    return erc20.read.balanceOf([holder]);
  }

  async function expectHoldsNothing(executor: Address, tokens: Address[]) {
    const publicClient = await hre.viem.getPublicClient();
    expect(await publicClient.getBalance({ address: executor })).to.equal(0n);
    for (const token of tokens) expect(await balanceOf(token, executor)).to.equal(0n);
  }

  describe('the fee', () => {
    async function poolFixture() {
      const fixture = await twoAmmsFixture();
      const { owner, weth, native, fork, dollar } = fixture;
      const executor = await hre.viem.deployContract('SwapExecutor', [weth.address, owner.account.address]);
      for (const router of [native.router, fork.router]) await executor.write.setVenue([router, PERIPHERY]);
      await openForkPool(fixture, weth.address, dollar.address, 500, parseEther('2500'), 6, 1_000_000n * 1_000_000n);
      await executor.write.setFee([FEE_BPS, FEE_TO]);
      return { ...fixture, executor };
    }
    type PoolFixture = Awaited<ReturnType<typeof poolFixture>>;

    const etherToCoin = (f: PoolFixture) => [{ router: f.native.router, path: encodeSwapPath([[f.weth.address, POOL_FEE]], f.coin.address) }];
    const coinToEther = (f: PoolFixture) => [{ router: f.native.router, path: encodeSwapPath([[f.coin.address, POOL_FEE]], f.weth.address) }];
    const coinToDollar = (f: PoolFixture) => [
      {
        router: f.native.router,
        path: encodeSwapPath([[f.coin.address, POOL_FEE]], f.weth.address),
      },
      { router: f.fork.router, path: encodeSwapPath([[f.weth.address, 500]], f.dollar.address) },
    ];

    it('is set by the owner alone, never above 0.25%, and never without a recipient', async () => {
      const f = await loadFixture(poolFixture);
      expect(await f.executor.read.MAX_FEE_BPS()).to.equal(25);
      await expect(f.executor.write.setFee([26, FEE_TO])).to.be.rejectedWith('FeeTooHigh');
      await expect(f.executor.write.setFee([5, zeroAddress])).to.be.rejectedWith('NoFeeRecipient');
      await expect(f.executor.write.setFee([5, FEE_TO], { account: f.bob.account })).to.be.rejectedWith('OwnableUnauthorizedAccount');
      await f.executor.write.setFee([25, FEE_TO]);
      expect(await f.executor.read.feeBps()).to.equal(25);
      await f.executor.write.setFee([0, zeroAddress]);
      expect(await f.executor.read.feeBps()).to.equal(0);
      await expect(f.executor.write.setFeeAsset([f.dollar.address, true], { account: f.bob.account })).to.be.rejectedWith(
        'OwnableUnauthorizedAccount'
      );
    });

    it('takes the fee from ether paid, before the legs, which spend exactly the rest', async () => {
      const f = await loadFixture(poolFixture);
      const amountIn = parseEther('1');
      const fee = feeOf(amountIn);
      const legs = (spend: bigint) => [{ amountIn: spend, minOut: 0n, steps: etherToCoin(f) }];
      const trade = (spend: bigint) => ({
        tokenIn: zeroAddress,
        tokenOut: f.coin.address,
        amountIn,
        minAmountOut: 0n,
        recipient: f.bob.account.address,
        deadline: DEADLINE,
        legs: legs(spend),
      });
      // Legs for the whole payment leave nothing for the fee.
      await expect(f.executor.write.execute([trade(amountIn)], { value: amountIn, account: f.bob.account })).to.be.rejectedWith(
        'AmountMismatch'
      );
      const coinsBefore = await balanceOf(f.coin.address, f.bob.account.address);
      await f.executor.write.execute([trade(amountIn - fee)], { value: amountIn, account: f.bob.account });
      expect(await balanceOf(f.weth.address, FEE_TO)).to.equal(fee);
      expect((await balanceOf(f.coin.address, f.bob.account.address)) > coinsBefore).to.equal(true);
      await expectHoldsNothing(f.executor.address, [f.weth.address, f.coin.address, f.dollar.address]);
    });

    it('takes it from the ether bought when a coin is paid, and holds the minimum to what is left', async () => {
      const f = await loadFixture(poolFixture);
      const amountIn = parseEther('1000000');
      await f.coin.write.approve([f.executor.address, maxUint256], { account: f.alice.account });
      const trade = (minAmountOut: bigint) => ({
        tokenIn: f.coin.address,
        tokenOut: zeroAddress,
        amountIn,
        minAmountOut,
        recipient: f.bob.account.address,
        deadline: DEADLINE,
        legs: [{ amountIn, minOut: 0n, steps: coinToEther(f) }],
      });
      // Every coin paid is swapped: the fee comes out of the ether.
      const gross = (await f.executor.simulate.execute([trade(0n)], { account: f.alice.account.address })).result;
      await f.executor.write.setFee([0, zeroAddress]);
      const plain = (await f.executor.simulate.execute([trade(0n)], { account: f.alice.account.address })).result;
      await f.executor.write.setFee([FEE_BPS, FEE_TO]);
      expect(gross).to.equal(plain - feeOf(plain));

      await expect(f.executor.write.execute([trade(gross + 1n)], { account: f.alice.account })).to.be.rejectedWith('TooLittleReceived');
      const etherBefore = await f.publicClient.getBalance({ address: f.bob.account.address });
      await f.executor.write.execute([trade(gross)], { account: f.alice.account });
      expect((await f.publicClient.getBalance({ address: f.bob.account.address })) - etherBefore).to.equal(gross);
      expect(await balanceOf(f.weth.address, FEE_TO)).to.equal(feeOf(plain));
      await expectHoldsNothing(f.executor.address, [f.weth.address, f.coin.address, f.dollar.address]);
    });

    it('takes it in a fee asset the owner names, and in what is paid where neither end is one', async () => {
      const f = await loadFixture(poolFixture);
      const amountIn = parseEther('1000000');
      await f.coin.write.approve([f.executor.address, maxUint256], { account: f.alice.account });
      const trade = (spend: bigint) => ({
        tokenIn: f.coin.address,
        tokenOut: f.dollar.address,
        amountIn,
        minAmountOut: 0n,
        recipient: f.bob.account.address,
        deadline: DEADLINE,
        legs: [{ amountIn: spend, minOut: 0n, steps: coinToDollar(f) }],
      });
      // Dollars are not a fee asset yet: the fee is a share of the coins paid.
      await f.executor.write.execute([trade(amountIn - feeOf(amountIn))], { account: f.alice.account });
      expect(await balanceOf(f.coin.address, FEE_TO)).to.equal(feeOf(amountIn));

      await f.executor.write.setFeeAsset([f.dollar.address, true]);
      const dollarsBefore = await balanceOf(f.dollar.address, f.bob.account.address);
      await f.executor.write.execute([trade(amountIn)], { account: f.alice.account });
      const received = (await balanceOf(f.dollar.address, f.bob.account.address)) - dollarsBefore;
      const fee = await balanceOf(f.dollar.address, FEE_TO);
      expect(fee > 0n).to.equal(true);
      expect(fee).to.equal(feeOf(received + fee));
      await expectHoldsNothing(f.executor.address, [f.weth.address, f.coin.address, f.dollar.address]);
    });

    it('charges nothing at zero: the legs spend the whole payment', async () => {
      const f = await loadFixture(poolFixture);
      await f.executor.write.setFee([0, zeroAddress]);
      const amountIn = parseEther('1');
      await f.executor.write.execute(
        [
          {
            tokenIn: zeroAddress,
            tokenOut: f.coin.address,
            amountIn,
            minAmountOut: 0n,
            recipient: f.bob.account.address,
            deadline: DEADLINE,
            legs: [{ amountIn, minOut: 0n, steps: etherToCoin(f) }],
          },
        ],
        { value: amountIn, account: f.bob.account }
      );
      expect(await balanceOf(f.weth.address, FEE_TO)).to.equal(0n);
    });
  });

  describe('curve trades', () => {
    async function curveFixture() {
      const stack = await deployLaunchpad();
      const { owner, alice, weth, dollar, coinFactory } = stack;
      const etherCoin = await stack.launch(alice, 'Curve Pepe', 'CPEPE');
      const dollarCoin = await stack.launch(alice, 'Curve Buck', 'CBUCK', { quote: dollar.address });
      const executor = await hre.viem.deployContract('SwapExecutor', [weth.address, owner.account.address]);
      await executor.write.setCoins([coinFactory.address]);
      await executor.write.setFee([FEE_BPS, FEE_TO]);
      await stack.approveAll(stack.bob, [weth.address, dollar.address, etherCoin.address, dollarCoin.address], executor.address);
      return { ...stack, etherCoin, dollarCoin, executor };
    }

    /** What `run` does to a balance, with the chain put back afterwards: the same trade made direct. */
    async function direct<T>(run: () => Promise<T>): Promise<T> {
      const id = await hre.network.provider.send('evm_snapshot');
      try {
        return await run();
      } finally {
        await hre.network.provider.send('evm_revert', [id]);
      }
    }

    it('buys with ether: the fee off the top, and the coins the rest buys direct', async () => {
      const f = await loadFixture(curveFixture);
      const amountIn = parseEther('0.5');
      const fee = feeOf(amountIn);
      const expected = await direct(async () => {
        const before = await f.etherCoin.read.balanceOf([f.bob.account.address]);
        await f.buy(f.etherCoin, f.bob, amountIn - fee);
        return (await f.etherCoin.read.balanceOf([f.bob.account.address])) - before;
      });
      const before = await f.etherCoin.read.balanceOf([f.carol.account.address]);
      await f.executor.write.buyCurve([f.etherCoin.address, amountIn, expected, f.carol.account.address, DEADLINE], {
        value: amountIn,
        account: f.bob.account,
      });
      expect((await f.etherCoin.read.balanceOf([f.carol.account.address])) - before).to.equal(expected);
      expect(await balanceOf(f.weth.address, FEE_TO)).to.equal(fee);
      await expectHoldsNothing(f.executor.address, [f.weth.address, f.etherCoin.address]);
    });

    it('buys with the reserve token, and holds the buyer to their minimum', async () => {
      const f = await loadFixture(curveFixture);
      const amountIn = usd(1_000);
      const quoted = await direct(async () => {
        const before = await f.dollarCoin.read.balanceOf([f.bob.account.address]);
        await f.buy(f.dollarCoin, f.bob, amountIn - feeOf(amountIn));
        return (await f.dollarCoin.read.balanceOf([f.bob.account.address])) - before;
      });
      await expect(
        f.executor.write.buyCurve([f.dollarCoin.address, amountIn, quoted + 1n, f.bob.account.address, DEADLINE], { account: f.bob.account })
      ).to.be.rejectedWith('TooLittleReceived');
      await f.executor.write.buyCurve([f.dollarCoin.address, amountIn, quoted, f.bob.account.address, DEADLINE], { account: f.bob.account });
      expect(await balanceOf(f.dollar.address, FEE_TO)).to.equal(feeOf(amountIn));
      await expectHoldsNothing(f.executor.address, [f.dollar.address, f.dollarCoin.address]);
    });

    it('fills the curve: the fee only on what the curve took, the rest back to the buyer', async () => {
      const f = await loadFixture(curveFixture);
      const amountIn = USD_CAP * 2n;
      const dollarsBefore = await balanceOf(f.dollar.address, f.bob.account.address);
      await f.executor.write.buyCurve([f.dollarCoin.address, amountIn, 0n, f.bob.account.address, DEADLINE], { account: f.bob.account });
      expect(await f.dollarCoin.read.cap()).to.equal(0n); // graduated
      const spent = dollarsBefore - (await balanceOf(f.dollar.address, f.bob.account.address));
      const fee = await balanceOf(f.dollar.address, FEE_TO);
      // The fee is its rate of what went to the curve, give or take the division's last unit.
      const toCurve = spent - fee;
      const due = (toCurve * BigInt(FEE_BPS)) / (BPS - BigInt(FEE_BPS));
      expect(fee - due <= 1n && due - fee <= 1n).to.equal(true);
      expect(spent < amountIn).to.equal(true);
      await expectHoldsNothing(f.executor.address, [f.dollar.address, f.dollarCoin.address]);
    });

    it('sells for ether and for the reserve token, the fee off the proceeds', async () => {
      const f = await loadFixture(curveFixture);
      await f.buy(f.etherCoin, f.bob, parseEther('1'));
      await f.buy(f.dollarCoin, f.bob, usd(2_000));
      const coins = (await f.etherCoin.read.balanceOf([f.bob.account.address])) / 2n;

      const plain = await direct(async () => {
        const before = await balanceOf(f.weth.address, f.bob.account.address);
        await f.sell(f.etherCoin, f.bob, coins);
        return (await balanceOf(f.weth.address, f.bob.account.address)) - before;
      });
      const etherBefore = await f.publicClient.getBalance({ address: f.carol.account.address });
      await f.executor.write.sellCurve([f.etherCoin.address, coins, plain - feeOf(plain), f.carol.account.address, DEADLINE, true], {
        account: f.bob.account,
      });
      expect((await f.publicClient.getBalance({ address: f.carol.account.address })) - etherBefore).to.equal(plain - feeOf(plain));
      expect(await balanceOf(f.weth.address, FEE_TO)).to.equal(feeOf(plain));

      const dollarCoins = await f.dollarCoin.read.balanceOf([f.bob.account.address]);
      const dollarsBefore = await balanceOf(f.dollar.address, f.bob.account.address);
      await f.executor.write.sellCurve([f.dollarCoin.address, dollarCoins, 0n, f.bob.account.address, DEADLINE, false], {
        account: f.bob.account,
      });
      const received = (await balanceOf(f.dollar.address, f.bob.account.address)) - dollarsBefore;
      expect(await balanceOf(f.dollar.address, FEE_TO)).to.equal(feeOf(received + (await balanceOf(f.dollar.address, FEE_TO))));
      await expect(
        f.executor.write.sellCurve([f.dollarCoin.address, 1n, 0n, f.bob.account.address, DEADLINE, true], { account: f.bob.account })
      ).to.be.rejectedWith('WrongValue');
      await expectHoldsNothing(f.executor.address, [f.weth.address, f.dollar.address, f.etherCoin.address, f.dollarCoin.address]);
    });

    it('trades only coins the registry names, before the deadline, to a real recipient', async () => {
      const f = await loadFixture(curveFixture);
      const bare = await hre.viem.deployContract('SwapExecutor', [f.weth.address, f.owner.account.address]);
      await expect(
        bare.write.buyCurve([f.etherCoin.address, 1n, 0n, f.bob.account.address, DEADLINE], { value: 1n, account: f.bob.account })
      ).to.be.rejectedWith('NotACoin');
      await expect(
        f.executor.write.buyCurve([f.dollar.address, 1n, 0n, f.bob.account.address, DEADLINE], { account: f.bob.account })
      ).to.be.rejectedWith('NotACoin');
      await expect(
        f.executor.write.buyCurve([f.etherCoin.address, 1n, 0n, f.bob.account.address, 1n], { value: 1n, account: f.bob.account })
      ).to.be.rejectedWith('Expired');
      await expect(
        f.executor.write.buyCurve([f.etherCoin.address, 1n, 0n, zeroAddress, DEADLINE], { value: 1n, account: f.bob.account })
      ).to.be.rejectedWith('BadRecipient');
      // Ether only for a coin priced in wrapped ether, and exactly the amount.
      await expect(
        f.executor.write.buyCurve([f.dollarCoin.address, 1n, 0n, f.bob.account.address, DEADLINE], { value: 1n, account: f.bob.account })
      ).to.be.rejectedWith('WrongValue');
      await expect(
        f.executor.write.buyCurve([f.etherCoin.address, 2n, 0n, f.bob.account.address, DEADLINE], { value: 1n, account: f.bob.account })
      ).to.be.rejectedWith('WrongValue');
    });

    it('charges no fee at zero, and a curve that has graduated trades nowhere here', async () => {
      const f = await loadFixture(curveFixture);
      await f.executor.write.setFee([0, zeroAddress]);
      await f.executor.write.buyCurve([f.etherCoin.address, parseEther('0.1'), 0n, f.bob.account.address, DEADLINE], {
        value: parseEther('0.1'),
        account: f.bob.account,
      });
      expect(await balanceOf(f.weth.address, FEE_TO)).to.equal(0n);
      await f.executor.write.buyCurve([f.etherCoin.address, WETH_CAP * 2n, 0n, f.bob.account.address, DEADLINE], {
        value: WETH_CAP * 2n,
        account: f.bob.account,
      });
      await expect(
        f.executor.write.buyCurve([f.etherCoin.address, parseEther('0.1'), 0n, f.bob.account.address, DEADLINE], {
          value: parseEther('0.1'),
          account: f.bob.account,
        })
      ).to.be.rejected;
    });
  });
});
