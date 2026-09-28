import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { maxUint256, parseEther, zeroAddress, type Address } from 'viem';
import { POOL_FEE, deployLaunchpad, ppm, usd } from './helpers/launchpad';

const DEADLINE = 4_102_444_800n; // 2100-01-01

/**
 * Third-party liquidity in a graduated coin's pool.
 *
 * The pools are ordinary Uniswap V3 pools, so anyone who can answer the mint callback can put
 * liquidity in. Until this contract nothing on the platform could. What has to hold: deposits
 * are the depositor's and come back in full, the protocol's own graduation position stays put,
 * and two providers sharing one range each get the fees their own liquidity earned. A pool is
 * a pair, not a coin: the same contract serves a coin against ether and a coin against a dollar.
 */
describe('LiquidityManager', () => {
  async function graduatedFixture() {
    const stack = await deployLaunchpad();
    const coin = await stack.launch(stack.alice, 'Front Page Pepe', 'PEPE');
    await stack.buy(coin, stack.alice, parseEther('10'));

    const { liquidityManager, weth } = stack;
    const pool = await stack.listingManager.read.poolOf([coin.address]);
    const poolContract = await hre.viem.getContractAt('UniswapV3Pool', pool);

    // Alice holds every coin the curve sold; give the other two a quarter of it each, which is
    // several ETH worth of the coin side at the price the pool opened at.
    const aliceHolding = await coin.read.balanceOf([stack.alice.account.address]);
    for (const wallet of [stack.bob, stack.carol]) {
      const hash = await coin.write.transfer([wallet.account.address, aliceHolding / 4n], {
        account: stack.alice.account,
      });
      await stack.publicClient.waitForTransactionReceipt({ hash });
      await stack.approveAll(wallet, [coin.address, weth.address], liquidityManager.address);
    }

    const [lower, upper] = await liquidityManager.read.fullRange([coin.address, weth.address, POOL_FEE]);
    return { ...stack, coin, quote: weth.address as Address, pool, poolContract, lower, upper };
  }

  /** Adds `eth` of liquidity over the full range for `wallet`, and waits for it. */
  async function add(
    fixture: Awaited<ReturnType<typeof graduatedFixture>>,
    wallet: Awaited<ReturnType<typeof deployLaunchpad>>['bob'],
    eth: bigint
  ) {
    const { coin, quote, liquidityManager, lower, upper, publicClient } = fixture;
    const [, , coinNeeded] = await liquidityManager.read.quoteAdd([
      coin.address,
      quote,
      POOL_FEE,
      lower,
      upper,
      eth,
      maxUint256,
    ]);
    const hash = await liquidityManager.write.addLiquidity(
      [
        {
          token: coin.address,
          quote,
          fee: POOL_FEE,
          tickLower: lower,
          tickUpper: upper,
          quoteDesired: eth,
          // A percent over what the quote asks for, so a price move between quote and mint
          // does not fail the transaction. The unused part is never taken.
          tokenDesired: (coinNeeded * 101n) / 100n,
          quoteMin: 0n,
          tokenMin: 0n,
          deadline: DEADLINE,
        },
      ],
      { account: wallet.account }
    );
    return publicClient.waitForTransactionReceipt({ hash });
  }

  it('refuses coins that have not graduated, and ranges the pool would not take', async () => {
    const stack = await deployLaunchpad();
    const onCurve = await stack.launch(stack.alice, 'Still Curving', 'CURVE');

    await expect(
      stack.liquidityManager.read.fullRange([onCurve.address, stack.weth.address, POOL_FEE])
    ).to.be.rejectedWith('NoPool');

    const { coin, quote, lower, upper, ...rest } = await loadFixture(graduatedFixture);
    // Tick spacing is 200 in the 1% tier, so 201 is not a tick this pool has.
    await expect(
      rest.liquidityManager.read.quoteAdd([coin.address, quote, POOL_FEE, 201, upper, parseEther('1'), maxUint256])
    ).to.be.rejectedWith('BadRange');
    await expect(
      rest.liquidityManager.read.quoteAdd([coin.address, quote, POOL_FEE, upper, lower, parseEther('1'), maxUint256])
    ).to.be.rejectedWith('BadRange');
  });

  it('puts a deposit into the pool and lists it as the depositors own', async () => {
    const fixture = await loadFixture(graduatedFixture);
    const { coin, quote, liquidityManager, poolContract, weth, pool, bob, lower, upper } = fixture;

    const poolEthBefore = await weth.read.balanceOf([pool]);
    const liquidityBefore = await poolContract.read.liquidity();
    const coinsBefore = await coin.read.balanceOf([bob.account.address]);

    await add(fixture, bob, parseEther('1'));

    // The ETH really went into the pool, and the pool really got deeper.
    expect(ppm(await weth.read.balanceOf([pool]), poolEthBefore + parseEther('1')) < 100n).to.equal(true);
    expect((await poolContract.read.liquidity()) > liquidityBefore).to.equal(true);
    expect(await coin.read.balanceOf([bob.account.address]) < coinsBefore).to.equal(true);

    const positions = await liquidityManager.read.positionsOf([bob.account.address]);
    expect(positions.length).to.equal(1);
    expect(positions[0]!.token.toLowerCase()).to.equal(coin.address.toLowerCase());
    expect(positions[0]!.quote.toLowerCase()).to.equal(quote.toLowerCase());
    expect(positions[0]!.tickLower).to.equal(lower);
    expect(positions[0]!.tickUpper).to.equal(upper);
    expect(positions[0]!.liquidity > 0n).to.equal(true);

    // Nothing is parked in the manager between calls.
    expect(await weth.read.balanceOf([liquidityManager.address])).to.equal(0n);
    expect(await coin.read.balanceOf([liquidityManager.address])).to.equal(0n);
  });

  it('takes only what the position uses, whatever was offered', async () => {
    const fixture = await loadFixture(graduatedFixture);
    const { coin, quote, liquidityManager, weth, bob, lower, upper, publicClient } = fixture;

    // Offer 2 ETH but only enough coins for about half of it: the position is sized by the
    // shorter side, and the rest of the ETH never leaves the wallet.
    const [, , coinForOne] = await liquidityManager.read.quoteAdd([
      coin.address,
      quote,
      POOL_FEE,
      lower,
      upper,
      parseEther('1'),
      maxUint256,
    ]);
    const before = await weth.read.balanceOf([bob.account.address]);
    const hash = await liquidityManager.write.addLiquidity(
      [
        {
          token: coin.address,
          quote,
          fee: POOL_FEE,
          tickLower: lower,
          tickUpper: upper,
          quoteDesired: parseEther('2'),
          tokenDesired: coinForOne,
          quoteMin: 0n,
          tokenMin: 0n,
          deadline: DEADLINE,
        },
      ],
      { account: bob.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });
    const spent = before - (await weth.read.balanceOf([bob.account.address]));

    // About one ETH of the two was used.
    expect(ppm(spent, parseEther('1')) < 10_000n, `spent ${spent}`).to.equal(true);
    expect(await weth.read.balanceOf([liquidityManager.address])).to.equal(0n);
  });

  it('gives a deposit back, on both sides, and forgets the emptied position', async () => {
    const fixture = await loadFixture(graduatedFixture);
    const { coin, quote, liquidityManager, bob, lower, upper, publicClient, weth } = fixture;

    await add(fixture, bob, parseEther('1'));
    const [position] = await liquidityManager.read.positionsOf([bob.account.address]);
    const coinsBefore = await coin.read.balanceOf([bob.account.address]);
    const ethBefore = await weth.read.balanceOf([bob.account.address]);

    const hash = await liquidityManager.write.removeLiquidity(
      [
        {
          token: coin.address,
          quote,
          fee: POOL_FEE,
          tickLower: lower,
          tickUpper: upper,
          liquidity: position!.liquidity,
          quoteMin: 0n,
          tokenMin: 0n,
          deadline: DEADLINE,
        },
      ],
      { account: bob.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });
    const returned = (await weth.read.balanceOf([bob.account.address])) - ethBefore;

    // Within a wei or two of the ETH that went in, and the coins come back too.
    expect(ppm(returned, parseEther('1')) < 100n, `returned ${returned}`).to.equal(true);
    expect(await coin.read.balanceOf([bob.account.address]) > coinsBefore).to.equal(true);
    expect(await liquidityManager.read.positionsOf([bob.account.address])).to.deep.equal([]);
    expect(await weth.read.balanceOf([liquidityManager.address])).to.equal(0n);
  });

  it('splits fees between two providers in the same range by what each provided', async () => {
    const fixture = await loadFixture(graduatedFixture);
    const { coin, quote, liquidityManager, swapRouter, weth, alice, bob, carol, lower, upper, publicClient } =
      fixture;

    // Bob puts in three times what Carol does, into the same full-range band.
    await add(fixture, bob, parseEther('1.5'));
    await add(fixture, carol, parseEther('0.5'));

    // Trade back and forth so the pool earns its 1% both ways.
    let hash = await coin.write.approve([swapRouter.address, maxUint256], { account: alice.account });
    await publicClient.waitForTransactionReceipt({ hash });
    for (let round = 0; round < 3; round += 1) {
      hash = await swapRouter.write.exactInputSingle(
        [
          {
            tokenIn: weth.address,
            tokenOut: coin.address,
            fee: POOL_FEE,
            recipient: alice.account.address,
            deadline: DEADLINE,
            amountIn: parseEther('2'),
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: 0n,
          },
        ],
        { value: parseEther('2'), account: alice.account }
      );
      await publicClient.waitForTransactionReceipt({ hash });
      hash = await swapRouter.write.exactInputSingle(
        [
          {
            tokenIn: coin.address,
            tokenOut: weth.address,
            fee: POOL_FEE,
            recipient: alice.account.address,
            deadline: DEADLINE,
            amountIn: await coin.read.balanceOf([alice.account.address]),
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: 0n,
          },
        ],
        { account: alice.account }
      );
      await publicClient.waitForTransactionReceipt({ hash });
    }

    const [bobPosition] = await liquidityManager.read.positionsOf([bob.account.address]);
    const [carolPosition] = await liquidityManager.read.positionsOf([carol.account.address]);
    const bobId = await liquidityManager.read.positionId([bob.account.address, coin.address, quote, POOL_FEE, lower, upper]);
    const carolId = await liquidityManager.read.positionId([carol.account.address, coin.address, quote, POOL_FEE, lower, upper]);
    const [, , bobEthFees, bobCoinFees] = await liquidityManager.read.positionValue([bobId]);
    const [, , carolEthFees, carolCoinFees] = await liquidityManager.read.positionValue([carolId]);

    // Both earned something, and the split follows the liquidity ratio, not the arrival order.
    expect(bobEthFees > 0n && carolEthFees > 0n).to.equal(true);
    const liquidityRatio = (bobPosition!.liquidity * 1_000_000n) / carolPosition!.liquidity;
    expect(ppm((bobEthFees * 1_000_000n) / carolEthFees, liquidityRatio) < 1_000n).to.equal(true);
    expect(ppm((bobCoinFees * 1_000_000n) / carolCoinFees, liquidityRatio) < 1_000n).to.equal(true);

    // And collecting pays out what the view promised.
    const before = await weth.read.balanceOf([carol.account.address]);
    hash = await liquidityManager.write.collect([coin.address, quote, POOL_FEE, lower, upper], {
      account: carol.account,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    const paid = (await weth.read.balanceOf([carol.account.address])) - before;
    expect(ppm(paid, carolEthFees) < 1_000n, `paid ${paid} vs quoted ${carolEthFees}`).to.equal(true);

    // Collecting fees leaves the liquidity where it is.
    const [after] = await liquidityManager.read.positionsOf([carol.account.address]);
    expect(after!.liquidity).to.equal(carolPosition!.liquidity);
  });

  it('leaves the protocol own graduation liquidity untouchable', async () => {
    const fixture = await loadFixture(graduatedFixture);
    const { coin, quote, liquidityManager, listingManager, poolContract, bob, lower, upper } = fixture;

    // The graduation position belongs to the listing manager, so the manager's own share of
    // that range is zero and there is nothing for a stranger to withdraw.
    await expect(
      liquidityManager.write.removeLiquidity(
        [
          {
            token: coin.address,
            quote,
            fee: POOL_FEE,
            tickLower: lower,
            tickUpper: upper,
            liquidity: 1n,
            quoteMin: 0n,
            tokenMin: 0n,
            deadline: DEADLINE,
          },
        ],
        { account: bob.account }
      )
    ).to.be.rejectedWith('NoPosition');

    const before = await poolContract.read.liquidity();
    await add(fixture, bob, parseEther('1'));
    const [position] = await liquidityManager.read.positionsOf([bob.account.address]);
    await liquidityManager.write.removeLiquidity(
      [
        {
          token: coin.address,
          quote,
          fee: POOL_FEE,
          tickLower: lower,
          tickUpper: upper,
          liquidity: position!.liquidity,
          quoteMin: 0n,
          tokenMin: 0n,
          deadline: DEADLINE,
        },
      ],
      { account: bob.account }
    );
    // The pool is back to exactly the liquidity the listing manager locked in it.
    expect(await poolContract.read.liquidity()).to.equal(before);
    expect(await listingManager.read.poolOf([coin.address])).to.not.equal(zeroAddress);
  });

  it('refuses a stale deadline, a range it was not asked about, and a direct callback', async () => {
    const fixture = await loadFixture(graduatedFixture);
    const { coin, quote, liquidityManager, bob, lower, upper } = fixture;

    await expect(
      liquidityManager.write.addLiquidity(
        [
          {
            token: coin.address,
            quote,
            fee: POOL_FEE,
            tickLower: lower,
            tickUpper: upper,
            quoteDesired: parseEther('1'),
            tokenDesired: parseEther('1000'),
            quoteMin: 0n,
            tokenMin: 0n,
            deadline: 1n,
          },
        ],
        { account: bob.account }
      )
    ).to.be.rejectedWith('DeadlinePassed');

    await expect(
      liquidityManager.write.collect([coin.address, quote, POOL_FEE, lower, upper], { account: bob.account })
    ).to.be.rejectedWith('NoPosition');

    // Only a pool this platform opened can ask to be paid.
    await expect(
      liquidityManager.write.uniswapV3MintCallback(
        [1n, 1n, `0x${'00'.repeat(0)}` as `0x${string}`],
        { account: bob.account }
      )
    ).to.be.rejected;
  });

  /**
   * Both token orderings, because the rounding differs between them.
   *
   * A pool sorts its pair by address, so whether the quote is token0 or token1 is decided by
   * where the coin's CREATE2 address happens to fall. The liquidity formula floors and the pool
   * charges by rounding up, and on the token0 side those are not exact inverses — so the
   * ordering where the quote is token0 is the one that can ask for a unit more than was offered.
   * Coin addresses come from the symbol, so a symbol can be picked to put the coin on either side.
   */
  it('adds and withdraws whichever side of the pair the quote lands on', async () => {
    for (const quoteIsToken0 of [false, true]) {
      const stack = await deployLaunchpad();
      const { liquidityManager, weth } = stack;

      // Walk symbols until the coin's address falls on the side this run wants.
      let symbol = '';
      for (let index = 0; index < 64; index += 1) {
        const candidate = `SIDE${index}`;
        const address = await stack.coinFactory.read.getAddress([candidate]);
        if (address.toLowerCase() > weth.address.toLowerCase() === quoteIsToken0) {
          symbol = candidate;
          break;
        }
      }
      expect(symbol, `no symbol put the coin on the ${quoteIsToken0 ? 'token1' : 'token0'} side`).to.not.equal('');

      const coin = await stack.launch(stack.alice, symbol, symbol);
      await stack.buy(coin, stack.alice, parseEther('10'));

      const hash = await coin.write.transfer(
        [stack.bob.account.address, (await coin.read.balanceOf([stack.alice.account.address])) / 4n],
        { account: stack.alice.account }
      );
      await stack.publicClient.waitForTransactionReceipt({ hash });
      await stack.approveAll(stack.bob, [coin.address, weth.address], liquidityManager.address);

      const [lower, upper] = await liquidityManager.read.fullRange([coin.address, weth.address, POOL_FEE]);
      const [, ethNeeded, coinNeeded] = await liquidityManager.read.quoteAdd([
        coin.address,
        weth.address,
        POOL_FEE,
        lower,
        upper,
        parseEther('1'),
        maxUint256,
      ]);
      // Exactly what the quote asked for, with no headroom: the contract must not need more
      // than it quoted, on either side.
      const addHash = await liquidityManager.write.addLiquidity(
        [
          {
            token: coin.address,
            quote: weth.address,
            fee: POOL_FEE,
            tickLower: lower,
            tickUpper: upper,
            quoteDesired: ethNeeded,
            tokenDesired: coinNeeded,
            quoteMin: 0n,
            tokenMin: 0n,
            deadline: DEADLINE,
          },
        ],
        { account: stack.bob.account }
      );
      await stack.publicClient.waitForTransactionReceipt({ hash: addHash });

      const [position] = await liquidityManager.read.positionsOf([stack.bob.account.address]);
      expect(position!.liquidity > 0n, `nothing minted with the quote as token${quoteIsToken0 ? 0 : 1}`).to.equal(true);

      const before = await weth.read.balanceOf([stack.bob.account.address]);
      const removeHash = await liquidityManager.write.removeLiquidity(
        [
          {
            token: coin.address,
            quote: weth.address,
            fee: POOL_FEE,
            tickLower: lower,
            tickUpper: upper,
            liquidity: position!.liquidity,
            quoteMin: 0n,
            tokenMin: 0n,
            deadline: DEADLINE,
          },
        ],
        { account: stack.bob.account }
      );
      await stack.publicClient.waitForTransactionReceipt({ hash: removeHash });
      const returned = (await weth.read.balanceOf([stack.bob.account.address])) - before;
      expect(ppm(returned, parseEther('1')) < 100n, `returned ${returned}`).to.equal(true);
      expect(await liquidityManager.read.positionsOf([stack.bob.account.address])).to.deep.equal([]);
    }
  });

  it('quotes from whichever side you constrain', async () => {
    const fixture = await loadFixture(graduatedFixture);
    const { coin, quote, liquidityManager, lower, upper } = fixture;

    const [, ethFromEth, coinFromEth] = await liquidityManager.read.quoteAdd([
      coin.address,
      quote,
      POOL_FEE,
      lower,
      upper,
      parseEther('1'),
      maxUint256,
    ]);
    // Feed the coin figure back in as the constraint and the ETH figure has to come back out.
    const [, ethFromCoin, coinFromCoin] = await liquidityManager.read.quoteAdd([
      coin.address,
      quote,
      POOL_FEE,
      lower,
      upper,
      maxUint256,
      coinFromEth,
    ]);

    expect(ppm(ethFromCoin, ethFromEth) < 100n, `${ethFromCoin} vs ${ethFromEth}`).to.equal(true);
    expect(ppm(coinFromCoin, coinFromEth) < 100n).to.equal(true);
  });

  /**
   * Concentrated ranges, which is what a range picker is for.
   *
   * A band that straddles the price takes both tokens; one wholly to one side of it takes only
   * the token that side is priced in. All three have to mint, and all three have to come back.
   */
  it('takes a band around the price and one on either side of it', async () => {
    const fixture = await loadFixture(graduatedFixture);
    const { coin, quote, liquidityManager, poolContract, bob, publicClient } = fixture;

    const [, tick] = await poolContract.read.slot0();
    const spacing = await poolContract.read.tickSpacing();
    const base = Math.floor(tick / spacing) * spacing;

    const bands: [string, number, number][] = [
      ['around the price', base - spacing * 10, base + spacing * 10],
      ['above the price', base + spacing * 2, base + spacing * 20],
      ['below the price', base - spacing * 20, base - spacing * 2],
    ];

    for (const [what, tickLower, tickUpper] of bands) {
      // Which box the page would offer: a band the price has not reached takes only one token,
      // and sizing it by the other has no answer.
      const [needsEth, needsCoin] = await liquidityManager.read.rangeNeeds([
        coin.address,
        quote,
        POOL_FEE,
        tickLower,
        tickUpper,
      ]);
      expect(needsEth || needsCoin, `${what} takes neither token`).to.equal(true);
      if (!needsEth) {
        await expect(
          liquidityManager.read.quoteAdd([coin.address, quote, POOL_FEE, tickLower, tickUpper, parseEther('0.5'), maxUint256])
        ).to.be.rejectedWith('RangeDoesNotTake');
      }

      const coinsHeld = await coin.read.balanceOf([bob.account.address]);
      const [, ethNeeded, coinNeeded] = await liquidityManager.read.quoteAdd([
        coin.address,
        quote,
        POOL_FEE,
        tickLower,
        tickUpper,
        needsEth ? parseEther('0.5') : maxUint256,
        needsEth ? maxUint256 : coinsHeld / 100n,
      ]);

      let hash = await liquidityManager.write.addLiquidity(
        [
          {
            token: coin.address,
            quote,
            fee: POOL_FEE,
            tickLower,
            tickUpper,
            quoteDesired: ethNeeded,
            tokenDesired: (coinNeeded * 101n) / 100n,
            quoteMin: 0n,
            tokenMin: 0n,
            deadline: DEADLINE,
          },
        ],
        { account: bob.account }
      );
      await publicClient.waitForTransactionReceipt({ hash });

      const position = (await liquidityManager.read.positionsOf([bob.account.address])).find(
        (entry) => entry.tickLower === tickLower && entry.tickUpper === tickUpper
      );
      expect(position, `nothing minted ${what}`).to.not.equal(undefined);
      expect(position!.liquidity > 0n, `no liquidity ${what}`).to.equal(true);

      // What rangeNeeds promised is what the quote charges.
      expect(ethNeeded > 0n, `${what}: eth`).to.equal(needsEth);
      expect(coinNeeded > 0n, `${what}: coin`).to.equal(needsCoin);

      hash = await liquidityManager.write.removeLiquidity(
        [
          {
            token: coin.address,
            quote,
            fee: POOL_FEE,
            tickLower,
            tickUpper,
            liquidity: position!.liquidity,
            quoteMin: 0n,
            tokenMin: 0n,
            deadline: DEADLINE,
          },
        ],
        { account: bob.account }
      );
      await publicClient.waitForTransactionReceipt({ hash });
    }

    expect(await liquidityManager.read.positionsOf([bob.account.address])).to.deep.equal([]);
  });

  /**
   * A pool the launchpad's own registry has never heard of.
   *
   * `CoinListingManager.poolOf` only knows about coins that graduated. OUTBID's pool is created
   * straight on the factory and is invisible to it, and gating liquidity on `poolOf` would have
   * made that pool — the one the buyback trades in — the single pool nobody could provide to.
   * Finding pools on the factory instead covers it, and is no less bounded: the factory still
   * only lets its owner create them.
   */
  it('reaches a pool the listing manager does not know about', async () => {
    const stack = await loadFixture(graduatedFixture);
    const { owner, bob, weth, v3Factory, listingManager, liquidityManager, publicClient } = stack;

    const other = await hre.viem.deployContract('MockERC20', ['Off Registry', 'OFF', 18, parseEther('1000000')]);

    // How such a pool comes to exist: the owner takes the factory back, opens it, hands it over.
    let hash = await listingManager.write.setFactoryOwner([owner.account.address], { account: owner.account });
    await publicClient.waitForTransactionReceipt({ hash });
    hash = await v3Factory.write.createPool([other.address, weth.address, POOL_FEE], { account: owner.account });
    await publicClient.waitForTransactionReceipt({ hash });
    hash = await v3Factory.write.setOwner([listingManager.address], { account: owner.account });
    await publicClient.waitForTransactionReceipt({ hash });

    const poolAddress = await v3Factory.read.getPool([other.address, weth.address, POOL_FEE]);
    const pool = await hre.viem.getContractAt('UniswapV3Pool', poolAddress);
    // One WETH per whole token, which is sqrt(1) << 96.
    hash = await pool.write.initialize([79228162514264337593543950336n], { account: owner.account });
    await publicClient.waitForTransactionReceipt({ hash });

    // The launchpad's registry does not know this pool, and the manager reaches it anyway.
    expect(await listingManager.read.poolOf([other.address])).to.equal(zeroAddress);

    hash = await other.write.transfer([bob.account.address, parseEther('1000')], { account: owner.account });
    await publicClient.waitForTransactionReceipt({ hash });
    await stack.approveAll(bob, [other.address], liquidityManager.address);

    const [lower, upper] = await liquidityManager.read.fullRange([other.address, weth.address, POOL_FEE]);
    const [, , tokenNeeded] = await liquidityManager.read.quoteAdd([
      other.address,
      weth.address,
      POOL_FEE,
      lower,
      upper,
      parseEther('1'),
      maxUint256,
    ]);

    hash = await liquidityManager.write.addLiquidity(
      [
        {
          token: other.address,
          quote: weth.address,
          fee: POOL_FEE,
          tickLower: lower,
          tickUpper: upper,
          quoteDesired: parseEther('1'),
          tokenDesired: (tokenNeeded * 101n) / 100n,
          quoteMin: 0n,
          tokenMin: 0n,
          deadline: DEADLINE,
        },
      ],
      { account: bob.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });

    const [position] = await liquidityManager.read.positionsOf([bob.account.address]);
    expect(position!.token.toLowerCase()).to.equal(other.address.toLowerCase());
    expect(position!.fee).to.equal(POOL_FEE);
    expect(ppm(await weth.read.balanceOf([poolAddress]), parseEther('1')) < 1000n).to.equal(true);

    // And it comes back out the same way.
    hash = await liquidityManager.write.removeLiquidity(
      [
        {
          token: other.address,
          quote: weth.address,
          fee: POOL_FEE,
          tickLower: lower,
          tickUpper: upper,
          liquidity: position!.liquidity,
          quoteMin: 0n,
          tokenMin: 0n,
          deadline: DEADLINE,
        },
      ],
      { account: bob.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });
    expect(await liquidityManager.read.positionsOf([bob.account.address])).to.deep.equal([]);
  });

  it('provides to a pool priced in dollars', async () => {
    const stack = await deployLaunchpad();
    const { launch, buy, dollar, alice, bob, liquidityManager, listingManager, publicClient } = stack;
    const coin = await launch(alice, 'Greenback', 'BUCK', { quote: dollar.address });
    await buy(coin, alice, usd(40_000));
    const pool = await listingManager.read.poolOf([coin.address]);

    let hash = await coin.write.transfer(
      [bob.account.address, (await coin.read.balanceOf([alice.account.address])) / 4n],
      { account: alice.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });
    await stack.approveAll(bob, [coin.address, dollar.address], liquidityManager.address);

    const [lower, upper] = await liquidityManager.read.fullRange([coin.address, dollar.address, POOL_FEE]);
    const [, dollarsNeeded, coinNeeded] = await liquidityManager.read.quoteAdd([
      coin.address,
      dollar.address,
      POOL_FEE,
      lower,
      upper,
      usd(1_000),
      maxUint256,
    ]);
    expect(dollarsNeeded > 0n && dollarsNeeded <= usd(1_000)).to.equal(true);

    const poolBefore = await dollar.read.balanceOf([pool]);
    hash = await liquidityManager.write.addLiquidity(
      [
        {
          token: coin.address,
          quote: dollar.address,
          fee: POOL_FEE,
          tickLower: lower,
          tickUpper: upper,
          quoteDesired: usd(1_000),
          tokenDesired: (coinNeeded * 101n) / 100n,
          quoteMin: 0n,
          tokenMin: 0n,
          deadline: DEADLINE,
        },
      ],
      { account: bob.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });
    expect(ppm((await dollar.read.balanceOf([pool])) - poolBefore, usd(1_000)) < 100n).to.equal(true);

    const id = await liquidityManager.read.positionId([bob.account.address, coin.address, dollar.address, POOL_FEE, lower, upper]);
    const [dollarsHeld] = await liquidityManager.read.positionValue([id]);
    expect(ppm(dollarsHeld, usd(1_000)) < 100n, `${dollarsHeld}`).to.equal(true);

    const [position] = await liquidityManager.read.positionsOf([bob.account.address]);
    const before = await dollar.read.balanceOf([bob.account.address]);
    hash = await liquidityManager.write.removeLiquidity(
      [
        {
          token: coin.address,
          quote: dollar.address,
          fee: POOL_FEE,
          tickLower: lower,
          tickUpper: upper,
          liquidity: position!.liquidity,
          quoteMin: 0n,
          tokenMin: 0n,
          deadline: DEADLINE,
        },
      ],
      { account: bob.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });
    expect(ppm((await dollar.read.balanceOf([bob.account.address])) - before, usd(1_000)) < 100n).to.equal(true);
  });

  it('refuses a pair with no pool on this factory', async () => {
    const { liquidityManager, weth } = await loadFixture(graduatedFixture);
    const stray = await hre.viem.deployContract('MockERC20', ['Stray', 'STRAY', 18, 0n]);

    await expect(
      liquidityManager.read.fullRange([stray.address, weth.address, POOL_FEE])
    ).to.be.rejectedWith('NoPool');
    await expect(
      liquidityManager.read.fullRange([weth.address, weth.address, POOL_FEE])
    ).to.be.rejectedWith('NoPool');
  });

  it('holds a depositor to the minimum they asked for', async () => {
    const fixture = await loadFixture(graduatedFixture);
    const { coin, quote, liquidityManager, bob, lower, upper } = fixture;
    const [, , coinNeeded] = await liquidityManager.read.quoteAdd([
      coin.address,
      quote,
      POOL_FEE,
      lower,
      upper,
      parseEther('1'),
      maxUint256,
    ]);

    await expect(
      liquidityManager.write.addLiquidity(
        [
          {
            token: coin.address,
            quote,
            fee: POOL_FEE,
            tickLower: lower,
            tickUpper: upper,
            quoteDesired: parseEther('1'),
            tokenDesired: coinNeeded,
            quoteMin: parseEther('2'), // more than was offered, so it cannot be met
            tokenMin: 0n,
            deadline: DEADLINE,
          },
        ],
        { account: bob.account }
      )
    ).to.be.rejectedWith('TooLittleReceived');
  });
});
