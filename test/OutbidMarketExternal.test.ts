import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { encodeFunctionData, getAddress, parseEther, parseEventLogs, parseUnits, zeroAddress, type Address } from 'viem';
import { deployMarket } from './helpers/market';

/** USDG has six decimals; the board states bids at eighteen. */
const usdg = (amount: number | string) => parseUnits(String(amount), 6);
const board = (amount: number | string) => parseEther(String(amount));
const MIN_BID = board(1);
const INCREMENT = board(2);
/** `PonsTokenRegistry.Kind`. */
const LAUNCH = 0;
const V2 = 1;

async function deployFixture() {
  const [owner, alice, bob] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const dollar = await hre.viem.deployContract('MockERC20', ['Global Dollar', 'USDG', 6, 0n]);
  const weth = await hre.viem.deployContract('WETH9', []);
  const poolManager = await hre.viem.deployContract('MockPoolManagerV4', []);
  // Stand-ins for the buyback vault and the treasury: anything that can hold a token, with no
  // `enabled`, so the buyback share is paid to the vault as it is before $OUTBID launches.
  const vault = await hre.viem.deployContract('Treasury', [owner!.account.address]);
  const treasury = await hre.viem.deployContract('Treasury', [owner!.account.address]);
  const registry = await hre.viem.deployContract('MockTokenRegistry', []);

  // PONS: its main factory, and its V2 factory, each launching coins of their own.
  const ponsFactory = await hre.viem.deployContract('MockPonsLaunchFactory', []);
  const ponsV2Factory = await hre.viem.deployContract('MockPonsFactory', [zeroAddress, zeroAddress]);
  const pons = await hre.viem.deployContract('PonsTokenRegistry', [
    owner!.account.address,
    [{ factory: ponsFactory.address, kind: LAUNCH }],
  ]);

  const market = await deployMarket([
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
  await market.write.setExternalRegistry([pons.address]);

  for (const wallet of [alice!, bob!]) {
    await dollar.write.mint([wallet.account.address, usdg(1_000_000)]);
    await dollar.write.approve([market.address, 2n ** 255n], { account: wallet.account });
  }

  /** A coin of the launchpad's own, on its curve, priced in USDG. */
  async function internalCoin() {
    const coin = await hre.viem.deployContract('MockBiddableCoin', [dollar.address, 1_000n]);
    await registry.write.setLegit([coin.address, true]);
    return coin;
  }
  /** A coin PONS's main factory launched: a plain ERC-20, with nothing of ours to buy. */
  async function ponsCoin(symbol = 'CWF') {
    const coin = await hre.viem.deployContract('MockERC20', [symbol, symbol, 18, parseEther('1000000000')]);
    await ponsFactory.write.setLaunched([coin.address, true]);
    return coin;
  }

  type Wallet = typeof alice;
  async function bid(token: Address, wallet: Wallet, amount: bigint, minCoinsOut = 0n) {
    const hash = await market.write.bid([token, amount, minCoinsOut, 0n], { account: wallet!.account });
    return publicClient.waitForTransactionReceipt({ hash });
  }

  return {
    owner: owner!,
    alice: alice!,
    bob: bob!,
    publicClient,
    dollar,
    weth,
    poolManager,
    vault,
    treasury,
    registry,
    ponsFactory,
    ponsV2Factory,
    pons,
    market,
    internalCoin,
    ponsCoin,
    bid,
  };
}

describe('PonsTokenRegistry', () => {
  it('lists what a PONS factory launched, and nothing else', async () => {
    const { pons, ponsCoin, internalCoin, dollar } = await loadFixture(deployFixture);
    const cwf = await ponsCoin();
    const ours = await internalCoin();
    expect(await pons.read.isMemeCoinLegit([cwf.address])).to.equal(true);
    expect(await pons.read.isMemeCoinLegit([ours.address])).to.equal(false);
    expect(await pons.read.isMemeCoinLegit([dollar.address])).to.equal(false);
    expect(await pons.read.isMemeCoinLegit([zeroAddress])).to.equal(false);
  });

  it('reads each kind of factory its own way, and a factory of the wrong shape answers no', async () => {
    const { pons, ponsV2Factory, dollar } = await loadFixture(deployFixture);
    const curveCoin = await hre.viem.deployContract('MockERC20', ['On a curve', 'CURVE', 18, 0n]);
    await ponsV2Factory.write.setLaunch([curveCoin.address, zeroAddress, zeroAddress, 10_000, 200]);
    expect(await pons.read.isMemeCoinLegit([curveCoin.address])).to.equal(false);

    // Listed as the wrong kind, the V2 factory's longer answer is not read as a launch.
    await pons.write.addFactory([ponsV2Factory.address, LAUNCH]);
    expect(await pons.read.isMemeCoinLegit([curveCoin.address])).to.equal(false);
    await pons.write.removeFactory([ponsV2Factory.address]);
    await pons.write.addFactory([ponsV2Factory.address, V2]);
    expect(await pons.read.isMemeCoinLegit([curveCoin.address])).to.equal(true);

    // A factory that has no such function, or is not a contract at all, answers no without failing.
    await pons.write.addFactory([dollar.address, LAUNCH]);
    await pons.write.addFactory([getAddress('0x00000000000000000000000000000000000000aa'), LAUNCH]);
    const stranger = await hre.viem.deployContract('MockERC20', ['Nobody', 'NOPE', 18, 0n]);
    expect(await pons.read.isMemeCoinLegit([stranger.address])).to.equal(false);
    expect(await pons.read.isMemeCoinLegit([curveCoin.address])).to.equal(true);
  });

  it('lets only the owner list and delist factories, each once, up to the cap', async () => {
    const { pons, alice, ponsFactory } = await loadFixture(deployFixture);
    await expect(pons.write.addFactory([ponsFactory.address, LAUNCH], { account: alice.account })).to.be.rejectedWith(
      'OwnableUnauthorizedAccount'
    );
    await expect(pons.write.addFactory([ponsFactory.address, LAUNCH])).to.be.rejectedWith('AlreadyListed');
    await expect(pons.write.addFactory([zeroAddress, LAUNCH])).to.be.rejectedWith('ZeroAddress');
    await expect(pons.write.removeFactory([alice.account.address])).to.be.rejectedWith('NotListed');
    for (let i = 1; i < 8; i++) {
      await pons.write.addFactory([getAddress(`0x${i.toString(16).padStart(40, '0')}`), LAUNCH]);
    }
    await expect(pons.write.addFactory([getAddress('0x00000000000000000000000000000000000000ff'), LAUNCH])).to.be.rejectedWith(
      'TooManyFactories'
    );
    expect((await pons.read.factories()).length).to.equal(8);
    await pons.write.removeFactory([ponsFactory.address]);
    expect((await pons.read.factories()).map((entry) => entry.factory)).to.not.include(getAddress(ponsFactory.address));
  });
});

describe('OutbidMarket with external coins', () => {
  it('starts external coins at 80 / 20, and only the owner changes that or the registry', async () => {
    const { market, alice, pons } = await loadFixture(deployFixture);
    expect(await market.read.externalBuybackBps()).to.equal(8_000);
    expect(await market.read.externalTreasuryBps()).to.equal(2_000);
    expect(await market.read.externalRegistry()).to.equal(getAddress(pons.address));
    await expect(market.write.setExternalSplit([7_000, 2_000])).to.be.rejectedWith('InvalidSplit');
    await expect(market.write.setExternalSplit([9_000, 1_000], { account: alice.account })).to.be.rejectedWith(
      'OwnableUnauthorizedAccount'
    );
    await expect(market.write.setExternalRegistry([zeroAddress], { account: alice.account })).to.be.rejectedWith(
      'OwnableUnauthorizedAccount'
    );
    await market.write.setExternalSplit([9_000, 1_000]);
    expect(await market.read.externalBuybackBps()).to.equal(9_000);
  });

  it('splits a bid on a PONS coin 80% to the buyback and 20% to the treasury, buying none of it', async () => {
    const { market, ponsCoin, bid, alice, dollar, vault, treasury } = await loadFixture(deployFixture);
    const cwf = await ponsCoin();
    const amount = usdg(1_001); // not a round split: the dust is the buyback's
    const receipt = await bid(cwf.address, alice, amount);

    const toTreasury = (amount * 2_000n) / 10_000n;
    const toBuyback = amount - toTreasury;
    expect(await dollar.read.balanceOf([vault.address])).to.equal(toBuyback);
    expect(await dollar.read.balanceOf([treasury.address])).to.equal(toTreasury);
    expect(await dollar.read.balanceOf([market.address])).to.equal(0n);
    expect(await cwf.read.balanceOf([market.address])).to.equal(0n);

    const [settled] = parseEventLogs({ abi: market.abi, eventName: 'BidSettled', logs: receipt.logs });
    expect(settled!.args.token).to.equal(getAddress(cwf.address));
    expect(settled!.args.burnSpent).to.equal(0n);
    expect(settled!.args.coinsBurned).to.equal(0n);
    expect(settled!.args.toBuyback).to.equal(toBuyback);
    expect(settled!.args.toTreasury).to.equal(toTreasury);
    expect((await market.read.getPosition([cwf.address])).totalBid).to.equal(board(1_001));
  });

  it('ranks external and internal coins on one board, by what each has been bid in all', async () => {
    const { market, ponsCoin, internalCoin, bid, alice, bob } = await loadFixture(deployFixture);
    const cwf = await ponsCoin();
    const ours = await internalCoin();
    await bid(ours.address, alice, usdg(10));
    expect(await market.read.topToken()).to.equal(getAddress(ours.address));
    // Any amount from the minimum is a bid: 3 USDG does not take #1, and is taken.
    await bid(cwf.address, bob, usdg(3));
    expect(await market.read.topToken()).to.equal(getAddress(ours.address));
    await bid(cwf.address, bob, usdg(8));
    expect(await market.read.topToken()).to.equal(getAddress(cwf.address));
    expect(await market.read.getTopTokens([2n])).to.deep.equal([getAddress(cwf.address), getAddress(ours.address)]);
  });

  it('keeps an internal coin internal even when the external registry would claim it too', async () => {
    const { internalCoin, ponsFactory, bid, alice, dollar, vault, treasury } = await loadFixture(deployFixture);
    const ours = await internalCoin();
    await ponsFactory.write.setLaunched([ours.address, true]);
    const amount = usdg(100);
    await bid(ours.address, alice, amount);
    // 75 / 20 / 5: the buyback gets 20, the treasury 5, and the rest bought the coin.
    expect(await dollar.read.balanceOf([vault.address])).to.equal(usdg(20));
    expect(await dollar.read.balanceOf([treasury.address])).to.equal(usdg(5));
    expect(await dollar.read.balanceOf([ours.address])).to.equal(usdg(75));
  });

  it('refuses a burn route or a coin minimum for an external coin, and a coin neither registry lists', async () => {
    const { market, ponsCoin, bid, alice, dollar } = await loadFixture(deployFixture);
    const cwf = await ponsCoin();
    await expect(bid(cwf.address, alice, usdg(10), 1n)).to.be.rejectedWith('ExcessiveSlippage');
    await expect(
      market.write.bidVia(
        [
          cwf.address,
          { asset: dollar.address, amount: usdg(10), minUsdg: usdg(10), legs: [] },
          [{ shareBps: 10_000, steps: [] }],
          0n,
          0n,
          false,
        ],
        { account: alice.account }
      )
    ).to.be.rejectedWith('NotBurnable');
    const stranger = await hre.viem.deployContract('MockERC20', ['Nobody', 'NOPE', 18, 0n]);
    await expect(bid(stranger.address, alice, usdg(10))).to.be.rejectedWith('TokenNotRegistered');
  });

  it('takes external coins with no launchpad registry, and refuses every bid with neither', async () => {
    const { market, ponsCoin, internalCoin, bid, alice } = await loadFixture(deployFixture);
    const cwf = await ponsCoin();
    const ours = await internalCoin();
    await market.write.setRegistry([zeroAddress]);
    await bid(cwf.address, alice, usdg(5));
    await expect(bid(ours.address, alice, usdg(5))).to.be.rejectedWith('TokenNotRegistered');
    await market.write.setExternalRegistry([zeroAddress]);
    await expect(bid(cwf.address, alice, usdg(5))).to.be.rejectedWith('NoRegistry');
  });
});

describe('OutbidMarket behind its proxy', () => {
  it('cannot be initialized again, nor its implementation at all', async () => {
    const { market, owner, dollar, weth, poolManager, vault, treasury } = await loadFixture(deployFixture);
    const args = [owner.account.address, dollar.address, weth.address, poolManager.address, vault.address, treasury.address, MIN_BID, INCREMENT] as const;
    await expect(market.write.initialize([...args])).to.be.rejectedWith('InvalidInitialization');
    await expect(market.implementation.write.initialize([...args])).to.be.rejectedWith('InvalidInitialization');
  });

  it('upgrades only for its owner, keeping the board, and refuses a target that is not UUPS', async () => {
    const { market, alice, bob, ponsCoin, internalCoin, bid, dollar } = await loadFixture(deployFixture);
    const cwf = await ponsCoin();
    const ours = await internalCoin();
    await bid(ours.address, alice, usdg(10));
    await bid(cwf.address, bob, usdg(25));

    const next = await hre.viem.deployContract('OutbidMarket', []);
    await expect(market.write.upgradeToAndCall([next.address, '0x'], { account: alice.account })).to.be.rejectedWith(
      'OwnableUnauthorizedAccount'
    );
    await expect(market.write.upgradeToAndCall([dollar.address, '0x'])).to.be.rejected;
    await market.write.upgradeToAndCall([next.address, '0x']);

    const slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
    const publicClient = await hre.viem.getPublicClient();
    const stored = await publicClient.getStorageAt({ address: market.address, slot });
    expect(getAddress(`0x${stored!.slice(-40)}`)).to.equal(getAddress(next.address));
    expect(await market.read.topToken()).to.equal(getAddress(cwf.address));
    expect((await market.read.getPosition([ours.address])).totalBid).to.equal(board(10));
    expect(await market.read.externalBuybackBps()).to.equal(8_000);
    // And it still takes bids, on both kinds of coin.
    await bid(ours.address, alice, usdg(20));
    expect(await market.read.topToken()).to.equal(getAddress(ours.address));
  });

  it('upgrades and calls in one step, for a later version that needs setting up', async () => {
    const { market } = await loadFixture(deployFixture);
    const next = await hre.viem.deployContract('OutbidMarket', []);
    const data = encodeFunctionData({ abi: market.abi, functionName: 'setMinBid', args: [board(5)] });
    await market.write.upgradeToAndCall([next.address, data]);
    expect(await market.read.minBid()).to.equal(board(5));
  });
});
