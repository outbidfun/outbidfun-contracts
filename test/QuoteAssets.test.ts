import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { parseEther, parseUnits } from 'viem';
import {
  SUPPLY_AT_CAP,
  TOTAL_SUPPLY,
  USD_CAP,
  WETH_CAP,
  closingPriceX18,
  deployLaunchpad,
  ppm,
  usd,
} from './helpers/launchpad';

const DEAD = '0x000000000000000000000000000000000000dEaD';

/**
 * The assets a coin can be paired with.
 *
 * A launchpad that trades only in ether puts every coin behind the same door. Here the platform
 * lists the assets it will take — wrapped ether, stablecoins, tokenised shares — each with the
 * reserve a coin priced in it graduates at, and the creator picks one at launch. What has to
 * hold: the list is the platform's to curate, a coin keeps the terms it launched with whatever
 * happens to the list afterwards, and the curve treats every asset the same way.
 */
describe('Quote assets', () => {
  it('lists an asset with its own decimals and cap, and reads the list back', async () => {
    const { coinFactory, weth, dollar } = await loadFixture(deployLaunchpad);

    const [wethCap, wethDecimals, wethEnabled] = await coinFactory.read.quoteAssets([weth.address]);
    expect(wethCap).to.equal(WETH_CAP);
    expect(wethDecimals).to.equal(18);
    expect(wethEnabled).to.equal(true);

    const [dollarCap, dollarDecimals, dollarEnabled] = await coinFactory.read.quoteAssets([dollar.address]);
    expect(dollarCap).to.equal(USD_CAP);
    expect(dollarDecimals).to.equal(6);
    expect(dollarEnabled).to.equal(true);

    const listed = await coinFactory.read.allQuoteAssets();
    expect(listed.map((address) => address.toLowerCase())).to.deep.equal([
      weth.address.toLowerCase(),
      dollar.address.toLowerCase(),
    ]);
  });

  it('changes an asset’s cap for new coins without listing it twice, and old coins keep theirs', async () => {
    const { coinFactory, launch, dollar, alice } = await loadFixture(deployLaunchpad);
    const before = await launch(alice, 'Before', 'B4', { quote: dollar.address });

    await coinFactory.write.setQuoteAsset([dollar.address, usd(50_000), true]);
    const after = await launch(alice, 'After', 'AFT', { quote: dollar.address });

    expect(await before.read.cap()).to.equal(USD_CAP);
    expect(await after.read.cap()).to.equal(usd(50_000));
    expect((await coinFactory.read.allQuoteAssets()).length).to.equal(2);
  });

  it('stops new launches on a disabled asset while its coins trade on', async () => {
    const { coinFactory, launch, buy, dollar, alice, bob } = await loadFixture(deployLaunchpad);
    const coin = await launch(alice, 'Greenback', 'BUCK', { quote: dollar.address });

    await coinFactory.write.setQuoteAsset([dollar.address, USD_CAP, false]);
    await expect(launch(bob, 'Late', 'LATE', { quote: dollar.address })).to.be.rejectedWith('Quote asset not enabled');
    // Still on the list, so a menu can show it as paused rather than forget it.
    expect((await coinFactory.read.allQuoteAssets()).length).to.equal(2);

    await buy(coin, bob, usd(100));
    expect((await coin.read.balanceOf([bob.account.address])) > 0n).to.equal(true);
  });

  it('refuses what cannot be a quote asset', async () => {
    const { coinFactory, dollar, bob } = await loadFixture(deployLaunchpad);
    await expect(coinFactory.write.setQuoteAsset([bob.account.address, 1n, true])).to.be.rejectedWith('Not a contract');
    await expect(coinFactory.write.setQuoteAsset([dollar.address, 0n, true])).to.be.rejectedWith('Zero cap');
    const wide = await hre.viem.deployContract('MockERC20', ['Wide', 'WIDE', 24, 0n]);
    await expect(coinFactory.write.setQuoteAsset([wide.address, parseUnits('9', 24), true])).to.be.rejectedWith(
      'Too many decimals'
    );
    await expect(
      coinFactory.write.setQuoteAsset([dollar.address, usd(1), true], { account: bob.account })
    ).to.be.rejectedWith('OwnableUnauthorizedAccount');
  });

  it('prices graduation in each asset from the same curve', async () => {
    const { coinFactory, weth, dollar } = await loadFixture(deployLaunchpad);
    // The phantom 40% plus the cap, over the 285.7M coins the model has left: 12.25 times the
    // opening price in every asset, at eighteen decimals either way.
    expect(await coinFactory.read.graduationPrice([weth.address])).to.equal(closingPriceX18(WETH_CAP));
    expect(await coinFactory.read.graduationPrice([weth.address])).to.equal(20_579_999_999n);
    expect(await coinFactory.read.graduationPrice([dollar.address])).to.equal(closingPriceX18(USD_CAP, 6));
    expect(await coinFactory.read.virtualQuoteOf([weth.address])).to.equal(parseEther('1.68'));
    expect(await coinFactory.read.virtualQuoteOf([dollar.address])).to.equal(usd(5_600));
    const stray = await hre.viem.deployContract('MockERC20', ['Stray', 'STRAY', 18, 0n]);
    await expect(coinFactory.read.graduationPrice([stray.address])).to.be.rejectedWith('Unknown quote asset');
  });

  it('sells the same supply by graduation whatever the coin is priced in', async () => {
    const { launch, buy, weth, dollar, alice, listingManager } = await loadFixture(deployLaunchpad);
    const inEther = await launch(alice, 'Ether Coin', 'ECOIN', { quote: weth.address });
    const inDollars = await launch(alice, 'Greenback', 'BUCK', { quote: dollar.address });
    await buy(inEther, alice, parseEther('3'));
    await buy(inEther, alice, parseEther('10'));
    await buy(inDollars, alice, usd(12_000));
    await buy(inDollars, alice, usd(25_000));

    for (const coin of [inEther, inDollars]) {
      const pool = await listingManager.read.poolOf([coin.address]);
      const sold =
        (await coin.read.totalSupply()) - (await coin.read.balanceOf([pool])) - (await coin.read.balanceOf([DEAD]));
      expect(ppm(sold, SUPPLY_AT_CAP) < 10n, `${sold}`).to.equal(true);
      expect(await coin.read.totalSupply()).to.equal(TOTAL_SUPPLY);
    }
  });

  it('lets the owner change the curve for coins launched from then on', async () => {
    const { coinFactory, launch, buy, weth, alice, bob, listingManager } = await loadFixture(deployLaunchpad);
    const before = await launch(alice, 'Pons Terms', 'PONS1', { quote: weth.address });
    // Pump.fun's terms: a phantom 30 / 85 of the cap, 1.073B coins in the model, a billion minted.
    const pump = [3_529, parseEther('1073000000'), TOTAL_SUPPLY] as const;
    await expect(coinFactory.write.setParameters([0, pump[1], pump[2]])).to.be.rejectedWith('Zero parameter');
    await expect(coinFactory.write.setParameters([pump[0], pump[1], 0n])).to.be.rejectedWith('Zero parameter');
    await expect(coinFactory.write.setParameters([...pump], { account: bob.account })).to.be.rejectedWith(
      'OwnableUnauthorizedAccount'
    );
    // A supply the model does not hold, or one that could not hold what the curve sells and what
    // its pool needs.
    await expect(coinFactory.write.setParameters([pump[0], pump[1], parseEther('1100000000')])).to.be.rejectedWith(
      'Supply above the model'
    );
    await expect(coinFactory.write.setParameters([pump[0], pump[1], parseEther('999000000')])).to.be.rejectedWith(
      'Supply below the curve'
    );

    await coinFactory.write.setParameters([...pump]);
    expect(await coinFactory.read.virtualQuoteOf([weth.address])).to.equal((WETH_CAP * 3_529n) / 10_000n);
    const coin = await launch(alice, 'Pump Terms', 'PUMP', { quote: weth.address });
    expect(await coin.read.virtualTokenReserve()).to.equal(pump[1]);
    // It opens at its phantom quote over the 1.073B coins in the model.
    expect(ppm(await coin.read.price(), (((WETH_CAP * 3_529n) / 10_000n) * 10n ** 18n) / pump[1]) < 1n).to.equal(true);
    // The coins launched before keep the curve they started with.
    expect(await before.read.virtualTokenReserve()).to.equal(parseEther('1000000000'));

    // It sells 793.1M by the cap, the pool opens with 206.9M, and a few thousand are left to lock.
    await buy(coin, alice, parseEther('10'));
    const pool = await listingManager.read.poolOf([coin.address]);
    const pooled = await coin.read.balanceOf([pool]);
    const locked = await coin.read.balanceOf([DEAD]);
    expect(ppm((await coin.read.totalSupply()) - pooled - locked, parseEther('793100000')) < 100n).to.equal(true);
    expect(ppm(pooled, parseEther('206880000')) < 100n, `${pooled}`).to.equal(true);
    expect(locked < parseEther('100000')).to.equal(true);
    expect(await coin.read.totalSupply()).to.equal(TOTAL_SUPPLY);
  });
});
