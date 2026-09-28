import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { encodeAbiParameters, getAddress, parseEther, parseUnits, zeroAddress, type Address } from 'viem';

const COOLDOWN = 6n * 60n * 60n; // 6 hours
const POOL_FEE = 10_000; // 1%, for the platform's own V3 pools
const ETHER = zeroAddress;
const DEAD = '0x000000000000000000000000000000000000dEaD';

/** PONS's phases. */
const SWEPT = 1;
const POOL_CREATED = 2;

/** The curve sells 1,000 OUTBID per USDG; the graduated pool 900; the route 3,000 USDG per ether. */
const USDG = (whole: number | string) => parseUnits(String(whole), 6);
const CURVE_PER_USDG = parseEther('1000');
const CURVE_STOCK = parseEther('5000000');

async function soon() {
  return BigInt(await time.latest()) + 3600n;
}

async function deployFixture() {
  const [owner, funder, keeper, outsider, hook] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const weth = await hre.viem.deployContract('WETH9', []);
  const v3Factory = await hre.viem.deployContract('UniswapV3Factory', []);
  const usdg = await hre.viem.deployContract('MockERC20', ['Global Dollar', 'USDG', 6, 0n]);
  // $OUTBID as PONS mints it: burnable, all supply to the launcher here.
  const outbid = await hre.viem.deployContract('MockBurnableToken', ['Outbid', 'OUTBID', parseEther('1000000000')]);

  // PONS: a PoolManager, a factory that knows the launch, and a USDG curve with 5M OUTBID left.
  const poolManager = await hre.viem.deployContract('MockPoolManagerV4', []);
  const pons = await hre.viem.deployContract('MockPonsFactory', [poolManager.address, hook!.account.address]);
  const curve = await hre.viem.deployContract('MockPonsCurve', [outbid.address, usdg.address, 6, CURVE_PER_USDG]);
  await outbid.write.approve([curve.address, CURVE_STOCK]);
  await curve.write.stock([CURVE_STOCK]);
  await pons.write.setLaunch([outbid.address, curve.address, usdg.address, 0, 200]);

  // The graduated pool PONS keys with its hook, and a plain ETH/USDG pool for the route.
  const [c0, c1] = usdg.address.toLowerCase() < outbid.address.toLowerCase() ? [usdg.address, outbid.address] : [outbid.address, usdg.address];
  const ponsPool = { currency0: c0, currency1: c1, fee: 0, tickSpacing: 200, hooks: hook!.account.address };
  const usdgIsZero = c0 === usdg.address;
  await poolManager.write.setPrice([
    ponsPool,
    usdgIsZero ? parseEther('900') : USDG(1),
    usdgIsZero ? USDG(1) : parseEther('900'),
    usdgIsZero ? USDG(1) : parseEther('900'),
    usdgIsZero ? parseEther('900') : USDG(1),
  ]);
  const ethRoute = { currency0: ETHER, currency1: usdg.address, fee: 500, tickSpacing: 10, hooks: zeroAddress };
  await poolManager.write.setPrice([ethRoute, USDG(3000), parseEther('1'), parseEther('1'), USDG(3000)]);
  // The manager pays out of what it holds.
  await usdg.write.mint([poolManager.address, USDG(1_000_000)]);
  await outbid.write.transfer([poolManager.address, parseEther('100000000')]);

  const venue = await hre.viem.deployContract('PonsBuybackVenue', [owner!.account.address, pons.address]);
  await venue.write.setRoute([ETHER, ethRoute]);

  const buyback = await hre.viem.deployContract('OutbidBuyback', [
    owner!.account.address,
    weth.address,
    v3Factory.address,
    COOLDOWN,
  ]);
  await buyback.write.setKeeper([keeper!.account.address, true]);

  // Revenue the router has released: ether and dollars.
  await funder!.sendTransaction({ to: buyback.address, value: parseEther('100') });
  await usdg.write.mint([buyback.address, USDG(10_000)]);

  return { owner, funder, keeper, outsider, hook, publicClient, weth, v3Factory, usdg, outbid, poolManager, pons, curve, venue, buyback, ponsPool, ethRoute };
}

async function enabledFixture() {
  const fixture = await deployFixture();
  await fixture.buyback.write.enableBuyback([fixture.outbid.address, fixture.venue.address]);
  return fixture;
}

describe('OutbidBuyback', () => {
  it('collects revenue before $OUTBID exists, and cannot spend it', async () => {
    const { buyback, usdg, keeper, venue } = await loadFixture(deployFixture);
    expect(await buyback.read.enabled()).to.equal(false);
    expect(await buyback.read.outbidToken()).to.equal(zeroAddress);
    expect(await buyback.read.pendingBuyback()).to.equal(parseEther('100'));
    expect(await buyback.read.heldOf([usdg.address])).to.equal(USDG(10_000));
    await expect(
      buyback.write.executeBuyback([usdg.address, USDG(100), 1n, await soon()], { account: keeper!.account })
    ).to.be.rejectedWith('NotEnabled');
    await expect(buyback.write.setVenue([venue.address])).to.be.rejectedWith('NotEnabled');
  });

  it('is enabled once, by the owner, and the token never changes', async () => {
    const { buyback, outbid, venue, usdg, outsider } = await loadFixture(deployFixture);
    await expect(
      buyback.write.enableBuyback([outbid.address, venue.address], { account: outsider!.account })
    ).to.be.rejectedWith('OwnableUnauthorizedAccount');
    await expect(buyback.write.enableBuyback([zeroAddress, venue.address])).to.be.rejectedWith('ZeroAddress');

    await buyback.write.enableBuyback([outbid.address, venue.address]);
    expect(await buyback.read.enabled()).to.equal(true);
    expect(getAddress(await buyback.read.outbidToken())).to.equal(getAddress(outbid.address));
    const [enabled] = await buyback.getEvents.BuybackEnabled(undefined, { fromBlock: 0n });
    expect(getAddress(enabled!.args.token!)).to.equal(getAddress(outbid.address));

    await expect(buyback.write.enableBuyback([usdg.address, venue.address])).to.be.rejectedWith('AlreadyEnabled');
    // The venue can move with the market; the token cannot.
    await buyback.write.setVenue([outsider!.account.address]);
    expect(getAddress(await buyback.read.venue())).to.equal(getAddress(outsider!.account.address));
    await expect(buyback.write.setVenue([venue.address], { account: outsider!.account })).to.be.rejectedWith(
      'OwnableUnauthorizedAccount'
    );
  });

  it('buys on the PONS curve with the pair asset and burns every token', async () => {
    const { buyback, usdg, outbid, keeper, venue } = await loadFixture(enabledFixture);
    const supplyBefore = await outbid.read.totalSupply();

    await buyback.write.executeBuyback([usdg.address, USDG(1000), parseEther('1000000'), await soon()], {
      account: keeper!.account,
    });

    const bought = parseEther('1000000'); // 1,000 USDG at 1,000 OUTBID each
    expect(await outbid.read.totalSupply()).to.equal(supplyBefore - bought);
    expect(await outbid.read.balanceOf([buyback.address])).to.equal(0n);
    expect(await buyback.read.heldOf([usdg.address])).to.equal(USDG(9000));
    expect(await buyback.read.totalSpent([usdg.address])).to.equal(USDG(1000));
    expect(await buyback.read.totalOutbidBurned()).to.equal(bought);
    expect(await buyback.read.buybackCount()).to.equal(1n);
    // The venue keeps nothing.
    expect(await usdg.read.balanceOf([venue.address])).to.equal(0n);

    const [event] = await buyback.getEvents.BuybackExecuted(undefined, { fromBlock: 0n });
    expect(getAddress(event!.args.keeper!)).to.equal(getAddress(keeper!.account.address));
    expect(getAddress(event!.args.assetIn!)).to.equal(getAddress(usdg.address));
    expect(event!.args.amountIn).to.equal(USDG(1000));
    expect(event!.args.outbidBurned).to.equal(bought);
  });

  it('lets anyone pay in and burn at once, without a keeper or the cooldown', async () => {
    const { buyback, usdg, outsider } = await loadFixture(deployFixture);
    await usdg.write.mint([outsider!.account.address, USDG(100)]);
    await usdg.write.approve([buyback.address, USDG(100)], { account: outsider!.account });
    await expect(
      buyback.write.buyNow([usdg.address, USDG(10), 1n], { account: outsider!.account })
    ).to.be.rejectedWith('NotEnabled');

    const { buyback: live, usdg: dollars, outbid: token, outsider: payer } = await loadFixture(enabledFixture);
    await dollars.write.mint([payer!.account.address, USDG(100)]);
    await dollars.write.approve([live.address, USDG(100)], { account: payer!.account });
    await expect(live.write.buyNow([dollars.address, USDG(10), 0n], { account: payer!.account })).to.be.rejectedWith(
      'NoMinimumOut'
    );
    await expect(live.write.buyNow([zeroAddress, 1n, 1n], { account: payer!.account })).to.be.rejectedWith('NotSpendable');
    const held = await live.read.heldOf([dollars.address]);
    const supply = await token.read.totalSupply();
    // 10 USDG at 1,000 OUTBID each, from the payer's own dollars; the vault's are untouched.
    await live.write.buyNow([dollars.address, USDG(10), parseEther('10000')], { account: payer!.account });
    expect(supply - (await token.read.totalSupply())).to.equal(parseEther('10000'));
    expect(await live.read.heldOf([dollars.address])).to.equal(held);
    // No keeper ran, so the keeper's cooldown has not started.
    expect(await live.read.lastBuybackAt()).to.equal(0n);
  });

  it('swaps ether into the pair, then buys on the curve', async () => {
    const { buyback, outbid, usdg, keeper, venue, publicClient } = await loadFixture(enabledFixture);
    const supplyBefore = await outbid.read.totalSupply();

    await buyback.write.executeBuyback([ETHER, parseEther('1'), parseEther('3000000'), await soon()], {
      account: keeper!.account,
    });

    // 1 ether → 3,000 USDG through the route → 3,000,000 OUTBID on the curve.
    expect(await outbid.read.totalSupply()).to.equal(supplyBefore - parseEther('3000000'));
    expect(await buyback.read.pendingBuyback()).to.equal(parseEther('99'));
    expect(await buyback.read.totalSpent([ETHER])).to.equal(parseEther('1'));
    expect(await publicClient.getBalance({ address: venue.address })).to.equal(0n);
    expect(await usdg.read.balanceOf([venue.address])).to.equal(0n);
  });

  it('keeps what the curve could not fill', async () => {
    const { buyback, usdg, outbid, keeper } = await loadFixture(enabledFixture);
    const supplyBefore = await outbid.read.totalSupply();
    // 6,000 USDG would be 6M OUTBID; the curve has 5M left, so it fills 5M for 5,000 and refunds 1,000.
    await buyback.write.executeBuyback([usdg.address, USDG(6000), CURVE_STOCK, await soon()], {
      account: keeper!.account,
    });
    expect(await outbid.read.totalSupply()).to.equal(supplyBefore - CURVE_STOCK);
    expect(await buyback.read.heldOf([usdg.address])).to.equal(USDG(5000));
    expect(await buyback.read.totalSpent([usdg.address])).to.equal(USDG(5000));
  });

  it('buys in the graduated V4 pool once PONS has pooled it, in one session for two hops', async () => {
    const { buyback, usdg, outbid, keeper, curve, pons, poolManager, venue, publicClient } =
      await loadFixture(enabledFixture);
    await curve.write.setGraduated([true]);
    await pons.write.setPhase([outbid.address, POOL_CREATED]);
    const supplyBefore = await outbid.read.totalSupply();

    await buyback.write.executeBuyback([usdg.address, USDG(1000), parseEther('900000'), await soon()], {
      account: keeper!.account,
    });
    expect(await poolManager.read.swapCount()).to.equal(1n);
    expect(await outbid.read.totalSupply()).to.equal(supplyBefore - parseEther('900000'));

    await time.increase(Number(COOLDOWN));
    await buyback.write.executeBuyback([ETHER, parseEther('1'), parseEther('2700000'), await soon()], {
      account: keeper!.account,
    });
    // Ether → USDG → OUTBID: two swaps inside one unlock, nothing left over anywhere.
    expect(await poolManager.read.swapCount()).to.equal(3n);
    expect(await outbid.read.totalSupply()).to.equal(supplyBefore - parseEther('900000') - parseEther('2700000'));
    expect(await buyback.read.totalOutbidBurned()).to.equal(parseEther('3600000'));
    expect(await usdg.read.balanceOf([venue.address])).to.equal(0n);
    expect(await publicClient.getBalance({ address: venue.address })).to.equal(0n);
  });

  it('will not buy while PONS is between the curve and the pool', async () => {
    const { buyback, usdg, outbid, keeper, curve, pons } = await loadFixture(enabledFixture);
    await curve.write.setGraduated([true]);
    await pons.write.setPhase([outbid.address, SWEPT]);
    await expect(
      buyback.write.executeBuyback([usdg.address, USDG(100), 1n, await soon()], { account: keeper!.account })
    ).to.be.rejectedWith('NotTradable');
  });

  it('needs a route for anything that is not the pair', async () => {
    const { buyback, venue, weth, keeper, funder } = await loadFixture(enabledFixture);
    await venue.write.clearRoute([ETHER]);
    await expect(
      buyback.write.executeBuyback([ETHER, parseEther('1'), 1n, await soon()], { account: keeper!.account })
    ).to.be.rejectedWith('NoRoute');
    await weth.write.deposit({ value: parseEther('1'), account: funder!.account });
    await weth.write.transfer([buyback.address, parseEther('1')], { account: funder!.account });
    await expect(
      buyback.write.executeBuyback([weth.address, parseEther('1'), 1n, await soon()], { account: keeper!.account })
    ).to.be.rejectedWith('NoRoute');
  });

  it('checks what arrived against the keeper’s minimum', async () => {
    const { buyback, usdg, outbid, keeper, curve, pons } = await loadFixture(enabledFixture);
    // On the curve the minimum is the curve's own price bound.
    await expect(
      buyback.write.executeBuyback([usdg.address, USDG(1000), parseEther('1000001'), await soon()], {
        account: keeper!.account,
      })
    ).to.be.rejectedWith('SlippageExceeded');
    // In the pool, the vault checks its balance itself.
    await curve.write.setGraduated([true]);
    await pons.write.setPhase([outbid.address, POOL_CREATED]);
    await expect(
      buyback.write.executeBuyback([usdg.address, USDG(1000), parseEther('900001'), await soon()], {
        account: keeper!.account,
      })
    ).to.be.rejectedWith('ExcessiveSlippage');
  });

  it('bounds every execution', async () => {
    const { buyback, usdg, outbid, keeper, outsider } = await loadFixture(enabledFixture);
    const run = async (asset: Address, amount: bigint, min: bigint, account = keeper!.account, deadline?: bigint) =>
      buyback.write.executeBuyback([asset, amount, min, deadline ?? (await soon())], { account });

    await expect(run(usdg.address, USDG(100), 1n, outsider!.account)).to.be.rejectedWith('NotAKeeper');
    await expect(run(usdg.address, USDG(100), 0n)).to.be.rejectedWith('NoMinimumOut');
    await expect(run(usdg.address, 0n, 1n)).to.be.rejectedWith('NothingToSpend');
    await expect(run(outbid.address, 1n, 1n)).to.be.rejectedWith('NotSpendable');
    await expect(run(usdg.address, USDG(100), 1n, keeper!.account, 1n)).to.be.rejectedWith('Expired');
    await expect(run(usdg.address, USDG(10_001), 1n)).to.be.rejectedWith('InsufficientBalance');

    await buyback.write.setMaxPerExecution([usdg.address, USDG(500)]);
    await expect(run(usdg.address, USDG(501), 1n)).to.be.rejectedWith('AboveMaxPerExecution');

    await run(usdg.address, USDG(500), 1n);
    await expect(run(usdg.address, USDG(100), 1n)).to.be.rejectedWith('CoolingDown');
    expect(await buyback.read.nextBuybackTime()).to.equal((await buyback.read.lastBuybackAt()) + COOLDOWN);
    await time.increase(Number(COOLDOWN));
    await run(usdg.address, USDG(100), 1n);
    expect(await buyback.read.buybackCount()).to.equal(2n);
  });

  it('sends a token without burn to the dead address instead', async () => {
    const { owner, weth, v3Factory, usdg, pons, poolManager, keeper } = await loadFixture(deployFixture);
    const plain = await hre.viem.deployContract('MockERC20', ['Plain', 'PLAIN', 18, parseEther('1000000')]);
    const curve = await hre.viem.deployContract('MockPonsCurve', [plain.address, usdg.address, 6, CURVE_PER_USDG]);
    await plain.write.approve([curve.address, parseEther('1000000')]);
    await curve.write.stock([parseEther('1000000')]);
    await pons.write.setLaunch([plain.address, curve.address, usdg.address, 0, 200]);
    const venue = await hre.viem.deployContract('PonsBuybackVenue', [owner!.account.address, pons.address]);
    const buyback = await hre.viem.deployContract('OutbidBuyback', [owner!.account.address, weth.address, v3Factory.address, 0n]);
    await buyback.write.setKeeper([keeper!.account.address, true]);
    await buyback.write.enableBuyback([plain.address, venue.address]);
    await usdg.write.mint([buyback.address, USDG(100)]);
    void poolManager;

    await buyback.write.executeBuyback([usdg.address, USDG(100), parseEther('100000'), await soon()], {
      account: keeper!.account,
    });
    expect(await plain.read.balanceOf([DEAD])).to.equal(parseEther('100000'));
    expect(await buyback.read.totalOutbidBurned()).to.equal(parseEther('100000'));
  });

  it('converts a coin it was paid in through the factory’s own pool, and never $OUTBID', async () => {
    const { buyback, weth, v3Factory, outbid, keeper, outsider } = await loadFixture(enabledFixture);
    // A dollar a coin was priced in, with a WETH pool on the platform's factory: 3,000 to the ether.
    const dollar = await hre.viem.deployContract('MockERC20', ['Dollar', 'USD', 18, 0n]);
    await v3Factory.write.createPool([dollar.address, weth.address, POOL_FEE]);
    const poolAddress = (await v3Factory.read.getPool([dollar.address, weth.address, POOL_FEE])) as Address;
    const pool = await hre.viem.getContractAt('UniswapV3Pool', poolAddress);
    const seeder = await hre.viem.deployContract('PoolSeeder', [weth.address]);
    await pool.write.initialize([await seeder.read.sqrtPriceFor([dollar.address, parseEther('1') / 3000n])]);
    await dollar.write.mint([seeder.address, parseEther('3100000')]);
    await seeder.write.seed([poolAddress, dollar.address], { value: parseEther('1000') });
    await dollar.write.mint([buyback.address, parseEther('3000')]);

    const deadline = await soon();
    const convert = (args: readonly [Address, Address, number, bigint, bigint, bigint], account = keeper!.account) =>
      buyback.write.convert(args, { account });
    await expect(
      convert([dollar.address, weth.address, POOL_FEE, parseEther('3000'), parseEther('0.9'), deadline], outsider!.account)
    ).to.be.rejectedWith('NotAKeeper');
    await expect(convert([dollar.address, weth.address, POOL_FEE, parseEther('3000'), 0n, deadline])).to.be.rejectedWith(
      'NoMinimumOut'
    );
    await expect(
      convert([dollar.address, weth.address, 3000, parseEther('3000'), parseEther('0.9'), deadline])
    ).to.be.rejectedWith('PoolNotFound');
    await expect(convert([dollar.address, outbid.address, POOL_FEE, parseEther('3000'), 1n, deadline])).to.be.rejectedWith(
      'NotConvertible'
    );

    await convert([dollar.address, weth.address, POOL_FEE, parseEther('3000'), parseEther('0.9'), deadline]);
    const wrapped = await weth.read.balanceOf([buyback.address]);
    expect(wrapped > parseEther('0.9') && wrapped < parseEther('1'), `got ${wrapped}`).to.equal(true);
    expect(await buyback.read.pendingBuyback()).to.equal(parseEther('100') + wrapped);
  });

  it('only pays a pool the factory returns for the pair a conversion named', async () => {
    const { buyback, weth, usdg, outsider } = await loadFixture(deployFixture);
    const data = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }],
      [weth.address, usdg.address, POOL_FEE]
    );
    await expect(
      buyback.write.uniswapV3SwapCallback([1n, -1n, data], { account: outsider!.account })
    ).to.be.rejectedWith('UnexpectedCaller');
  });
});

describe('PonsBuybackVenue', () => {
  it('reads the PoolManager and the hook from PONS', async () => {
    const { venue, poolManager, hook } = await loadFixture(deployFixture);
    expect(getAddress(await venue.read.poolManager())).to.equal(getAddress(poolManager.address));
    expect(getAddress(await venue.read.hook())).to.equal(getAddress(hook!.account.address));
  });

  it('keeps routes to the owner, and each must hold its asset in order', async () => {
    const { venue, usdg, outsider, ethRoute } = await loadFixture(deployFixture);
    await expect(venue.write.setRoute([ETHER, ethRoute], { account: outsider!.account })).to.be.rejectedWith(
      'OwnableUnauthorizedAccount'
    );
    const reversed = { ...ethRoute, currency0: usdg.address, currency1: ETHER };
    await expect(venue.write.setRoute([ETHER, reversed])).to.be.rejectedWith('BadRoute');
    const other = { ...ethRoute, currency0: ETHER };
    await expect(venue.write.setRoute([outsider!.account.address, other])).to.be.rejectedWith('BadRoute');
    const stored = await venue.read.routeOf([ETHER]);
    expect(getAddress(stored.currency1)).to.equal(getAddress(usdg.address));
  });

  it('answers only the PoolManager’s call back', async () => {
    const { venue, outsider } = await loadFixture(deployFixture);
    await expect(venue.write.unlockCallback(['0x'], { account: outsider!.account })).to.be.rejectedWith(
      'UnexpectedCaller'
    );
  });

  it('refuses a token PONS did not launch', async () => {
    const { venue, usdg, funder } = await loadFixture(deployFixture);
    await usdg.write.mint([funder!.account.address, USDG(10)]);
    await usdg.write.approve([venue.address, USDG(10)], { account: funder!.account });
    await expect(
      venue.write.buy([usdg.address, USDG(10), usdg.address, 1n, funder!.account.address], { account: funder!.account })
    ).to.be.rejectedWith('NotLaunched');
  });
});
