import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { maxUint256, parseEther } from 'viem';
import { POOL_FEE, USD_DECIMALS, deployLaunchpad, sqrtPriceX96For, usd } from './helpers/launchpad';
import { encodeSwapPath } from './helpers/path';

const DEADLINE = 4_102_444_800n; // 2100-01-01

/**
 * Token-to-token swaps, and the path the browser builds for them.
 *
 * A coin's only pool is against the asset it was priced in — the listing manager opens exactly
 * one per coin — so there is no direct pool between two coins. Two coins priced in the same
 * asset are reachable through it in a single `exactInput`, and the path the browser hands the
 * router is tightly packed bytes with no ABI decoding to catch a mistake: a wrongly packed path
 * is a *different* path, not an error.
 *
 * So the encoder lives in `apps/web/src/utils/route.ts` as a pure function, and this runs its
 * actual output through the real QuoterV2 and SwapRouter.
 */
describe('Swap routing', () => {
  async function twoPoolsFixture() {
    const stack = await deployLaunchpad();
    const coins = [];
    for (const [name, symbol] of [
      ['Front Page Pepe', 'PEPE'],
      ['Bull Market', 'BULL'],
    ] as const) {
      const coin = await stack.launch(stack.alice, name, symbol);
      await stack.buy(coin, stack.alice, parseEther('10'));
      coins.push(coin);
    }
    return { ...stack, first: coins[0]!, second: coins[1]! };
  }

  it('quotes and fills a coin-to-coin swap through the asset both are priced in', async () => {
    const { first, second, weth, swapRouter, quoter, alice, bob, publicClient } =
      await loadFixture(twoPoolsFixture);

    // Bob holds the first coin and wants the second. No pool pairs them.
    let hash = await first.write.transfer(
      [bob.account.address, (await first.read.balanceOf([alice.account.address])) / 4n],
      { account: alice.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });
    hash = await first.write.approve([swapRouter.address, maxUint256], { account: bob.account });
    await publicClient.waitForTransactionReceipt({ hash });

    const amountIn = (await first.read.balanceOf([bob.account.address])) / 20n;
    const path = encodeSwapPath([[first.address, POOL_FEE], [weth.address, POOL_FEE]], second.address);

    // The path is 20 + 3 + 20 + 3 + 20 bytes, packed, and starts with the token being sold.
    expect(path.length).to.equal(2 + 66 * 2);
    expect(path.slice(0, 42).toLowerCase()).to.equal(first.address.toLowerCase());
    expect(`0x${path.slice(-40)}`.toLowerCase()).to.equal(second.address.toLowerCase());

    const { result: quoted } = await quoter.simulate.quoteExactInput([path, amountIn]);
    expect(quoted[0] > 0n, 'the quoter found no route').to.equal(true);

    const before = await second.read.balanceOf([bob.account.address]);
    hash = await swapRouter.write.exactInput(
      [
        {
          path,
          recipient: bob.account.address,
          deadline: DEADLINE,
          amountIn,
          amountOutMinimum: (quoted[0] * 99n) / 100n,
        },
      ],
      { account: bob.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });

    const received = (await second.read.balanceOf([bob.account.address])) - before;
    expect(received > 0n, 'nothing arrived').to.equal(true);
    // The quote is what the swap does, to a wei.
    expect(received).to.equal(quoted[0]);
    // And it really was two hops: the coin sold is gone, and no WETH is left with the trader
    // beyond what they started with.
    expect(await weth.read.balanceOf([bob.account.address])).to.equal(parseEther('500'));
  });

  it('routes the same pair back the other way', async () => {
    const { first, second, weth, swapRouter, quoter, alice, bob, publicClient } =
      await loadFixture(twoPoolsFixture);

    let hash = await second.write.transfer(
      [bob.account.address, (await second.read.balanceOf([alice.account.address])) / 4n],
      { account: alice.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });
    hash = await second.write.approve([swapRouter.address, maxUint256], { account: bob.account });
    await publicClient.waitForTransactionReceipt({ hash });

    const amountIn = (await second.read.balanceOf([bob.account.address])) / 20n;
    const path = encodeSwapPath([[second.address, POOL_FEE], [weth.address, POOL_FEE]], first.address);
    const { result: quoted } = await quoter.simulate.quoteExactInput([path, amountIn]);

    const before = await first.read.balanceOf([bob.account.address]);
    hash = await swapRouter.write.exactInput(
      [
        {
          path,
          recipient: bob.account.address,
          deadline: DEADLINE,
          amountIn,
          amountOutMinimum: 0n,
        },
      ],
      { account: bob.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });
    expect((await first.read.balanceOf([bob.account.address])) - before).to.equal(quoted[0]);
  });

  it('costs two fees, which is what makes the route worth showing', async () => {
    const { first, second, weth, quoter } = await loadFixture(twoPoolsFixture);

    const amountIn = parseEther('100000');
    const twoHop = encodeSwapPath([[first.address, POOL_FEE], [weth.address, POOL_FEE]], second.address);
    const { result: viaEth } = await quoter.simulate.quoteExactInput([twoHop, amountIn]);

    // The same trade as two single hops: coin to ETH, then that ETH to the other coin.
    const { result: toEth } = await quoter.simulate.quoteExactInputSingle([
      {
        tokenIn: first.address,
        tokenOut: weth.address,
        amountIn,
        fee: POOL_FEE,
        sqrtPriceLimitX96: 0n,
      },
    ]);
    const { result: toCoin } = await quoter.simulate.quoteExactInputSingle([
      {
        tokenIn: weth.address,
        tokenOut: second.address,
        amountIn: toEth[0],
        fee: POOL_FEE,
        sqrtPriceLimitX96: 0n,
      },
    ]);

    // One transaction, but the same two pools and the same two 1% fees.
    expect(viaEth[0]).to.equal(toCoin[0]);
  });

  it('refuses a path whose middle token has no pool', async () => {
    const { first, second, quoter } = await loadFixture(twoPoolsFixture);
    const stray = await hre.viem.deployContract('MockERC20', ['Stray', 'STRAY', 18, 0n]);

    const path = encodeSwapPath([[first.address, POOL_FEE], [stray.address, POOL_FEE]], second.address);
    await expect(quoter.simulate.quoteExactInput([path, parseEther('1')])).to.be.rejected;
  });

  it('has no route between coins priced in different assets', async () => {
    const stack = await loadFixture(twoPoolsFixture);
    const { first, weth, dollar, quoter, alice } = stack;
    const inDollars = await stack.launch(alice, 'Greenback', 'BUCK', { quote: dollar.address });
    await stack.buy(inDollars, alice, usd(40_000));

    // Through ether: the dollar coin has no ether pool. Through dollars: the ether coin has none.
    // The platform opens no pool between the two assets themselves, so the page says so rather
    // than quoting a swap that cannot fill.
    for (const middle of [weth.address, dollar.address]) {
      const path = encodeSwapPath([[first.address, POOL_FEE], [middle, POOL_FEE]], inDollars.address);
      await expect(quoter.simulate.quoteExactInput([path, parseEther('1')])).to.be.rejected;
    }
  });

  it('routes across a bridge pool the owner has opened between the two quote assets', async () => {
    const stack = await loadFixture(twoPoolsFixture);
    const { first, weth, dollar, listingManager, liquidityManager, quoter, swapRouter, owner, alice, bob, publicClient } =
      stack;
    const inDollars = await stack.launch(alice, 'Greenback', 'BUCK', { quote: dollar.address });
    await stack.buy(inDollars, alice, usd(40_000));

    // The owner bridges ether and the dollar directly, at roughly three thousand to the ether —
    // the same kind of pool a coin's own graduation opens, just between two assets instead of a
    // coin and its quote.
    const wethIsToken0 = weth.address.toLowerCase() < dollar.address.toLowerCase();
    const bridgeSqrtPriceX96 = sqrtPriceX96For(parseEther('3000'), wethIsToken0, USD_DECIMALS);
    let hash = await listingManager.write.openBridgePool(
      [weth.address, dollar.address, POOL_FEE, bridgeSqrtPriceX96],
      { account: owner.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });

    // Seeded the same way any third-party liquidity here is: through `LiquidityManager`, which
    // never cared whether a pool came from graduation or from this — it only ever asks the
    // factory for the pair.
    await stack.approveAll(owner, [weth.address, dollar.address], liquidityManager.address);
    const [lower, upper] = await liquidityManager.read.fullRange([weth.address, dollar.address, POOL_FEE]);
    const dollarsIn = usd(300_000);
    const [, , wethNeeded] = await liquidityManager.read.quoteAdd([
      weth.address,
      dollar.address,
      POOL_FEE,
      lower,
      upper,
      dollarsIn,
      maxUint256,
    ]);
    hash = await liquidityManager.write.addLiquidity(
      [
        {
          token: weth.address,
          quote: dollar.address,
          fee: POOL_FEE,
          tickLower: lower,
          tickUpper: upper,
          quoteDesired: dollarsIn,
          tokenDesired: (wethNeeded * 101n) / 100n,
          quoteMin: 0n,
          tokenMin: 0n,
          deadline: DEADLINE,
        },
      ],
      { account: owner.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });

    // Bob holds the ether coin and wants the dollar coin. Three hops: the ether coin's own pool,
    // the bridge, the dollar coin's own pool.
    hash = await first.write.transfer(
      [bob.account.address, (await first.read.balanceOf([alice.account.address])) / 4n],
      { account: alice.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });
    hash = await first.write.approve([swapRouter.address, maxUint256], { account: bob.account });
    await publicClient.waitForTransactionReceipt({ hash });

    const amountIn = (await first.read.balanceOf([bob.account.address])) / 20n;
    const path = encodeSwapPath(
      [
        [first.address, POOL_FEE],
        [weth.address, POOL_FEE],
        [dollar.address, POOL_FEE],
      ],
      inDollars.address
    );
    const { result: quoted } = await quoter.simulate.quoteExactInput([path, amountIn]);
    expect(quoted[0] > 0n, 'the quoter found no route').to.equal(true);

    const before = await inDollars.read.balanceOf([bob.account.address]);
    hash = await swapRouter.write.exactInput(
      [
        {
          path,
          recipient: bob.account.address,
          deadline: DEADLINE,
          amountIn,
          amountOutMinimum: (quoted[0] * 99n) / 100n,
        },
      ],
      { account: bob.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });

    const received = (await inDollars.read.balanceOf([bob.account.address])) - before;
    expect(received).to.equal(quoted[0]);
    expect(received > 0n, 'nothing arrived').to.equal(true);
  });
});
