import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { maxUint256, parseEther, zeroAddress, type Address } from 'viem';
import { POOL_FEE } from './helpers/launchpad';
import { DEADLINE, FORK_FEE, openForkPool, twoAmmsFixture } from './helpers/twoAmms';
import { encodeSwapPath } from './helpers/path';
import { routeHashOf, type Trade } from './helpers/path';

const PERIPHERY = 1;
const ROUTER02 = 2;
const usd = (amount: number) => BigInt(amount) * 1_000_000n;

/**
 * The `SwapExecutor` on its own: that it runs what it is given only inside the trader's terms —
 * listed routers, joined paths, the amount, the minimum, the deadline, the recipient — returns what
 * pools leave unspent, holds nothing afterwards, and settles every leg or none. The routing engine
 * that chooses its trades is tested in `RoutingEngine.test.ts`.
 */
describe('SwapExecutor', () => {
  async function executorFixture() {
    const fixture = await twoAmmsFixture();
    const { owner, weth, native, fork, dollar } = fixture;
    const executor = await hre.viem.deployContract('SwapExecutor', [weth.address, owner.account.address]);
    for (const router of [native.router, fork.router]) {
      await executor.write.setVenue([router, PERIPHERY], { account: owner.account });
    }
    await openForkPool(fixture, weth.address, dollar.address, 500, parseEther('2500'), 6, usd(1_000_000));
    return { ...fixture, executor };
  }
  type ExecutorFixture = Awaited<ReturnType<typeof executorFixture>>;

  /** One leg of `amountIn` ether into the coin on one AMM: ours at 1%, or the fork at 0.3%. */
  const buyLeg = (f: ExecutorFixture, on: 'native' | 'fork', amountIn: bigint, minOut = 0n) => ({
    amountIn,
    minOut,
    steps: [
      {
        router: on === 'native' ? f.native.router : f.fork.router,
        path: encodeSwapPath([[f.weth.address, on === 'native' ? POOL_FEE : FORK_FEE]], f.coin.address),
      },
    ],
  });

  const trade = (f: ExecutorFixture, legs: Trade['legs'], overrides: Partial<Trade> = {}): Trade => ({
    tokenIn: zeroAddress,
    tokenOut: f.coin.address,
    amountIn: legs.reduce((sum, leg) => sum + leg.amountIn, 0n),
    minAmountOut: 0n,
    recipient: f.bob.account.address,
    deadline: DEADLINE,
    legs,
    ...overrides,
  });

  async function expectEmpty(f: ExecutorFixture, routers: Address[] = [f.native.router, f.fork.router]) {
    expect(await f.publicClient.getBalance({ address: f.executor.address })).to.equal(0n);
    for (const token of [f.weth.address, f.coin.address, f.dollar.address]) {
      const erc20 = await hre.viem.getContractAt('MockERC20', token);
      expect(await erc20.read.balanceOf([f.executor.address])).to.equal(0n);
      for (const router of routers) expect(await erc20.read.allowance([f.executor.address, router])).to.equal(0n);
    }
  }

  describe('guards', () => {
    it('calls only routers the owner listed, and only the owner lists them', async () => {
      const f = await loadFixture(executorFixture);
      const leg = { ...buyLeg(f, 'native', parseEther('0.1')), steps: [{ ...buyLeg(f, 'native', 0n).steps[0]!, router: f.coin.address }] };
      await expect(f.executor.write.execute([trade(f, [leg])], { account: f.bob.account, value: parseEther('0.1') })).to.be.rejectedWith(
        'UnlistedRouter'
      );
      await expect(f.executor.write.setVenue([f.native.router, 0], { account: f.bob.account })).to.be.rejectedWith(
        'OwnableUnauthorizedAccount'
      );
    });

    it('refuses steps that do not start at what is paid, join each other, and end at what is bought', async () => {
      const f = await loadFixture(executorFixture);
      const amount = parseEther('0.1');
      const send = (legs: Trade['legs'], overrides: Partial<Trade> = {}) =>
        f.executor.write.execute([trade(f, legs, overrides)], { account: f.bob.account, value: amount });
      const wethToCoin = buyLeg(f, 'native', amount).steps[0]!;
      const wethToDollar = { router: f.fork.router, path: encodeSwapPath([[f.weth.address, 500]], f.dollar.address) };
      const coinToWeth = { router: f.native.router, path: encodeSwapPath([[f.coin.address, POOL_FEE]], f.weth.address) };

      // Ends somewhere else.
      await expect(send([{ amountIn: amount, minOut: 0n, steps: [wethToDollar] }])).to.be.rejectedWith('WrongPath');
      // Starts somewhere else.
      await expect(send([{ amountIn: amount, minOut: 0n, steps: [coinToWeth, wethToCoin] }])).to.be.rejectedWith('WrongPath');
      // Two steps that do not join: dollars out of the first, ether into the second.
      await expect(send([{ amountIn: amount, minOut: 0n, steps: [wethToDollar, wethToCoin] }])).to.be.rejectedWith('WrongPath');
      // Through the token bought on the way: coin, then back to ether, then coin again.
      await expect(send([{ amountIn: amount, minOut: 0n, steps: [wethToCoin, coinToWeth, wethToCoin] }])).to.be.rejectedWith(
        'WrongPath'
      );
    });

    it('takes exactly the trade in ether, to a real recipient, before the deadline, legs adding up', async () => {
      const f = await loadFixture(executorFixture);
      const amount = parseEther('0.1');
      const legs = [buyLeg(f, 'native', amount)];
      const account = f.bob.account;
      await expect(f.executor.write.execute([trade(f, legs)], { account, value: amount + 1n })).to.be.rejectedWith('WrongValue');
      await expect(f.executor.write.execute([trade(f, legs, { deadline: 1n })], { account, value: amount })).to.be.rejectedWith('Expired');
      await expect(f.executor.write.execute([trade(f, legs, { recipient: zeroAddress })], { account, value: amount })).to.be.rejectedWith(
        'BadRecipient'
      );
      await expect(
        f.executor.write.execute([trade(f, legs, { recipient: f.executor.address })], { account, value: amount })
      ).to.be.rejectedWith('BadRecipient');
      await expect(f.executor.write.execute([trade(f, legs, { amountIn: amount * 2n })], { account, value: amount * 2n })).to.be.rejectedWith(
        'AmountMismatch'
      );
      await expect(f.executor.write.execute([trade(f, [])], { account, value: 0n })).to.be.rejectedWith('BadLegs');
      const four = { ...legs[0]!, steps: [...legs[0]!.steps, ...legs[0]!.steps, ...legs[0]!.steps, ...legs[0]!.steps] };
      await expect(f.executor.write.execute([trade(f, [four])], { account, value: amount })).to.be.rejectedWith('BadLegs');
      await expect(
        f.bob.sendTransaction({ to: f.executor.address, value: 1n, account, chain: f.bob.chain })
      ).to.be.rejected;
    });

    it("never spends one wallet's approval for another, and pays only the recipient named", async () => {
      const f = await loadFixture(executorFixture);
      const { coin, alice, bob, carol, executor, publicClient } = f;
      let hash = await coin.write.approve([executor.address, maxUint256], { account: alice.account });
      await publicClient.waitForTransactionReceipt({ hash });
      const sell = {
        amountIn: parseEther('1000'),
        minOut: 0n,
        steps: [{ router: f.native.router, path: encodeSwapPath([[coin.address, POOL_FEE]], f.weth.address) }],
      };
      // Carol holds none of the coin: the executor pulls from whoever calls, so her call fails
      // however much Alice has approved.
      await expect(
        executor.write.execute([trade(f, [sell], { tokenIn: coin.address, tokenOut: zeroAddress, recipient: carol.account.address })], {
          account: carol.account,
        })
      ).to.be.rejected;
      // Bob pays and names Carol: Carol receives, Bob keeps nothing but the bill.
      const bobBefore = await coin.read.balanceOf([bob.account.address]);
      const carolBefore = await coin.read.balanceOf([carol.account.address]);
      hash = await executor.write.execute([trade(f, [buyLeg(f, 'native', parseEther('0.1'))], { recipient: carol.account.address })], {
        account: bob.account,
        value: parseEther('0.1'),
      });
      await publicClient.waitForTransactionReceipt({ hash });
      expect(await coin.read.balanceOf([bob.account.address])).to.equal(bobBefore);
      expect((await coin.read.balanceOf([carol.account.address])) > carolBefore).to.equal(true);
      await expectEmpty(f);
    });
  });

  it("calls a SwapRouter02-shaped router as SwapRouter02, beside a v3-periphery one", async () => {
    const f = await loadFixture(executorFixture);
    const front = await hre.viem.deployContract('Router02Front', [f.fork.router]);
    await f.executor.write.setVenue([front.address, ROUTER02], { account: f.owner.account });
    const viaFront = { ...buyLeg(f, 'fork', parseEther('0.2')), steps: [{ ...buyLeg(f, 'fork', 0n).steps[0]!, router: front.address }] };
    const before = await f.coin.read.balanceOf([f.bob.account.address]);
    const hash = await f.executor.write.execute([trade(f, [buyLeg(f, 'native', parseEther('0.3')), viaFront])], {
      account: f.bob.account,
      value: parseEther('0.5'),
    });
    await f.publicClient.waitForTransactionReceipt({ hash });
    expect((await f.coin.read.balanceOf([f.bob.account.address])) > before).to.equal(true);
    await expectEmpty(f, [f.native.router, f.fork.router, front.address]);
  });

  it('returns to the caller what a pool leaves unspent, at the first step and in the middle of a leg', async () => {
    const f = await loadFixture(executorFixture);
    const { coin, alice, weth, dollar, executor, owner, publicClient } = f;
    const half = await hre.viem.deployContract('HalfSpendingRouter', []);
    await executor.write.setVenue([half.address, PERIPHERY], { account: owner.account });
    let hash = await weth.write.transfer([half.address, parseEther('1')], { account: alice.account });
    await publicClient.waitForTransactionReceipt({ hash });
    hash = await dollar.write.transfer([half.address, usd(1_000)], { account: alice.account });
    await publicClient.waitForTransactionReceipt({ hash });
    hash = await coin.write.approve([executor.address, maxUint256], { account: alice.account });
    await publicClient.waitForTransactionReceipt({ hash });

    // First step: half the coin comes back.
    const amountIn = parseEther('1000');
    const coinBefore = await coin.read.balanceOf([alice.account.address]);
    hash = await executor.write.execute(
      [
        trade(f, [{ amountIn, minOut: 5n, steps: [{ router: half.address, path: encodeSwapPath([[coin.address, 3_000]], weth.address) }] }], {
          tokenIn: coin.address,
          tokenOut: weth.address,
          recipient: alice.account.address,
        }),
      ],
      { account: alice.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });
    expect(coinBefore - (await coin.read.balanceOf([alice.account.address]))).to.equal(amountIn / 2n);

    // Second step: the coin sells for wrapped ether on ours, half of which the next pool leaves.
    const wethBefore = await weth.read.balanceOf([alice.account.address]);
    hash = await executor.write.execute(
      [
        trade(
          f,
          [
            {
              amountIn,
              minOut: 7n,
              steps: [
                { router: f.native.router, path: encodeSwapPath([[coin.address, POOL_FEE]], weth.address) },
                { router: half.address, path: encodeSwapPath([[weth.address, 500]], dollar.address) },
              ],
            },
          ],
          { tokenIn: coin.address, tokenOut: dollar.address, recipient: alice.account.address }
        ),
      ],
      { account: alice.account }
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).to.equal('success');
    expect((await weth.read.balanceOf([alice.account.address])) > wethBefore).to.equal(true);
    await expectEmpty(f, [f.native.router, f.fork.router, half.address]);
  });

  it('holds its invariants across random trades: paid at least the minimum or not at all, and holding nothing', async () => {
    const f = await loadFixture(executorFixture);
    const { coin, bob, carol, executor, publicClient } = f;
    // A fixed seed: the same trades on every run.
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let settled = 0;
    let refused = 0;
    for (let round = 0; round < 16; round++) {
      const legs = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
        buyLeg(f, random() < 0.5 ? 'native' : 'fork', parseEther((0.01 + random() * 0.4).toFixed(4)))
      ).filter((leg, index, all) => all.findIndex((other) => other.steps[0]!.router === leg.steps[0]!.router) === index);
      const plain = trade(f, legs, { recipient: carol.account.address });
      // What the legs pay, asked of the chain without sending, sets a minimum a little either side of it.
      const { result: expected } = await executor.simulate.execute([plain], { account: bob.account.address, value: plain.amountIn });
      const minAmountOut = (expected * BigInt(Math.floor(9_000 + random() * 2_000))) / 10_000n;
      const terms: Trade = { ...plain, minAmountOut };
      const carolBefore = await coin.read.balanceOf([carol.account.address]);
      const bobBefore = await coin.read.balanceOf([bob.account.address]);
      try {
        const hash = await executor.write.execute([terms], { account: bob.account, value: terms.amountIn });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        expect(receipt.status).to.equal('success');
        const received = (await coin.read.balanceOf([carol.account.address])) - carolBefore;
        expect(received >= minAmountOut).to.equal(true);
        settled++;
      } catch {
        expect(minAmountOut > expected).to.equal(true);
        expect(await coin.read.balanceOf([carol.account.address])).to.equal(carolBefore);
        refused++;
      }
      expect(await coin.read.balanceOf([bob.account.address])).to.equal(bobBefore);
      await expectEmpty(f);
      expect(routeHashOf(terms)).to.match(/^0x[0-9a-f]{64}$/);
    }
    expect(settled).to.be.greaterThan(0);
    expect(refused).to.be.greaterThan(0);
  });
});

