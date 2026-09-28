import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { getAddress, parseEther, zeroAddress, type Address } from 'viem';
import { BPS, FEE_BPS, PROTOCOL_SHARE_BPS, POOL_FEE, SUPPLY_AT_CAP, deployLaunchpad, usd } from './helpers/launchpad';

const DEAD = '0x000000000000000000000000000000000000dEaD' as Address;
const DEADLINE = 4_102_444_800n; // 2100-01-01
const REWARD_BPS = 300n;

/** Equal to within `tolerance` wei: sharing a reward pro rata rounds each holder's part down. */
function near(actual: bigint, expected: bigint, tolerance = 10n) {
  const gap = actual > expected ? actual - expected : expected - actual;
  expect(gap <= tolerance, `${actual} is not within ${tolerance} of ${expected}`).to.equal(true);
}

/**
 * Reward coins (Coin + HolderRewards): a share of every transfer, in the coin, for the holders;
 * optionally every creator fee too, in the asset the coin is priced in. Standard coins carry
 * neither. And the launch rules around them: the opening buy's 75% ceiling.
 */
describe('Reward coins', () => {
  async function rewardFixture() {
    const stack = await deployLaunchpad();
    const coin = await stack.launch(stack.alice, 'Dividend Dog', 'DIVI', {
      quote: stack.dollar.address,
      rewardFeeBps: Number(REWARD_BPS),
    });
    const distributor = await hre.viem.getContractAt('HolderRewards', await coin.read.rewardDistributor());
    return { ...stack, coin, distributor };
  }

  async function sharingFixture() {
    const stack = await deployLaunchpad();
    const coin = await stack.launch(stack.alice, 'Shared Shiba', 'SHARE', {
      quote: stack.dollar.address,
      rewardFeeBps: Number(REWARD_BPS),
      shareFeesWithHolders: true,
      creatorTaxBps: 200,
    });
    const distributor = await hre.viem.getContractAt('HolderRewards', await coin.read.rewardDistributor());
    return { ...stack, coin, distributor };
  }

  /** Every holder's counted shares match their balance, and the total matches the sum. */
  async function expectSharesMatchBalances(
    coin: Awaited<ReturnType<typeof rewardFixture>>['coin'],
    distributor: Awaited<ReturnType<typeof rewardFixture>>['distributor'],
    holders: Address[]
  ) {
    let sum = 0n;
    for (const holder of holders) {
      const shares = await distributor.read.sharesOf([holder]);
      expect(shares).to.equal(await coin.read.balanceOf([holder]));
      sum += shares;
    }
    expect(await distributor.read.totalShares()).to.equal(sum);
  }

  describe('launching', () => {
    it('launches a standard coin with no distributor and no transfer fee', async () => {
      const { launch, buy, alice, bob, carol, dollar, publicClient } = await deployLaunchpad();
      const coin = await launch(alice, 'Plain Pepe', 'PLAIN', { quote: dollar.address });
      expect(await coin.read.rewardDistributor()).to.equal(zeroAddress);
      expect(await coin.read.rewardFeeBps()).to.equal(0);
      await buy(coin, bob, usd(500));
      const held = await coin.read.balanceOf([bob.account.address]);
      const hash = await coin.write.transfer([carol.account.address, held], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      expect(await coin.read.balanceOf([carol.account.address])).to.equal(held);
    });

    it('gives each reward coin its own distributor, bound to it and the asset it is priced in', async () => {
      const { coin, distributor, launch, alice, dollar, feeEscrow } = await loadFixture(rewardFixture);
      expect(await coin.read.rewardFeeBps()).to.equal(Number(REWARD_BPS));
      expect(getAddress(await distributor.read.coin())).to.equal(getAddress(coin.address));
      expect(getAddress(await distributor.read.asset())).to.equal(getAddress(dollar.address));
      expect(getAddress(await distributor.read.feeEscrow())).to.equal(getAddress(feeEscrow.address));
      expect(await coin.read.sharesFeesWithHolders()).to.equal(false);
      expect(getAddress(await coin.read.creatorFeeRecipient())).to.equal(getAddress(alice.account.address));

      const other = await launch(alice, 'Second Dog', 'DIVI2', { quote: dollar.address, rewardFeeBps: 100 });
      expect(await other.read.rewardDistributor()).to.not.equal(distributor.address);
      // A clone is bound once: nobody can point it at another coin afterwards.
      await expect(distributor.write.initialize([other.address, dollar.address, feeEscrow.address])).to.be.rejectedWith(
        'AlreadyInitialized'
      );
    });

    it('refuses reward terms it cannot honour', async () => {
      const { launch, alice, bob, dollar } = await deployLaunchpad();
      await expect(launch(alice, 'Greedy', 'GREED', { quote: dollar.address, rewardFeeBps: 501 })).to.be.rejectedWith(
        'Reward fee too high'
      );
      await expect(
        launch(alice, 'Nothing To Share', 'NOSHARE', { quote: dollar.address, shareFeesWithHolders: true })
      ).to.be.rejectedWith('Sharing needs a reward coin');
      await expect(
        launch(alice, 'Two Masters', 'TWO', {
          quote: dollar.address,
          rewardFeeBps: 100,
          shareFeesWithHolders: true,
          creatorFeeRecipient: bob.account.address,
        })
      ).to.be.rejectedWith('Fees go to holders');
    });

    it('holds the opening buy to three quarters of what the curve sells', async () => {
      const { launch, alice, dollar } = await deployLaunchpad();
      // Three quarters of the curve costs 14,000 × 0.75^2.2 ≈ 7,436 of the cap's dollars.
      await expect(launch(alice, 'Whale Dev', 'WHALE', { quote: dollar.address, preBuy: usd(8_000) })).to.be.rejectedWith(
        'Opening buy over 75%'
      );
      const coin = await launch(alice, 'Big Dev', 'BIGDEV', { quote: dollar.address, preBuy: usd(7_000) });
      const held = await coin.read.balanceOf([alice.account.address]);
      expect(held > (SUPPLY_AT_CAP * 70n) / 100n).to.equal(true);
      expect(held <= (SUPPLY_AT_CAP * 75n) / 100n).to.equal(true);
    });
  });

  describe('the reward fee', () => {
    it('keeps its share of a curve buy for holders, and holds the buyer to their minimum on the rest', async () => {
      const { coin, distributor, buy, bob } = await loadFixture(rewardFixture);
      const payment = usd(1_000);
      const deposit = payment - (payment * FEE_BPS) / BPS;
      const gross = await coin.read.calculatePurchaseReturn([deposit]);
      const fee = (gross * REWARD_BPS) / BPS;

      await expect(buy(coin, bob, payment, gross)).to.be.rejectedWith('Insufficient output token amount');
      await buy(coin, bob, payment, gross - fee);
      expect(await coin.read.balanceOf([bob.account.address])).to.equal(gross - fee);
      expect(await coin.read.balanceOf([distributor.address])).to.equal(fee);
    });

    it('takes its share of a wallet transfer, and shares it by what each holder held', async () => {
      const { coin, distributor, buy, alice, bob, carol, publicClient } = await loadFixture(rewardFixture);
      await buy(coin, bob, usd(1_000));
      await buy(coin, carol, usd(500));
      const bobHeld = await coin.read.balanceOf([bob.account.address]);
      const carolHeld = await coin.read.balanceOf([carol.account.address]);
      // Both buys' fees arrived before Carol held anything, so they are Bob's alone.
      const earlier = await coin.read.balanceOf([distributor.address]);

      const sent = bobHeld / 2n;
      const hash = await coin.write.transfer([alice.account.address, sent], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      const fee = (sent * REWARD_BPS) / BPS;
      expect(await coin.read.balanceOf([alice.account.address])).to.equal(sent - fee);

      // The transfer's fee is shared among the holders as they stood before it.
      const [bobCoins] = await distributor.read.claimable([bob.account.address]);
      const [carolCoins] = await distributor.read.claimable([carol.account.address]);
      const [aliceCoins] = await distributor.read.claimable([alice.account.address]);
      near(bobCoins, earlier + (fee * bobHeld) / (bobHeld + carolHeld));
      near(carolCoins, (fee * carolHeld) / (bobHeld + carolHeld));
      expect(aliceCoins).to.equal(0n);
      expect(bobCoins + carolCoins <= (await coin.read.balanceOf([distributor.address]))).to.equal(true);
      await expectSharesMatchBalances(coin, distributor, [alice.account.address, bob.account.address, carol.account.address]);
    });

    it('pays a claim in coins, untaxed, and counts the claimed coins as held from then on', async () => {
      const { coin, distributor, buy, bob, carol, publicClient } = await loadFixture(rewardFixture);
      await buy(coin, bob, usd(1_000));
      await buy(coin, carol, usd(500));
      const [owed] = await distributor.read.claimable([bob.account.address]);
      expect(owed > 0n).to.equal(true);
      const before = await coin.read.balanceOf([bob.account.address]);

      const hash = await distributor.write.claim({ account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      expect((await coin.read.balanceOf([bob.account.address])) - before).to.equal(owed);
      expect((await distributor.read.claimable([bob.account.address]))[0]).to.equal(0n);
      expect(await distributor.read.withdrawn([coin.address, bob.account.address])).to.equal(owed);
      await expectSharesMatchBalances(coin, distributor, [bob.account.address, carol.account.address]);
    });

    it('takes its share of a sale in coins, and the curve buys the rest', async () => {
      const { coin, distributor, buy, sell, bob, dollar } = await loadFixture(rewardFixture);
      await buy(coin, bob, usd(2_000));
      const held = await coin.read.balanceOf([bob.account.address]);
      const amount = held / 2n;
      const fee = (amount * REWARD_BPS) / BPS;
      const gross = await coin.read.calculateSaleReturn([amount - fee]);
      const expected = gross - (gross * FEE_BPS) / BPS;
      const supplyBefore = await coin.read.totalSupply();
      const rewardsBefore = await coin.read.balanceOf([distributor.address]);
      const dollarsBefore = await dollar.read.balanceOf([bob.account.address]);

      await sell(coin, bob, amount, expected);
      expect((await dollar.read.balanceOf([bob.account.address])) - dollarsBefore).to.equal(expected);
      expect(supplyBefore - (await coin.read.totalSupply())).to.equal(amount - fee);
      expect((await coin.read.balanceOf([distributor.address])) - rewardsBefore).to.equal(fee);
      expect(await coin.read.balanceOf([bob.account.address])).to.equal(held - amount);
    });

    it('taxes coins sent through the fee escrow: it is no way round the fee', async () => {
      const { coin, distributor, buy, bob, carol, feeEscrow, publicClient } = await loadFixture(rewardFixture);
      await buy(coin, bob, usd(1_000));
      const sent = (await coin.read.balanceOf([bob.account.address])) / 2n;
      let hash = await coin.write.approve([feeEscrow.address, sent], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      const rewardsBefore = await coin.read.balanceOf([distributor.address]);
      // Credit Carol through the escrow, which anyone may do, and let her claim it.
      hash = await feeEscrow.write.credit([carol.account.address, coin.address, sent], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      hash = await feeEscrow.write.claim([coin.address], { account: carol.account });
      await publicClient.waitForTransactionReceipt({ hash });
      const fee = (sent * REWARD_BPS) / BPS;
      expect(await coin.read.balanceOf([carol.account.address])).to.equal(sent - fee);
      expect((await coin.read.balanceOf([distributor.address])) - rewardsBefore).to.equal(fee);
    });

    it('sends coins to the dead address untaxed, and counts them for nobody', async () => {
      const { coin, distributor, buy, bob, publicClient } = await loadFixture(rewardFixture);
      await buy(coin, bob, usd(1_000));
      const burned = (await coin.read.balanceOf([bob.account.address])) / 4n;
      const rewardsBefore = await coin.read.balanceOf([distributor.address]);
      const hash = await coin.write.transfer([DEAD, burned], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      expect(await coin.read.balanceOf([DEAD])).to.equal(burned);
      expect(await coin.read.balanceOf([distributor.address])).to.equal(rewardsBefore);
      expect(await distributor.read.sharesOf([DEAD])).to.equal(0n);
    });
  });

  describe('holding the ledger in range', () => {
    it('waits to share rewards until a million coins are held', async () => {
      const { distributor } = await loadFixture(rewardFixture);
      // A sliver of supply cannot take a reward: that is what keeps the per-share figure in range
      // however often coins are sent round (see HolderRewards.MIN_TOTAL_SHARES).
      expect(await distributor.read.MIN_TOTAL_SHARES()).to.equal(parseEther('1000000'));
    });

    it('graduates a reward coin that shares its fees within the graduation gas bound', async () => {
      const { coin, buy, bob, carol, publicClient } = await loadFixture(sharingFixture);
      await buy(coin, carol, usd(2_000));
      const receipt = await buy(coin, bob, usd(16_000));
      expect(await coin.read.cap()).to.equal(0n);
      expect(receipt.gasUsed < 12_000_000n, `graduation took ${receipt.gasUsed} gas`).to.equal(true);
      void publicClient;
    });
  });

  describe('sharing the creator fees', () => {
    it('pays every fee the creator would earn to the holders instead', async () => {
      const { coin, distributor, buy, alice, bob, carol, dollar, treasury, feeEscrow } = await loadFixture(sharingFixture);
      expect(await coin.read.sharesFeesWithHolders()).to.equal(true);
      expect(getAddress(await coin.read.creatorFeeRecipient())).to.equal(getAddress(distributor.address));

      const payment = usd(1_000);
      const fee = (payment * FEE_BPS) / BPS;
      const tax = (payment * 200n) / BPS;
      const toProtocol = (fee * PROTOCOL_SHARE_BPS) / BPS;
      const toHolders = fee - toProtocol + tax;
      const treasuryBefore = await dollar.read.balanceOf([treasury.address]);

      await buy(coin, bob, payment);
      expect((await dollar.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(toProtocol);
      expect(await dollar.read.balanceOf([distributor.address])).to.equal(toHolders);
      expect(await feeEscrow.read.balanceOf([alice.account.address, dollar.address])).to.equal(0n);

      // Carol's buy pays the same again before she holds anything: both go to Bob, who claims them.
      await buy(coin, carol, payment);
      const [, owed] = await distributor.read.claimable([bob.account.address]);
      near(owed, toHolders * 2n, 2n);
      const before = await dollar.read.balanceOf([bob.account.address]);
      const hash = await distributor.write.claim({ account: bob.account });
      await (await hre.viem.getPublicClient()).waitForTransactionReceipt({ hash });
      expect((await dollar.read.balanceOf([bob.account.address])) - before).to.equal(owed);
    });

    it('cannot be taken back: nobody can move the creator fees away from the holders', async () => {
      const { coin, alice } = await loadFixture(sharingFixture);
      await expect(coin.write.setCreatorFeeRecipient([alice.account.address], { account: alice.account })).to.be.rejectedWith(
        'Not the fee recipient'
      );
    });
  });

  describe('after graduation', () => {
    async function graduatedFixture() {
      const stack = await sharingFixture();
      const { coin, buy, bob, carol } = stack;
      await buy(coin, carol, usd(2_000));
      // A 14,000 cap; after the fees a 16,000 buy crosses it with change to spare.
      await buy(coin, bob, usd(16_000));
      return stack;
    }

    it('counts the pool for nobody, and lets a sale into it through untaxed', async () => {
      const { coin, distributor, listingManager, swapRouter, dollar, bob, carol, publicClient } =
        await loadFixture(graduatedFixture);
      expect(await coin.read.cap()).to.equal(0n);
      const pool = await listingManager.read.poolOf([coin.address]);
      expect(getAddress(await coin.read.pool())).to.equal(getAddress(pool));
      expect(await distributor.read.sharesOf([pool])).to.equal(0n);
      await expectSharesMatchBalances(coin, distributor, [bob.account.address, carol.account.address]);

      // A Uniswap V3 pool rejects a payment that arrives short, so this only fills because the
      // coins reach the pool whole.
      const amountIn = (await coin.read.balanceOf([bob.account.address])) / 10n;
      let hash = await coin.write.approve([swapRouter.address, amountIn], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      const rewardsBefore = await coin.read.balanceOf([distributor.address]);
      const poolBefore = await coin.read.balanceOf([pool]);
      const dollarsBefore = await dollar.read.balanceOf([bob.account.address]);
      hash = await swapRouter.write.exactInputSingle(
        [
          {
            tokenIn: coin.address,
            tokenOut: dollar.address,
            fee: POOL_FEE,
            recipient: bob.account.address,
            deadline: DEADLINE,
            amountIn,
            amountOutMinimum: 1n,
            sqrtPriceLimitX96: 0n,
          },
        ],
        { account: bob.account }
      );
      await publicClient.waitForTransactionReceipt({ hash });
      expect((await coin.read.balanceOf([pool])) - poolBefore).to.equal(amountIn);
      expect(await coin.read.balanceOf([distributor.address])).to.equal(rewardsBefore);
      expect((await dollar.read.balanceOf([bob.account.address])) > dollarsBefore).to.equal(true);
      expect(await distributor.read.sharesOf([pool])).to.equal(0n);
    });

    it('takes the reward fee from a buy out of the pool', async () => {
      const { coin, distributor, swapRouter, quoter, dollar, owner, publicClient } = await loadFixture(graduatedFixture);
      const amountIn = usd(500);
      let hash = await dollar.write.approve([swapRouter.address, amountIn], { account: owner.account });
      await publicClient.waitForTransactionReceipt({ hash });
      const { result: quote } = await quoter.simulate.quoteExactInputSingle([
        { tokenIn: dollar.address, tokenOut: coin.address, amountIn, fee: POOL_FEE, sqrtPriceLimitX96: 0n },
      ]);
      const rewardsBefore = await coin.read.balanceOf([distributor.address]);
      hash = await swapRouter.write.exactInputSingle(
        [
          {
            tokenIn: dollar.address,
            tokenOut: coin.address,
            fee: POOL_FEE,
            recipient: owner.account.address,
            deadline: DEADLINE,
            amountIn,
            amountOutMinimum: quote[0],
            sqrtPriceLimitX96: 0n,
          },
        ],
        { account: owner.account }
      );
      await publicClient.waitForTransactionReceipt({ hash });
      const fee = (quote[0] * REWARD_BPS) / BPS;
      expect(await coin.read.balanceOf([owner.account.address])).to.equal(quote[0] - fee);
      expect((await coin.read.balanceOf([distributor.address])) - rewardsBefore).to.equal(fee);
    });

    it('lets a liquidity provider add untaxed, and pay the fee once on the way out', async () => {
      const { coin, liquidityManager, dollar, bob, approveAll, publicClient } = await loadFixture(graduatedFixture);
      await approveAll(bob, [coin.address, dollar.address], liquidityManager.address);
      const [lower, upper] = await liquidityManager.read.fullRange([coin.address, dollar.address, POOL_FEE]);
      const [, , coinNeeded] = await liquidityManager.read.quoteAdd([
        coin.address,
        dollar.address,
        POOL_FEE,
        lower,
        upper,
        usd(1_000),
        2n ** 255n,
      ]);
      let hash = await liquidityManager.write.addLiquidity(
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
      const [position] = await liquidityManager.read.positionsOf([bob.account.address]);
      expect(position!.liquidity > 0n).to.equal(true);

      const coinsBefore = await coin.read.balanceOf([bob.account.address]);
      const { result } = await liquidityManager.simulate.removeLiquidity(
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
        { account: bob.account.address }
      );
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
      const coinsOut = result[1];
      expect(coinsOut > 0n).to.equal(true);
      // Straight from the pool to Bob: one fee, not one for each hop.
      expect((await coin.read.balanceOf([bob.account.address])) - coinsBefore).to.equal(
        coinsOut - (coinsOut * REWARD_BPS) / BPS
      );
      expect(await coin.read.balanceOf([liquidityManager.address])).to.equal(0n);
    });

    it("brings the creator's share of the pool's swap fees to the holders through the escrow", async () => {
      const { coin, distributor, listingManager, swapRouter, feeEscrow, dollar, owner, bob, publicClient } =
        await loadFixture(graduatedFixture);
      const amountIn = usd(3_000);
      let hash = await dollar.write.approve([swapRouter.address, amountIn], { account: owner.account });
      await publicClient.waitForTransactionReceipt({ hash });
      hash = await swapRouter.write.exactInputSingle(
        [
          {
            tokenIn: dollar.address,
            tokenOut: coin.address,
            fee: POOL_FEE,
            recipient: owner.account.address,
            deadline: DEADLINE,
            amountIn,
            amountOutMinimum: 1n,
            sqrtPriceLimitX96: 0n,
          },
        ],
        { account: owner.account }
      );
      await publicClient.waitForTransactionReceipt({ hash });

      hash = await listingManager.write.collectFees([coin.address]);
      await publicClient.waitForTransactionReceipt({ hash });
      const credited = await feeEscrow.read.balanceOf([distributor.address, dollar.address]);
      expect(credited > 0n).to.equal(true);

      const [, owedBefore] = await distributor.read.claimable([bob.account.address]);
      hash = await distributor.write.collectEscrow();
      await publicClient.waitForTransactionReceipt({ hash });
      expect(await feeEscrow.read.balanceOf([distributor.address, dollar.address])).to.equal(0n);
      const [, owedAfter] = await distributor.read.claimable([bob.account.address]);
      expect(owedAfter > owedBefore).to.equal(true);
      // Nobody is owed more than the distributor holds.
      expect(owedAfter <= (await dollar.read.balanceOf([distributor.address]))).to.equal(true);
    });
  });
});
