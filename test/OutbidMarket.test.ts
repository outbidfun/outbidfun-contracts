import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { getAddress, parseEther, parseUnits, zeroAddress, type Address } from 'viem';

/** USDG has six decimals; the board states bids at eighteen. */
const usdg = (amount: number | string) => parseUnits(String(amount), 6);
const board = (amount: number | string) => parseEther(String(amount));
const MIN_BID = board(1);
const INCREMENT = board(2);
const DEAD = getAddress('0x000000000000000000000000000000000000dEaD');
/** What each raw unit of USDG buys on the stand-in coin. */
const COINS_PER_UNIT = 1_000n;
/** Ether at 3,000 USDG, a share at 250, in the stand-in V4 pools. */
const ETH_PRICE = 3_000;
const SHARE_PRICE = 250;

async function deployFixture() {
  const [owner, alice, bob, carol] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const dollar = await hre.viem.deployContract('MockERC20', ['Global Dollar', 'USDG', 6, 0n]);
  const share = await hre.viem.deployContract('MockERC20', ['Tokenised Share', 'AAPL', 18, 0n]);
  const weth = await hre.viem.deployContract('WETH9', []);
  const poolManager = await hre.viem.deployContract('MockPoolManagerV4', []);

  // Stand-ins for the buyback vault and the treasury: anything that can hold a token.
  const vault = await hre.viem.deployContract('Treasury', [owner!.account.address]);
  const treasury = await hre.viem.deployContract('Treasury', [owner!.account.address]);
  const registry = await hre.viem.deployContract('MockTokenRegistry', []);

  const market = await hre.viem.deployContract('OutbidMarket', [
    owner!.account.address,
    dollar.address,
    weth.address,
    poolManager.address,
    vault.address,
    treasury.address,
    MIN_BID,
    INCREMENT,
  ]);
  await market.write.setRegistry([registry.address]);

  // The routes into USDG: ether through an ETH/USDG pool, the share through a share/USDG pool.
  const sorted = (a: Address, b: Address) => (a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]) as [Address, Address];
  const ethRoute = { currency0: zeroAddress, currency1: dollar.address, fee: 500, tickSpacing: 10, hooks: zeroAddress };
  const [s0, s1] = sorted(share.address, dollar.address);
  const shareRoute = { currency0: s0, currency1: s1, fee: 3_000, tickSpacing: 60, hooks: zeroAddress };
  await market.write.setRoute([zeroAddress, [ethRoute]]);
  await market.write.setRoute([share.address, [shareRoute]]);
  // Prices in the stand-in manager: out = in × n / d, one pair of numbers per direction.
  await poolManager.write.setPrice([ethRoute, usdg(ETH_PRICE), parseEther('1'), parseEther('1'), usdg(ETH_PRICE)]);
  const shareIsZero = s0.toLowerCase() === share.address.toLowerCase();
  await poolManager.write.setPrice([
    shareRoute,
    shareIsZero ? usdg(SHARE_PRICE) : parseEther('1'),
    shareIsZero ? parseEther('1') : usdg(SHARE_PRICE),
    shareIsZero ? parseEther('1') : usdg(SHARE_PRICE),
    shareIsZero ? usdg(SHARE_PRICE) : parseEther('1'),
  ]);
  // The manager pays out USDG, so it holds some.
  await dollar.write.mint([poolManager.address, usdg(10_000_000)]);

  for (const wallet of [alice!, bob!, carol!]) {
    await dollar.write.mint([wallet.account.address, usdg(10_000_000)]);
    await share.write.mint([wallet.account.address, parseEther('1000')]);
    await weth.write.deposit({ value: parseEther('100'), account: wallet.account });
    await dollar.write.approve([market.address, 2n ** 255n], { account: wallet.account });
    await share.write.approve([market.address, 2n ** 255n], { account: wallet.account });
    await weth.write.approve([market.address, 2n ** 255n], { account: wallet.account });
  }

  /** A coin on its curve, priced in `asset` (USDG unless said otherwise), that the registry knows. */
  async function coin(asset: Address = dollar.address) {
    const deployed = await hre.viem.deployContract('MockBiddableCoin', [asset, COINS_PER_UNIT]);
    await registry.write.setLegit([deployed.address, true]);
    return deployed;
  }

  type Wallet = typeof alice;
  /** Bids `amount` raw USDG. */
  async function bid(token: Address, wallet: Wallet, amount: bigint, minCoinsOut = 0n) {
    const hash = await market.write.bid([token, amount, minCoinsOut, 0n], { account: wallet!.account });
    return publicClient.waitForTransactionReceipt({ hash });
  }

  return {
    owner: owner!,
    alice: alice!,
    bob: bob!,
    carol: carol!,
    publicClient,
    dollar,
    share,
    weth,
    poolManager,
    vault,
    treasury,
    registry,
    market,
    ethRoute,
    shareRoute,
    coin,
    bid,
  };
}

describe('OutbidMarket', () => {
  describe('deployment', () => {
    it('stores the configuration and the 75 / 20 / 5 split', async () => {
      const { market, vault, treasury, owner, dollar, weth, poolManager } = await loadFixture(deployFixture);
      expect(await market.read.owner()).to.equal(getAddress(owner.account.address));
      expect(await market.read.usdg()).to.equal(getAddress(dollar.address));
      expect(await market.read.weth()).to.equal(getAddress(weth.address));
      expect(await market.read.poolManager()).to.equal(getAddress(poolManager.address));
      expect(await market.read.buyback()).to.equal(getAddress(vault.address));
      expect(await market.read.treasury()).to.equal(getAddress(treasury.address));
      expect(await market.read.burnBps()).to.equal(7_500);
      expect(await market.read.buybackBps()).to.equal(2_000);
      expect(await market.read.treasuryBps()).to.equal(500);
      expect(await market.read.minBid()).to.equal(MIN_BID);
      expect(await market.read.outbidIncrement()).to.equal(INCREMENT);
      expect(await market.read.topToken()).to.equal(zeroAddress);
    });

    it('rejects a missing USDG, WETH or destination, and a zero increment', async () => {
      const { owner, treasury, vault, dollar, weth, poolManager } = await loadFixture(deployFixture);
      const me = owner.account.address;
      const args = (overrides: Partial<Record<'usdg' | 'weth' | 'buyback' | 'treasury' | 'step', unknown>>) =>
        [
          me,
          overrides.usdg ?? dollar.address,
          overrides.weth ?? weth.address,
          poolManager.address,
          overrides.buyback ?? vault.address,
          overrides.treasury ?? treasury.address,
          MIN_BID,
          overrides.step ?? INCREMENT,
        ] as const;
      await expect(hre.viem.deployContract('OutbidMarket', args({ usdg: zeroAddress }) as never)).to.be.rejected;
      await expect(hre.viem.deployContract('OutbidMarket', args({ weth: zeroAddress }) as never)).to.be.rejectedWith('ZeroAddress');
      await expect(hre.viem.deployContract('OutbidMarket', args({ buyback: zeroAddress }) as never)).to.be.rejectedWith('ZeroAddress');
      await expect(hre.viem.deployContract('OutbidMarket', args({ treasury: zeroAddress }) as never)).to.be.rejectedWith('ZeroAddress');
      await expect(hre.viem.deployContract('OutbidMarket', args({ step: 0n }) as never)).to.be.rejectedWith('InvalidIncrement');
    });
  });

  describe('bidding in USDG', () => {
    it('splits the bid: 75% buys the coin and burns it, 20% to the buyback, 5% to the treasury', async () => {
      const { market, coin, bid, alice, dollar, vault, treasury } = await loadFixture(deployFixture);
      const dog = await coin();
      const amount = usdg(1_000);

      const receipt = await bid(dog.address, alice, amount);

      expect(await dollar.read.balanceOf([vault.address])).to.equal(usdg(200));
      expect(await dollar.read.balanceOf([treasury.address])).to.equal(usdg(50));
      // The burn share bought the coin, and every coin bought sits at the dead address.
      expect(await dollar.read.balanceOf([dog.address])).to.equal(usdg(750));
      expect(await dog.read.balanceOf([DEAD])).to.equal(usdg(750) * COINS_PER_UNIT);
      // The market keeps nothing of either.
      expect(await dollar.read.balanceOf([market.address])).to.equal(0n);
      expect(await dog.read.balanceOf([market.address])).to.equal(0n);

      const position = await market.read.getPosition([dog.address]);
      expect(position.totalBid).to.equal(board(1_000));
      expect(position.lastBidder).to.equal(getAddress(alice.account.address));
      expect(await market.read.topToken()).to.equal(getAddress(dog.address));

      const [placed] = await market.getEvents.BidPlaced({}, { blockHash: receipt.blockHash });
      expect(placed!.args.asset).to.equal(getAddress(dollar.address));
      expect(placed!.args.amount).to.equal(amount);
      expect(placed!.args.value).to.equal(board(1_000));
      const [settled] = await market.getEvents.BidSettled({}, { blockHash: receipt.blockHash });
      expect(settled!.args.burnSpent).to.equal(usdg(750));
      expect(settled!.args.coinsBurned).to.equal(usdg(750) * COINS_PER_UNIT);
      expect(settled!.args.toBuyback).to.equal(usdg(200));
      expect(settled!.args.toTreasury).to.equal(usdg(50));
    });

    it('asks for a burn route for a coin that is not priced in USDG', async () => {
      const { coin, bid, alice, weth } = await loadFixture(deployFixture);
      const cat = await coin(weth.address);
      await expect(bid(cat.address, alice, usdg(100))).to.be.rejectedWith('NoBurnRoute');
    });

    it('rejects a bid below the minimum, and zero even when the minimum is zero', async () => {
      const { market, coin, bid, alice, owner } = await loadFixture(deployFixture);
      const dog = await coin();
      await expect(bid(dog.address, alice, usdg(1) - 1n)).to.be.rejectedWith('BidTooLow');
      await bid(dog.address, alice, usdg(1));
      await market.write.setMinBid([0n], { account: owner.account });
      await expect(bid(dog.address, alice, 0n)).to.be.rejectedWith('BidTooLow');
    });

    it('reverts when the burn share buys fewer coins than the bidder asked for', async () => {
      const { coin, bid, alice } = await loadFixture(deployFixture);
      const dog = await coin();
      const bought = usdg(750) * COINS_PER_UNIT;
      await expect(bid(dog.address, alice, usdg(1_000), bought + 1n)).to.be.rejectedWith('ExcessiveSlippage');
      await bid(dog.address, alice, usdg(1_000), bought);
    });

    it('follows the lifecycle: cumulative bids, no refunds, only the difference is charged', async () => {
      const { market, coin, bid, alice, bob } = await loadFixture(deployFixture);
      const dog = await coin();
      const cat = await coin();

      await bid(dog.address, alice, usdg(1_000));
      // To take #1, CAT pays the leader's total plus the step.
      expect(await market.read.getNextBid([cat.address])).to.equal(board(1_002));
      const [asset, amount] = await market.read.getNextBidAmount([cat.address]);
      expect(asset).to.equal(await market.read.usdg());
      expect(amount).to.equal(usdg(1_002));
      await market.write.outbid([cat.address, amount, 0n, 0n], { account: bob.account });
      expect(await market.read.topToken()).to.equal(getAddress(cat.address));

      // DOG has bid 1,000 already, so it pays only the difference to get back on top.
      expect(await market.read.getNextBid([dog.address])).to.equal(board(4));
      await market.write.outbid([dog.address, usdg(4), 0n, 0n], { account: alice.account });
      expect(await market.read.topToken()).to.equal(getAddress(dog.address));
      expect(await market.read.getTotalBid([cat.address])).to.equal(board(1_002));
      expect(await market.read.getTotalBid([dog.address])).to.equal(board(1_004));
    });

    it('fails when someone raised the bar first (race condition from spec §14)', async () => {
      const { market, coin, bid, alice, bob, carol } = await loadFixture(deployFixture);
      const dog = await coin();
      const cat = await coin();
      const fox = await coin();
      await bid(dog.address, alice, usdg(100));
      const [, quoted] = await market.read.getNextBidAmount([cat.address]);
      await market.write.outbid([fox.address, quoted, 0n, 0n], { account: carol.account });
      await expect(market.write.outbid([cat.address, quoted, 0n, 0n], { account: bob.account })).to.be.rejectedWith(
        'BidTooLow'
      );
    });

    it('does not let an equal bid overtake; the earlier position wins ties, and the board agrees (audit F-04)', async () => {
      const { market, coin, bid, alice, bob } = await loadFixture(deployFixture);
      const dog = await coin();
      const cat = await coin();
      await bid(dog.address, alice, usdg(100));
      await bid(cat.address, bob, usdg(150));
      await bid(dog.address, alice, usdg(50));
      const [first] = await market.read.getTopTokens([1n]);
      expect(await market.read.topToken()).to.equal(first);
      expect(first).to.equal(getAddress(dog.address));
    });

    it('rejects the zero address, an unknown token, an address with no code, and every bid without a registry', async () => {
      const { owner, registry, bid, alice, dollar, weth, poolManager, vault, treasury } = await loadFixture(deployFixture);
      await expect(bid(zeroAddress, alice, usdg(100))).to.be.rejectedWith('ZeroAddress');
      const stranger = await hre.viem.deployContract('MockBiddableCoin', [dollar.address, 1n]);
      await expect(bid(stranger.address, alice, usdg(100))).to.be.rejectedWith('TokenNotRegistered');
      const wallet = getAddress('0x00000000000000000000000000000000000000aa');
      await registry.write.setLegit([wallet, true]);
      await expect(bid(wallet, alice, usdg(100))).to.be.rejectedWith('TokenNotRegistered');

      const bare = await hre.viem.deployContract('OutbidMarket', [
        owner.account.address,
        dollar.address,
        weth.address,
        poolManager.address,
        vault.address,
        treasury.address,
        MIN_BID,
        INCREMENT,
      ]);
      await expect(bare.write.bid([stranger.address, usdg(100), 0n, 0n], { account: alice.account })).to.be.rejectedWith(
        'NoRegistry'
      );
    });
  });

  describe('paying with something else', () => {
    it('swaps ether to USDG in the bid, checks the minimum, and bids what it brought', async () => {
      const { market, coin, alice, publicClient, dollar, vault } = await loadFixture(deployFixture);
      const dog = await coin();
      const paid = parseEther('0.1'); // 300 USDG

      const hash = await market.write.bidWith([dog.address, zeroAddress, paid, usdg(300), 0n, 0n, false], {
        account: alice.account,
        value: paid,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      expect(await market.read.getTotalBid([dog.address])).to.equal(board(300));
      expect(await dollar.read.balanceOf([vault.address])).to.equal(usdg(60));
      const [event] = await market.getEvents.PaidWith({}, { blockHash: receipt.blockHash });
      expect(event!.args.assetIn).to.equal(zeroAddress);
      expect(event!.args.usdgOut).to.equal(usdg(300));
      // Nothing is left behind in the market.
      expect(await publicClient.getBalance({ address: market.address })).to.equal(0n);
      expect(await dollar.read.balanceOf([market.address])).to.equal(0n);
    });

    it('refuses a swap that brings less USDG than the bidder’s minimum, and the wrong value', async () => {
      const { market, coin, alice } = await loadFixture(deployFixture);
      const dog = await coin();
      const paid = parseEther('0.1');
      await expect(
        market.write.bidWith([dog.address, zeroAddress, paid, usdg(300) + 1n, 0n, 0n, false], { account: alice.account, value: paid })
      ).to.be.rejectedWith('InsufficientUsdg');
      await expect(
        market.write.bidWith([dog.address, zeroAddress, paid, 0n, 0n, 0n, false], { account: alice.account, value: paid - 1n })
      ).to.be.rejectedWith('WrongValue');
    });

    it('unwraps wrapped ether and swaps it through ether’s route', async () => {
      const { market, coin, alice, weth } = await loadFixture(deployFixture);
      const dog = await coin();
      const before = await weth.read.balanceOf([alice.account.address]);
      await market.write.bidWith([dog.address, weth.address, parseEther('0.2'), usdg(600), 0n, 0n, false], {
        account: alice.account,
      });
      expect(await market.read.getTotalBid([dog.address])).to.equal(board(600));
      expect(before - (await weth.read.balanceOf([alice.account.address]))).to.equal(parseEther('0.2'));
    });

    it('swaps a routed token, bids USDG as it is, and refuses an asset with no route', async () => {
      const { market, coin, alice, share, dollar, owner } = await loadFixture(deployFixture);
      const dog = await coin();
      await market.write.bidWith([dog.address, share.address, parseEther('2'), usdg(500), 0n, 0n, false], {
        account: alice.account,
      });
      expect(await market.read.getTotalBid([dog.address])).to.equal(board(500));

      await market.write.bidWith([dog.address, dollar.address, usdg(40), usdg(40), 0n, 0n, false], { account: alice.account });
      expect(await market.read.getTotalBid([dog.address])).to.equal(board(540));

      await market.write.clearRoute([share.address], { account: owner.account });
      await expect(
        market.write.bidWith([dog.address, share.address, parseEther('1'), 0n, 0n, 0n, false], { account: alice.account })
      ).to.be.rejectedWith('NoRoute');
    });

    it('swaps through several pools in a row: a token to ether, then ether to USDG', async () => {
      const { market, coin, alice, owner, poolManager, ethRoute } = await loadFixture(deployFixture);
      const dog = await coin();
      // A token that trades only against ether, at 0.2 ETH — 600 USDG through ether's own pool.
      const fund = await hre.viem.deployContract('MockERC20', ['Index Fund', 'SPY', 18, 0n]);
      await fund.write.mint([alice.account.address, parseEther('10')]);
      await fund.write.approve([market.address, 2n ** 255n], { account: alice.account });
      const fundRoute = { currency0: zeroAddress, currency1: fund.address, fee: 3_000, tickSpacing: 60, hooks: zeroAddress };
      await poolManager.write.setPrice([fundRoute, parseEther('5'), parseEther('1'), parseEther('0.2'), parseEther('1')]);
      await market.write.setRoute([fund.address, [fundRoute, ethRoute]], { account: owner.account });

      const route = await market.read.routeOf([fund.address]);
      expect(route.length).to.equal(2);
      const { result: quoted } = await market.simulate.quoteUsdg([fund.address, parseEther('2')]);
      expect(quoted).to.equal(usdg(1_200));

      const swaps = await poolManager.read.swapCount();
      await market.write.bidWith([dog.address, fund.address, parseEther('2'), usdg(1_200), 0n, 0n, false], {
        account: alice.account,
      });
      expect(await market.read.getTotalBid([dog.address])).to.equal(board(1_200));
      expect((await poolManager.read.swapCount()) - swaps).to.equal(2n);
      expect(await fund.read.balanceOf([alice.account.address])).to.equal(parseEther('8'));
      // The ether between the two pools netted out inside the session; none is left here.
      expect(await hre.viem.getPublicClient().then((client) => client.getBalance({ address: market.address }))).to.equal(0n);
    });

    it('returns what the first pool could not take, and refuses a route whose later pool is too shallow', async () => {
      const { market, coin, alice, owner, share, shareRoute, poolManager, ethRoute } = await loadFixture(deployFixture);
      const dog = await coin();
      // The share's pool takes at most 3 shares a swap; the other 1 of 4 comes back.
      await poolManager.write.setDepth([shareRoute, parseEther('3')]);
      const before = await share.read.balanceOf([alice.account.address]);
      await market.write.bidWith([dog.address, share.address, parseEther('4'), usdg(750), 0n, 0n, false], {
        account: alice.account,
      });
      expect(await market.read.getTotalBid([dog.address])).to.equal(board(750));
      expect(before - (await share.read.balanceOf([alice.account.address]))).to.equal(parseEther('3'));

      // Through ether, where ether's pool takes less than the first pool hands it.
      const fund = await hre.viem.deployContract('MockERC20', ['Index Fund', 'SPY', 18, 0n]);
      await fund.write.mint([alice.account.address, parseEther('10')]);
      await fund.write.approve([market.address, 2n ** 255n], { account: alice.account });
      const fundRoute = { currency0: zeroAddress, currency1: fund.address, fee: 3_000, tickSpacing: 60, hooks: zeroAddress };
      await poolManager.write.setPrice([fundRoute, parseEther('5'), parseEther('1'), parseEther('0.2'), parseEther('1')]);
      await market.write.setRoute([fund.address, [fundRoute, ethRoute]], { account: owner.account });
      await poolManager.write.setDepth([ethRoute, parseEther('0.1')]);
      await expect(market.simulate.quoteUsdg([fund.address, parseEther('2')])).to.be.rejectedWith('ShallowRoute');
      await expect(
        market.write.bidWith([dog.address, fund.address, parseEther('2'), 0n, 0n, 0n, false], { account: alice.account })
      ).to.be.rejectedWith('ShallowRoute');
    });

    it('takes the top only if what the swap brought covers the next bid', async () => {
      const { market, coin, bid, alice, bob } = await loadFixture(deployFixture);
      const dog = await coin();
      const cat = await coin();
      await bid(dog.address, alice, usdg(600));
      // 0.2 ETH brings 600 USDG; the top needs 602.
      await expect(
        market.write.bidWith([cat.address, zeroAddress, parseEther('0.2'), 0n, 0n, 0n, true], {
          account: bob.account,
          value: parseEther('0.2'),
        })
      ).to.be.rejectedWith('BidTooLow');
      await market.write.bidWith([cat.address, zeroAddress, parseEther('0.201'), 0n, 0n, 0n, true], {
        account: bob.account,
        value: parseEther('0.201'),
      });
      expect(await market.read.topToken()).to.equal(getAddress(cat.address));
    });

    it('quotes a swap to USDG without moving anything', async () => {
      const { market, share, weth, dollar } = await loadFixture(deployFixture);
      const { result: fromEth } = await market.simulate.quoteUsdg([zeroAddress, parseEther('0.5')]);
      expect(fromEth).to.equal(usdg(1_500));
      const { result: fromWeth } = await market.simulate.quoteUsdg([weth.address, parseEther('0.5')]);
      expect(fromWeth).to.equal(usdg(1_500));
      const { result: fromShare } = await market.simulate.quoteUsdg([share.address, parseEther('4')]);
      expect(fromShare).to.equal(usdg(1_000));
      const { result: fromUsdg } = await market.simulate.quoteUsdg([dollar.address, usdg(7)]);
      expect(fromUsdg).to.equal(usdg(7));
      const other = await hre.viem.deployContract('MockERC20', ['Other', 'OTH', 18, 0n]);
      await expect(market.simulate.quoteUsdg([other.address, 1n])).to.be.rejectedWith('NoRoute');
    });
  });

  describe('migration from the market this one replaces', () => {
    const position = (totalBid: bigint, firstBidAt: bigint, lastBidAt: bigint, lastBidder: Address) => ({
      totalBid,
      firstBidAt,
      lastBidAt,
      lastBidder,
    });

    it('carries the old board over as it stood, and bids build on it', async () => {
      const { market, coin, alice, bob, owner } = await loadFixture(deployFixture);
      const dog = await coin();
      const cat = await coin();
      const dogWas = position(board(100), 1_000n, 2_000n, getAddress(alice.account.address));
      const catWas = position(board(150), 1_100n, 1_100n, getAddress(bob.account.address));

      await market.write.migrate([[dog.address, cat.address], [dogWas, catWas]], { account: owner.account });

      expect(await market.read.getPosition([dog.address])).to.deep.equal(dogWas);
      expect(await market.read.getPosition([cat.address])).to.deep.equal(catWas);
      expect(await market.read.tokenCount()).to.equal(2n);
      expect(await market.read.tokenAt([0n])).to.equal(getAddress(dog.address));
      expect(await market.read.topToken()).to.equal(getAddress(cat.address));
      expect(await market.getEvents.PositionMigrated()).to.have.length(2);
      // DOG pays only the difference to the leader, plus the step, as it would have there.
      expect(await market.read.getNextBid([dog.address])).to.equal(board(52));

      await market.write.outbid([dog.address, usdg(52), 0n, 0n], { account: alice.account });
      expect(await market.read.topToken()).to.equal(getAddress(dog.address));
      expect(await market.read.getTotalBid([dog.address])).to.equal(board(152));
      expect((await market.read.getPosition([dog.address])).firstBidAt).to.equal(1_000n);
      expect(await market.read.migrationOpen()).to.equal(false);
      expect(await market.getEvents.MigrationEnded()).to.have.length(1);
      await expect(
        market.write.migrate([[cat.address], [catWas]], { account: owner.account })
      ).to.be.rejectedWith('MigrationOver');
    });

    it('breaks ties by the order given, and lets a board read again overwrite in place', async () => {
      const { market, coin, alice, owner } = await loadFixture(deployFixture);
      const dog = await coin();
      const cat = await coin();
      const who = getAddress(alice.account.address);

      await market.write.migrate(
        [[dog.address, cat.address], [position(board(100), 1_000n, 1_000n, who), position(board(100), 1_000n, 1_000n, who)]],
        { account: owner.account }
      );
      expect(await market.read.topToken()).to.equal(getAddress(dog.address));

      // Read again after the old market froze: CAT had moved on. It keeps its place in the order.
      await market.write.migrate([[cat.address], [position(board(120), 1_000n, 1_500n, who)]], { account: owner.account });
      expect(await market.read.tokenCount()).to.equal(2n);
      expect(await market.read.tokenAt([1n])).to.equal(getAddress(cat.address));
      expect(await market.read.topToken()).to.equal(getAddress(cat.address));
      const [first] = await market.read.getTopTokens([1n]);
      expect(first).to.equal(getAddress(cat.address));
    });

    it('refuses anyone but the owner, a malformed board, and anything once closed', async () => {
      const { market, coin, alice, owner } = await loadFixture(deployFixture);
      const dog = await coin();
      const who = getAddress(alice.account.address);
      const fine = position(board(10), 1_000n, 1_000n, who);

      await expect(market.write.migrate([[dog.address], [fine]], { account: alice.account })).to.be.rejectedWith(
        'OwnableUnauthorizedAccount'
      );
      await expect(market.write.migrate([[dog.address], []], { account: owner.account })).to.be.rejectedWith('BadMigration');
      await expect(market.write.migrate([[zeroAddress], [fine]], { account: owner.account })).to.be.rejectedWith('BadMigration');
      await expect(
        market.write.migrate([[dog.address], [{ ...fine, totalBid: 0n }]], { account: owner.account })
      ).to.be.rejectedWith('BadMigration');
      await expect(
        market.write.migrate([[dog.address], [{ ...fine, firstBidAt: 0n }]], { account: owner.account })
      ).to.be.rejectedWith('BadMigration');

      await expect(market.write.closeMigration({ account: alice.account })).to.be.rejectedWith('OwnableUnauthorizedAccount');
      await market.write.closeMigration({ account: owner.account });
      await expect(market.write.migrate([[dog.address], [fine]], { account: owner.account })).to.be.rejectedWith('MigrationOver');
      await expect(market.write.closeMigration({ account: owner.account })).to.be.rejectedWith('MigrationOver');
    });
  });

  describe('getTopTokens', () => {
    it('sorts at most MAX_TOP_TOKENS, and pages the rest (audit F-05)', async () => {
      const { market, coin, bid, alice } = await loadFixture(deployFixture);
      const cap = Number(await market.read.MAX_TOP_TOKENS());
      const count = cap + 5;
      const tokens: Address[] = [];
      for (let i = 0; i < count; i++) {
        const deployed = await coin();
        tokens.push(getAddress(deployed.address));
        await bid(deployed.address, alice, usdg(i + 1));
      }

      const top = await market.read.getTopTokens([BigInt(count)]);
      expect(top).to.have.lengthOf(cap);
      expect(top[0]).to.equal(tokens[count - 1]);
      expect(await market.read.tokenCount()).to.equal(BigInt(count));
      const [firstPage, positions] = await market.read.getPositions([0n, 20n]);
      expect(firstPage).to.deep.equal(tokens.slice(0, 20));
      expect(positions[0]!.totalBid).to.equal(MIN_BID);
      const [lastPage] = await market.read.getPositions([40n, 100n]);
      expect(lastPage).to.deep.equal(tokens.slice(40));
      const [beyond] = await market.read.getPositions([BigInt(count), 10n]);
      expect(beyond).to.deep.equal([]);
    });
  });

  describe('admin', () => {
    it('restricts configuration to the owner', async () => {
      const { market, alice, ethRoute } = await loadFixture(deployFixture);
      const as = { account: alice.account };
      const who = alice.account.address;
      await expect(market.write.setRegistry([who], as)).to.be.rejectedWith('OwnableUnauthorizedAccount');
      await expect(market.write.setDestinations([who, who], as)).to.be.rejectedWith('OwnableUnauthorizedAccount');
      await expect(market.write.setSplit([7_500, 2_000, 500], as)).to.be.rejectedWith('OwnableUnauthorizedAccount');
      await expect(market.write.setRoute([zeroAddress, [ethRoute]], as)).to.be.rejectedWith('OwnableUnauthorizedAccount');
      await expect(market.write.clearRoute([zeroAddress], as)).to.be.rejectedWith('OwnableUnauthorizedAccount');
      await expect(market.write.setMinBid([1n], as)).to.be.rejectedWith('OwnableUnauthorizedAccount');
      await expect(market.write.setOutbidIncrement([1n], as)).to.be.rejectedWith('OwnableUnauthorizedAccount');
    });

    it('validates the split, the destinations, the step and every route', async () => {
      const { market, owner, alice, bob, dollar, weth, share, ethRoute } = await loadFixture(deployFixture);
      const as = { account: owner.account };
      await expect(market.write.setSplit([7_500, 2_000, 400], as)).to.be.rejectedWith('InvalidSplit');
      await market.write.setSplit([6_000, 3_000, 1_000], as);
      expect(await market.read.buybackBps()).to.equal(3_000);
      await expect(market.write.setDestinations([zeroAddress, bob.account.address], as)).to.be.rejectedWith('ZeroAddress');
      await market.write.setDestinations([alice.account.address, bob.account.address], as);
      await expect(market.write.setOutbidIncrement([0n], as)).to.be.rejectedWith('InvalidIncrement');

      // USDG needs no route and wrapped ether uses ether's; a route must step from its asset to
      // USDG, pool by pool, each key in the PoolManager's sorted order.
      await expect(market.write.setRoute([dollar.address, [ethRoute]], as)).to.be.rejectedWith('BadRoute');
      await expect(market.write.setRoute([weth.address, [ethRoute]], as)).to.be.rejectedWith('BadRoute');
      await expect(market.write.setRoute([share.address, [ethRoute]], as)).to.be.rejectedWith('BadRoute');
      await expect(
        market.write.setRoute([zeroAddress, [{ ...ethRoute, currency0: dollar.address, currency1: zeroAddress }]], as)
      ).to.be.rejectedWith('BadRoute');
      await expect(market.write.setRoute([share.address, []], as)).to.be.rejectedWith('BadRoute');

      const sorted = (a: Address, b: Address) =>
        (a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]) as [Address, Address];
      const pool = (a: Address, b: Address) => {
        const [currency0, currency1] = sorted(a, b);
        return { currency0, currency1, fee: 3_000, tickSpacing: 60, hooks: zeroAddress };
      };
      const shareEth = pool(share.address, zeroAddress);
      const shareUsdg = pool(share.address, dollar.address);
      const ethWeth = pool(zeroAddress, weth.address);
      const wethUsdg = pool(weth.address, dollar.address);
      // USDG in the middle, a step back through the asset, a gap, and one pool too many.
      await expect(market.write.setRoute([share.address, [shareUsdg, pool(dollar.address, zeroAddress)]], as)).to.be.rejectedWith('BadRoute');
      await expect(market.write.setRoute([share.address, [shareEth, shareEth]], as)).to.be.rejectedWith('BadRoute');
      await expect(market.write.setRoute([share.address, [shareEth, wethUsdg]], as)).to.be.rejectedWith('BadRoute');
      await expect(market.write.setRoute([share.address, [shareEth, ethWeth, wethUsdg, wethUsdg]], as)).to.be.rejectedWith('BadRoute');
      // Three pools: the share to ether, ether to wrapped ether, wrapped ether to USDG.
      await market.write.setRoute([share.address, [shareEth, ethWeth, wethUsdg]], as);
      expect((await market.read.routeOf([share.address])).length).to.equal(3);

      const route = await market.read.routeOf([zeroAddress]);
      expect(route.length).to.equal(1);
      expect(route[0]!.fee).to.equal(500);
    });

    it('answers only its own sessions and swaps, and takes ether only from WETH', async () => {
      const { market, alice } = await loadFixture(deployFixture);
      await expect(market.write.unlockCallback(['0x'], { account: alice.account })).to.be.rejectedWith('UnexpectedCaller');
      await expect(market.write.uniswapV3SwapCallback([1n, 0n, '0x'], { account: alice.account })).to.be.rejectedWith(
        'UnexpectedCaller'
      );
      await expect(alice.sendTransaction({ to: market.address, value: 1n })).to.be.rejected;
    });
  });
});
