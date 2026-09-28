import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { encodePacked, getAddress, maxUint256, parseEther, zeroAddress, type Address } from 'viem';
import {
  LAUNCH_FEE,
  POOL_FEE,
  USD_CAP,
  USD_DECIMALS,
  deployLaunchpad,
  sqrtPriceX96For,
  usd,
} from './helpers/launchpad';

const MIN_BID = parseEther('1');
const INCREMENT = parseEther('2');
/** Ether at 3,000 of the launchpad's six-decimal dollar, which stands in for USDG here. */
const ETH_PRICE = 3_000;
const DEAD = getAddress('0x000000000000000000000000000000000000dEaD');

/**
 * The outbid market against the real launchpad rather than test doubles: a bid buys the coin on
 * its real bonding curve, in its real Uniswap V3 pool once it has graduated, and across the
 * graduation when a bid is the buy that fills the curve. The launchpad's six-decimal dollar is
 * the market's USDG, and a stand-in V4 PoolManager prices ether in it for bids paid in ether.
 */
async function deployFixture() {
  const stack = await deployLaunchpad();
  const { owner, alice, bob, weth, dollar, coinFactory, treasury, v3Factory } = stack;

  const vault = await hre.viem.deployContract('OutbidBuyback', [owner.account.address, weth.address, v3Factory.address, 3_600n]);
  const poolManager = await hre.viem.deployContract('MockPoolManagerV4', []);
  const market = await hre.viem.deployContract('OutbidMarket', [
    owner.account.address,
    dollar.address,
    weth.address,
    poolManager.address,
    vault.address,
    treasury.address,
    MIN_BID,
    INCREMENT,
  ]);
  await market.write.setRegistry([coinFactory.address]);
  const ethRoute = { currency0: zeroAddress, currency1: dollar.address, fee: 500, tickSpacing: 10, hooks: zeroAddress };
  await market.write.setRoute([zeroAddress, [ethRoute]]);
  await poolManager.write.setPrice([ethRoute, usd(ETH_PRICE), parseEther('1'), parseEther('1'), usd(ETH_PRICE)]);
  await dollar.write.mint([poolManager.address, usd(1_000_000)]);

  for (const wallet of [alice, bob]) {
    await dollar.write.approve([market.address, maxUint256], { account: wallet.account });
  }

  return { ...stack, vault, market };
}

const DEADLINE = 4_102_444_800n; // 2100-01-01
const PERIPHERY = 1;

/**
 * The same, with the swap page's executor behind `bidVia`: a WETH/USDG bridge pool on the
 * platform's own Uniswap V3 at 3,000 USDG an ether, deep enough for these bids, and its router
 * listed on a `SwapExecutor` the market routes through.
 */
async function routedFixture() {
  const stack = await deployFixture();
  const { owner, alice, weth, dollar, listingManager, liquidityManager, swapRouter, market, publicClient } = stack;

  const wethIsToken0 = weth.address.toLowerCase() < dollar.address.toLowerCase();
  let hash = await listingManager.write.openBridgePool(
    [weth.address, dollar.address, POOL_FEE, sqrtPriceX96For(parseEther(String(ETH_PRICE)), wethIsToken0, USD_DECIMALS)],
    { account: owner.account }
  );
  await publicClient.waitForTransactionReceipt({ hash });
  await weth.write.deposit({ value: parseEther('100'), account: alice.account });
  await dollar.write.mint([alice.account.address, usd(1_000_000)]);
  await stack.approveAll(alice, [weth.address, dollar.address], liquidityManager.address);
  const [lower, upper] = await liquidityManager.read.fullRange([weth.address, dollar.address, POOL_FEE]);
  const [, , wethNeeded] = await liquidityManager.read.quoteAdd([
    weth.address,
    dollar.address,
    POOL_FEE,
    lower,
    upper,
    usd(300_000),
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
        quoteDesired: usd(300_000),
        tokenDesired: (wethNeeded * 101n) / 100n,
        quoteMin: 0n,
        tokenMin: 0n,
        deadline: DEADLINE,
      },
    ],
    { account: alice.account }
  );
  await publicClient.waitForTransactionReceipt({ hash });

  const executor = await hre.viem.deployContract('SwapExecutor', [weth.address, owner.account.address]);
  await executor.write.setVenue([swapRouter.address, PERIPHERY]);
  await market.write.setExecutor([executor.address]);

  const path = (from: Address, to: Address) => encodePacked(['address', 'uint24', 'address'], [from, POOL_FEE, to]);
  /** The burn share, all of it, USDG to wrapped ether through the bridge pool. */
  const toEther = [{ shareBps: 10_000, steps: [{ router: swapRouter.address, path: path(dollar.address, weth.address) }] }];
  /** A payment of `amount` ether (or WETH), swapped to USDG through the bridge pool. */
  const fromEther = (amount: bigint) => [
    { amountIn: amount, minOut: 0n, steps: [{ router: swapRouter.address, path: path(weth.address, dollar.address) }] },
  ];
  const inUsdg = (amount: bigint) => ({ asset: dollar.address, amount, minUsdg: amount, legs: [] });
  return { ...stack, executor, path, toEther, fromEther, inUsdg };
}

/** OUTBID the stand-in PONS curve sells per whole USDG. */
const OUTBID_PER_USDG = parseEther('1000');

/**
 * The same, with $OUTBID live: a burnable stand-in token on a stand-in PONS curve priced in the
 * market's USDG, bought through the real PONS venue, and the vault enabled on it. From here a
 * bid's buyback share buys $OUTBID and burns it in the bid.
 */
async function liveFixture() {
  const stack = await deployFixture();
  const { owner, dollar, vault } = stack;
  const [, , , , hook] = await hre.viem.getWalletClients();
  const outbid = await hre.viem.deployContract('MockBurnableToken', ['Outbid', 'OUTBID', parseEther('1000000000')]);
  const ponsManager = await hre.viem.deployContract('MockPoolManagerV4', []);
  const pons = await hre.viem.deployContract('MockPonsFactory', [ponsManager.address, hook!.account.address]);
  const curve = await hre.viem.deployContract('MockPonsCurve', [outbid.address, dollar.address, 6, OUTBID_PER_USDG]);
  await outbid.write.approve([curve.address, parseEther('500000000')]);
  await curve.write.stock([parseEther('500000000')]);
  await pons.write.setLaunch([outbid.address, curve.address, dollar.address, 0, 200]);
  const venue = await hre.viem.deployContract('PonsBuybackVenue', [owner.account.address, pons.address]);
  await vault.write.enableBuyback([outbid.address, venue.address]);
  return { ...stack, outbid, curve, venue };
}

describe('OutbidMarket with the real launchpad', () => {
  it('buys a USDG coin on its curve with the burn share, and burns what it bought', async () => {
    const { market, launch, alice, bob, dollar, vault, treasury } = await loadFixture(deployFixture);
    const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
    const priceBefore = await fed.read.price();
    const treasuryBefore = await dollar.read.balanceOf([treasury.address]);

    await market.write.bid([fed.address, usd(1_000), 1n, 0n], { account: bob.account });

    expect(await market.read.getTotalBid([fed.address])).to.equal(parseEther('1000'));
    expect(getAddress(await market.read.topToken())).to.equal(getAddress(fed.address));
    // The buy moved the curve: the green candle the bid paid for.
    expect((await fed.read.price()) > priceBefore).to.equal(true);
    expect((await fed.read.balanceOf([DEAD])) > 0n).to.equal(true);
    // 20% to the vault in USDG. The treasury also gets the protocol's 30% of the curve's 1% fee
    // on the burn share's buy, on top of the bid's 5%.
    expect(await dollar.read.balanceOf([vault.address])).to.equal(usd(200));
    const protocolFee = (((usd(750) * 100n) / 10_000n) * 3_000n) / 10_000n;
    expect((await dollar.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(usd(50) + protocolFee);
    // The market keeps nothing.
    expect(await dollar.read.balanceOf([market.address])).to.equal(0n);
    expect(await fed.read.balanceOf([market.address])).to.equal(0n);
  });

  it('burns a reward coin untaxed, its holders keeping the reward from the curve buy', async () => {
    const { market, launch, alice, bob, dollar } = await loadFixture(deployFixture);
    const divi = await launch(alice, 'Dividend Dog', 'DIVI', { quote: dollar.address, rewardFeeBps: 300 });
    const distributor = await hre.viem.getContractAt('HolderRewards', await divi.read.rewardDistributor());

    await market.write.bid([divi.address, usd(1_000), 1n, 0n], { account: bob.account });
    const burned = await divi.read.balanceOf([DEAD]);
    const kept = await divi.read.balanceOf([distributor.address]);
    expect(burned > 0n).to.equal(true);
    // The curve kept 3% of what it minted for the market; the market burned all of the rest.
    expect(kept).to.equal(((burned + kept) * 300n) / 10_000n);
    expect(await divi.read.balanceOf([market.address])).to.equal(0n);
    expect(await distributor.read.sharesOf([DEAD])).to.equal(0n);
    expect(await distributor.read.sharesOf([market.address])).to.equal(0n);
  });

  it('lands a bid on a coin whose balance was pushed to its cap: the market sweeps, then buys (AUDIT-3 H-04)', async () => {
    const { market, launch, buy, alice, bob, carol, dollar, treasury, listingManager, publicClient } = await loadFixture(deployFixture);
    const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
    // Alice fills it to about 1.4 USDG short of its 14,000 USDG cap, and Carol pushes 2 USDG in.
    // The curve does not count Carol's (AUDIT-6 K-04), but the market, which reads the balance,
    // sees it at the cap and calls `graduate` first: that sweeps the 2 USDG, and the bid's buy
    // then fills the curve for real and graduates it inside the bid.
    await buy(fed, alice, usd(14_140));
    const reserve = await fed.read.reserveBalance();
    expect(reserve < USD_CAP).to.equal(true);
    const hash = await dollar.write.transfer([fed.address, usd(2)], { account: carol.account });
    await publicClient.waitForTransactionReceipt({ hash });
    expect(await fed.read.reserveBalance()).to.equal(reserve);

    const treasuryBefore = await dollar.read.balanceOf([treasury.address]);
    await market.write.bid([fed.address, usd(100), 1n, 0n], { account: bob.account });
    expect(await fed.read.cap()).to.equal(0n);
    expect(await listingManager.read.poolOf([fed.address])).to.not.equal(zeroAddress);
    expect(await market.read.getTotalBid([fed.address])).to.equal(parseEther('100'));
    expect((await fed.read.balanceOf([DEAD])) > 0n).to.equal(true);
    // Carol's 2 USDG went to the treasury, along with the bid's 5% and the pool buy's fee.
    expect((await dollar.read.balanceOf([treasury.address])) - treasuryBefore >= usd(2) + usd(5)).to.equal(true);
  });

  it('fills a curve by buys alone: what is pushed in is swept, and a graduated coin sweeps no more', async () => {
    const { launch, buy, alice, carol, dollar, treasury, publicClient } = await loadFixture(deployFixture);
    const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
    await buy(fed, alice, usd(5_000));
    const hash = await dollar.write.transfer([fed.address, usd(9_100)], { account: carol.account });
    await publicClient.waitForTransactionReceipt({ hash });
    // Before AUDIT-6 K-04 this graduated the coin on Carol's money.
    const treasuryBefore = await dollar.read.balanceOf([treasury.address]);
    await fed.write.graduate({ account: carol.account });
    expect(await fed.read.cap()).to.equal(USD_CAP);
    expect((await dollar.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(usd(9_100));

    await buy(fed, alice, usd(10_000));
    expect(await fed.read.cap()).to.equal(0n);
    await expect(fed.write.graduate({ account: carol.account })).to.be.rejectedWith('Already listed');
  });

  it('asks for a burn route to bid on a coin priced in anything but USDG', async () => {
    const { market, launch, alice, bob } = await loadFixture(deployFixture);
    const pepe = await launch(alice, 'Front Page Pepe', 'PEPE'); // priced in WETH
    await expect(market.write.bid([pepe.address, usd(100), 0n, 0n], { account: bob.account })).to.be.rejectedWith(
      'NoBurnRoute'
    );
  });

  describe('bidding through the swap page\'s executor', () => {
    it('bids on a coin priced in ether: the burn share swaps to WETH, buys the coin, and burns it', async () => {
      const { market, launch, alice, bob, dollar, weth, treasury, vault, toEther, inUsdg } = await loadFixture(routedFixture);
      const pepe = await launch(alice, 'Front Page Pepe', 'PEPE');
      const treasuryBefore = await dollar.read.balanceOf([treasury.address]);

      await market.write.bidVia([pepe.address, inUsdg(usd(100)), toEther, 1n, 0n, false], { account: bob.account });

      expect(await market.read.getTotalBid([pepe.address])).to.equal(parseEther('100'));
      expect((await pepe.read.balanceOf([DEAD])) > 0n).to.equal(true);
      const [routed] = await market.getEvents.BurnRouted();
      expect(routed!.args.asset).to.equal(getAddress(weth.address));
      expect(routed!.args.usdgIn).to.equal(usd(75));
      // 75 USDG at about 3,000 an ether, less the pool's fee and a little impact.
      expect(routed!.args.assetOut! > parseEther('0.0240')).to.equal(true);
      const [settled] = await market.getEvents.BidSettled();
      expect(settled!.args.burnSpent).to.equal(usd(75));
      expect(await dollar.read.balanceOf([vault.address])).to.equal(usd(20));
      expect((await dollar.read.balanceOf([treasury.address])) - treasuryBefore).to.equal(usd(5));
      for (const token of [dollar, weth, pepe]) expect(await token.read.balanceOf([market.address])).to.equal(0n);
    });

    it('pays in ether through the executor, and bids the USDG it brought', async () => {
      const { market, launch, alice, bob, dollar, fromEther, publicClient } = await loadFixture(routedFixture);
      const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
      const paid = parseEther('0.1'); // about 300 USDG

      const payment = { asset: zeroAddress, amount: paid, minUsdg: usd(290), legs: fromEther(paid) };
      await market.write.bidVia([fed.address, payment, [], 1n, 0n, false], { account: bob.account, value: paid });

      const bid = await market.read.getTotalBid([fed.address]);
      expect(bid > parseEther('290') && bid < parseEther('300')).to.equal(true);
      const [paidWith] = await market.getEvents.PaidWith();
      expect(paidWith!.args.assetIn).to.equal(zeroAddress);
      expect(paidWith!.args.amountIn).to.equal(paid);
      expect(await publicClient.getBalance({ address: market.address })).to.equal(0n);
    });

    it('pays in ether for a coin priced in ether, in one transaction', async () => {
      const { market, launch, alice, bob, weth, dollar, toEther, fromEther } = await loadFixture(routedFixture);
      const pepe = await launch(alice, 'Front Page Pepe', 'PEPE');
      const paid = parseEther('0.05');

      const payment = { asset: zeroAddress, amount: paid, minUsdg: usd(140), legs: fromEther(paid) };
      await market.write.bidVia([pepe.address, payment, toEther, 1n, 0n, true], { account: bob.account, value: paid });

      expect(await market.read.topToken()).to.equal(getAddress(pepe.address));
      expect((await pepe.read.balanceOf([DEAD])) > 0n).to.equal(true);
      for (const token of [dollar, weth, pepe]) expect(await token.read.balanceOf([market.address])).to.equal(0n);
    });

    it('splits the burn swap by share, the last leg taking the rounding', async () => {
      const { market, launch, alice, bob, dollar, swapRouter, path, inUsdg } = await loadFixture(routedFixture);
      const pepe = await launch(alice, 'Front Page Pepe', 'PEPE');
      const step = { router: swapRouter.address, path: path(dollar.address, (await pepe.read.reserveToken()) as Address) };
      const route = [
        { shareBps: 3_333, steps: [step] },
        { shareBps: 6_667, steps: [step] },
      ];

      await market.write.bidVia([pepe.address, inUsdg(usd(100) + 1n), route, 1n, 0n, false], { account: bob.account });

      const [routed] = await market.getEvents.BurnRouted();
      const [settled] = await market.getEvents.BidSettled();
      // Every unit of the burn share went, the odd one with the last leg.
      expect(routed!.args.usdgIn).to.equal(settled!.args.burnSpent);
      expect(settled!.args.burnSpent! + settled!.args.toBuyback! + settled!.args.toTreasury!).to.equal(usd(100) + 1n);
    });

    it('returns what a payment\'s swap could not use, as ether or as the token paid', async () => {
      const { market, executor, launch, alice, bob, dollar, weth, path, publicClient } = await loadFixture(routedFixture);
      const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
      // A router that spends half of what it is given and pays out the leg's minimum.
      const half = await hre.viem.deployContract('HalfSpendingRouter', []);
      await executor.write.setVenue([half.address, PERIPHERY]);
      await dollar.write.mint([half.address, usd(1_000)]);
      const legs = (amount: bigint) => [
        { amountIn: amount, minOut: usd(100), steps: [{ router: half.address, path: path(weth.address, dollar.address) }] },
      ];
      const paid = parseEther('0.1');

      const etherBefore = await publicClient.getBalance({ address: bob.account.address });
      const hash = await market.write.bidVia(
        [fed.address, { asset: zeroAddress, amount: paid, minUsdg: usd(100), legs: legs(paid) }, [], 1n, 0n, false],
        { account: bob.account, value: paid }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const gas = receipt.gasUsed * receipt.effectiveGasPrice;
      expect(etherBefore - (await publicClient.getBalance({ address: bob.account.address })) - gas).to.equal(paid / 2n);

      await weth.write.deposit({ value: paid, account: bob.account });
      await weth.write.approve([market.address, paid], { account: bob.account });
      const wethBefore = await weth.read.balanceOf([bob.account.address]);
      await market.write.bidVia(
        [fed.address, { asset: weth.address, amount: paid, minUsdg: usd(100), legs: legs(paid) }, [], 1n, 0n, false],
        { account: bob.account }
      );
      expect(wethBefore - (await weth.read.balanceOf([bob.account.address]))).to.equal(paid / 2n);
      expect(await publicClient.getBalance({ address: market.address })).to.equal(0n);
      expect(await weth.read.balanceOf([market.address])).to.equal(0n);
    });

    it('refuses shares that do not add up, an empty share, no executor, and a burn that buys too little', async () => {
      const { market, launch, alice, bob, owner, toEther, inUsdg } = await loadFixture(routedFixture);
      const pepe = await launch(alice, 'Front Page Pepe', 'PEPE');
      const leg = toEther[0]!;

      await expect(
        market.write.bidVia([pepe.address, inUsdg(usd(100)), [{ ...leg, shareBps: 9_000 }], 1n, 0n, false], { account: bob.account })
      ).to.be.rejectedWith('InvalidSplit');
      await expect(
        market.write.bidVia([pepe.address, inUsdg(usd(100)), [leg, { ...leg, shareBps: 0 }], 1n, 0n, false], { account: bob.account })
      ).to.be.rejectedWith('NoBurnRoute');
      await expect(
        market.write.bidVia([pepe.address, inUsdg(usd(100)), toEther, maxUint256, 0n, false], { account: bob.account })
      ).to.be.rejectedWith('ExcessiveSlippage');
      await market.write.setExecutor([zeroAddress], { account: owner.account });
      await expect(
        market.write.bidVia([pepe.address, inUsdg(usd(100)), toEther, 1n, 0n, false], { account: bob.account })
      ).to.be.rejectedWith('NoExecutor');
    });

    it('refuses a route through a router the executor has not listed, and the wrong value', async () => {
      const { market, launch, alice, bob, dollar, weth, path, fromEther } = await loadFixture(routedFixture);
      const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
      const paid = parseEther('0.1');
      const unlisted = [{ amountIn: paid, minOut: 0n, steps: [{ router: fed.address, path: path(weth.address, dollar.address) }] }];

      await expect(
        market.write.bidVia([fed.address, { asset: zeroAddress, amount: paid, minUsdg: 1n, legs: unlisted }, [], 1n, 0n, false], {
          account: bob.account,
          value: paid,
        })
      ).to.be.rejectedWith('UnlistedRouter');
      await expect(
        market.write.bidVia([fed.address, { asset: zeroAddress, amount: paid, minUsdg: 1n, legs: fromEther(paid) }, [], 1n, 0n, false], {
          account: bob.account,
          value: paid / 2n,
        })
      ).to.be.rejectedWith('WrongValue');
      await expect(
        market.write.bidVia(
          [fed.address, { asset: zeroAddress, amount: paid, minUsdg: usd(1_000), legs: fromEther(paid) }, [], 1n, 0n, false],
          { account: bob.account, value: paid }
        )
      ).to.be.rejectedWith('TooLittleReceived');
    });
  });

  it('takes a bid paid in ether, swapped to USDG on the way', async () => {
    const { market, launch, alice, bob, dollar } = await loadFixture(deployFixture);
    const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
    const paid = parseEther('0.1'); // 300 USDG

    const { result: quote } = await market.simulate.quoteUsdg([zeroAddress, paid]);
    await market.write.bidWith([fed.address, zeroAddress, paid, quote, 1n, 0n, false], { account: bob.account, value: paid });

    expect(await market.read.getTotalBid([fed.address])).to.equal(parseEther('300'));
    expect((await fed.read.balanceOf([DEAD])) > 0n).to.equal(true);
  });

  it('buys a graduated coin in its pool', async () => {
    const { market, launch, buy, alice, bob, dollar, listingManager } = await loadFixture(deployFixture);
    const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
    await buy(fed, alice, usd(20_000)); // past the cap: it graduates
    expect(await fed.read.cap()).to.equal(0n);
    const pool = await listingManager.read.poolOf([fed.address]);
    const poolContract = await hre.viem.getContractAt('UniswapV3Pool', pool);
    const [sqrtBefore] = await poolContract.read.slot0();

    await market.write.bid([fed.address, usd(1_000), 1n, 0n], { account: bob.account });

    const [sqrtAfter] = await poolContract.read.slot0();
    expect(sqrtAfter).to.not.equal(sqrtBefore);
    expect((await fed.read.balanceOf([DEAD])) > 0n).to.equal(true);
    expect(await dollar.read.balanceOf([market.address])).to.equal(0n);
  });

  it('graduates a coin when the bid fills its curve, and buys the rest in the new pool', async () => {
    const { market, launch, buy, alice, bob, dollar, listingManager } = await loadFixture(deployFixture);
    const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
    // Leave less room on the curve than the bid's burn share will spend.
    await buy(fed, alice, USD_CAP - usd(300));
    expect(await fed.read.cap()).to.not.equal(0n);

    await market.write.bid([fed.address, usd(2_000), 1n, 0n], { account: bob.account });

    expect(await fed.read.cap()).to.equal(0n);
    expect(await listingManager.read.poolOf([fed.address])).to.not.equal(zeroAddress);
    const [settled] = await market.getEvents.BidSettled();
    // The whole burn share was spent: part on the curve, the rest in the pool.
    expect(settled!.args.burnSpent).to.equal(usd(1_500));
    expect(await dollar.read.balanceOf([market.address])).to.equal(0n);
    expect(await fed.read.balanceOf([market.address])).to.equal(0n);
  });

  describe('the bid dialog\'s quote', () => {
    // The web app's recipe for `minCoinsOut` (apps/web useBurnQuote), step by step: the burn share
    // is what is left after the 20% and 5%; on the curve the fee, the creator's tax and the snipe
    // tax the market itself would pay come off it, only what fits under the cap is taken, and
    // `calculatePurchaseReturn` prices that; in the pool QuoterV2 prices the whole share. If the
    // recipe ever quoted more than a bid buys, every bid sent with it would revert.
    const burnShare = (amount: bigint) => amount - (amount * 2_000n) / 10_000n - (amount * 500n) / 10_000n;

    async function curveQuote(coin: Address, market: Address, burn: bigint) {
      const token = await hre.viem.getContractAt('Coin', coin);
      const [cap, reserve, feeBps, creatorTaxBps, snipeBps] = await Promise.all([
        token.read.cap(),
        token.read.reserveBalance(),
        token.read.feeBps(),
        token.read.creatorTaxBps(),
        token.read.snipeTaxBps([market]),
      ]);
      const rate = BigInt(feeBps) + BigInt(creatorTaxBps) + snipeBps;
      const value = burn - (burn * rate) / 10_000n;
      const room = cap > reserve ? cap - reserve : 0n;
      return token.read.calculatePurchaseReturn([value > room ? room : value]);
    }

    it('matches what a bid burns on the curve, creator tax included', async () => {
      const { market, launch, alice, bob, dollar } = await loadFixture(deployFixture);
      const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address, creatorTaxBps: 300 });
      const amount = usd(1_000);

      const quote = await curveQuote(fed.address, market.address, burnShare(amount));
      await market.write.bid([fed.address, amount, quote, 0n], { account: bob.account });

      expect((await market.getEvents.BidSettled(undefined, { fromBlock: 0n })).at(-1)!.args.coinsBurned).to.equal(quote);
    });

    it('never quotes more than a bid burns inside the snipe window', async () => {
      const { market, launch, alice, bob, dollar } = await loadFixture(deployFixture);
      const pepe = await launch(alice, 'Front Page Pepe', 'PEPE', { quote: dollar.address, inWindow: true });
      const amount = usd(1_000);

      // In the launch's own second the tax and the fee take the whole share: the quote is zero,
      // and the dialog refuses to send a bid it cannot quote.
      expect(await curveQuote(pepe.address, market.address, burnShare(amount))).to.equal(0n);

      // A second later the tax has fallen by a third. Quoted with it as it stands; the bid lands a block
      // later still, when it has only fallen further.
      await time.increase(1);
      const quote = await curveQuote(pepe.address, market.address, burnShare(amount));
      expect(quote > 0n).to.equal(true);
      await market.write.bid([pepe.address, amount, quote, 0n], { account: bob.account });

      const [settled] = (await market.getEvents.BidSettled(undefined, { fromBlock: 0n })).slice(-1);
      expect(settled!.args.coinsBurned! >= quote).to.equal(true);
    });

    it('matches what a bid burns in a graduated coin\'s pool, by QuoterV2', async () => {
      const { market, launch, buy, alice, bob, dollar, quoter, listingManager } = await loadFixture(deployFixture);
      const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
      await buy(fed, alice, usd(20_000));
      const pool = await hre.viem.getContractAt('UniswapV3Pool', await listingManager.read.poolOf([fed.address]));
      const amount = usd(1_000);

      const { result } = await quoter.simulate.quoteExactInputSingle([
        {
          tokenIn: dollar.address,
          tokenOut: fed.address,
          amountIn: burnShare(amount),
          fee: await pool.read.fee(),
          sqrtPriceLimitX96: 0n,
        },
      ]);
      const quote = result[0];
      await market.write.bid([fed.address, amount, quote, 0n], { account: bob.account });

      expect((await market.getEvents.BidSettled(undefined, { fromBlock: 0n })).at(-1)!.args.coinsBurned).to.equal(quote);
    });
  });

  describe('the $OUTBID share, once $OUTBID is live', () => {
    it('buys $OUTBID with the 20% and burns it in the bid, and says what it burned', async () => {
      const { market, launch, alice, bob, dollar, vault, outbid, publicClient } = await loadFixture(liveFixture);
      const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
      expect(await market.read.buybackLive()).to.equal(true);
      const supplyBefore = await outbid.read.totalSupply();
      const vaultBefore = await dollar.read.balanceOf([vault.address]);

      // 20% of 1,000 USDG is 200 USDG, which the curve sells at 1,000 OUTBID each.
      const expected = parseEther('200000');
      const { result } = await market.simulate.bid([fed.address, usd(1_000), 1n, expected], { account: bob.account.address });
      expect(result[1]).to.equal(expected);
      const hash = await market.write.bid([fed.address, usd(1_000), 1n, expected], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });

      // Bought and burned in the same transaction: nothing waits in the vault, and the supply fell.
      expect(await dollar.read.balanceOf([vault.address])).to.equal(vaultBefore);
      expect(supplyBefore - (await outbid.read.totalSupply())).to.equal(expected);
      expect(await vault.read.totalOutbidBurned()).to.equal(expected);
      const executed = (await vault.getEvents.BuybackExecuted(undefined, { fromBlock: 0n })).at(-1)!;
      expect(getAddress(executed.args.keeper!)).to.equal(getAddress(market.address));
      expect(executed.args.amountIn).to.equal(usd(200));
      expect(await dollar.read.balanceOf([market.address])).to.equal(0n);
    });

    it('buys only at the bidder’s minimum: without one, or short of it, the 20% waits in the vault and the bid lands', async () => {
      const { market, launch, alice, bob, dollar, vault, outbid } = await loadFixture(liveFixture);
      const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
      const supplyBefore = await outbid.read.totalSupply();

      // No minimum: the vault will not buy blind, so the share is deferred rather than sandwiched.
      await market.write.bid([fed.address, usd(1_000), 1n, 0n], { account: bob.account });
      expect(await dollar.read.balanceOf([vault.address])).to.equal(usd(200));
      // A minimum the buy cannot meet: deferred too (AUDIT-3 H-01), and the board still moves.
      await market.write.bid([fed.address, usd(1_000), 1n, parseEther('200000') + 1n], { account: bob.account });
      expect(await dollar.read.balanceOf([vault.address])).to.equal(usd(400));

      expect(await outbid.read.totalSupply()).to.equal(supplyBefore);
      expect(await market.read.getTotalBid([fed.address])).to.equal(parseEther('2000'));
      const deferred = await market.getEvents.BuybackDeferred({ fromBlock: 0n });
      expect(deferred.map((event) => event.args.amount)).to.deep.equal([usd(200), usd(200)]);
    });

    it('lands the bid when $OUTBID cannot be bought at all, and leaves the 20% for the keeper (AUDIT-3 H-01)', async () => {
      const { market, launch, alice, bob, dollar, vault, curve } = await loadFixture(liveFixture);
      const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
      // PONS between its curve and its pool: the venue refuses every buy.
      await curve.write.setGraduated([true]);
      await market.write.bid([fed.address, usd(100), 1n, parseEther('20000')], { account: bob.account });
      expect(await market.read.getTotalBid([fed.address])).to.equal(parseEther('100'));
      expect(await dollar.read.balanceOf([vault.address])).to.equal(usd(20));
      expect(await dollar.read.balanceOf([market.address])).to.equal(0n);
    });

    it('spends no more than the vault’s cap at once, and leaves the rest for the keeper', async () => {
      const { market, launch, alice, bob, owner, dollar, vault, outbid } = await loadFixture(liveFixture);
      const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
      await vault.write.setMaxPerExecution([dollar.address, usd(50)], { account: owner.account });
      const supplyBefore = await outbid.read.totalSupply();
      await market.write.bid([fed.address, usd(1_000), 1n, parseEther('50000')], { account: bob.account });
      expect(supplyBefore - (await outbid.read.totalSupply())).to.equal(parseEther('50000'));
      expect(await dollar.read.balanceOf([vault.address])).to.equal(usd(150));
    });

    it('pays the share to the vault, as before, while $OUTBID is not live or the buyback is the treasury', async () => {
      const { market, launch, alice, bob, owner, dollar, vault, treasury } = await loadFixture(deployFixture);
      const fed = await launch(alice, 'Federal Reserve', 'FED', { quote: dollar.address });
      expect(await market.read.buybackLive()).to.equal(false);
      const { result } = await market.simulate.bid([fed.address, usd(100), 1n, 0n], { account: bob.account.address });
      expect(result[1]).to.equal(0n);
      await market.write.bid([fed.address, usd(100), 1n, 0n], { account: bob.account });
      expect(await dollar.read.balanceOf([vault.address])).to.equal(usd(20));

      await market.write.setDestinations([treasury.address, treasury.address], { account: owner.account });
      expect(await market.read.buybackLive()).to.equal(false);
      const before = await dollar.read.balanceOf([treasury.address]);
      await market.write.bid([fed.address, usd(100), 1n, 0n], { account: bob.account });
      expect((await dollar.read.balanceOf([treasury.address])) - before >= usd(25)).to.equal(true);
    });
  });

  it('refuses a bid for an address the factory does not know', async () => {
    const { market, bob, dollar } = await loadFixture(deployFixture);
    const fake = await hre.viem.deployContract('MockBiddableCoin', [dollar.address, 1n]);
    await expect(
      market.write.bid([fake.address as Address, usd(1), 0n, 0n], { account: bob.account })
    ).to.be.rejectedWith('TokenNotRegistered');
  });

  it('counts launches through the factory', async () => {
    const { coinFactory, bob, publicClient, weth } = await loadFixture(deployFixture);
    expect(await coinFactory.read.allMemecoinsCount()).to.equal(0);
    for (const [name, symbol] of [
      ['Front Page Pepe', 'PEPE'],
      ['Federal Reserve', 'FED'],
    ]) {
      const hash = await coinFactory.write.deploy(
        [
          {
            name: name!,
            symbol: symbol!,
            description: '',
            image: '',
            socials: '',
            quoteAsset: weth.address,
            preBuy: 0n,
            creatorFeeRecipient: zeroAddress,
            creatorTaxBps: 0,
            rewardFeeBps: 0,
            shareFeesWithHolders: false,
          },
          [],
        ],
        { account: bob.account, value: LAUNCH_FEE }
      );
      await publicClient.waitForTransactionReceipt({ hash });
    }
    expect(await coinFactory.read.allMemecoinsCount()).to.equal(2);
  });
});
