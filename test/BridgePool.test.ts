import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { parseEther, zeroAddress } from 'viem';
import { POOL_FEE, USD_DECIMALS, deployLaunchpad, sqrtPriceX96For } from './helpers/launchpad';

/**
 * `CoinListingManager.openBridgePool`: the owner opening a pool between two assets that are not
 * themselves coins the platform launched.
 *
 * Every other pool here is a coin's own, opened once at graduation and never touched again. A
 * bridge pool is different on purpose — an ordinary pool between two quote assets, so a route can
 * cross between two coins priced in different ones, where no coin's pool ever could. It is still
 * bound the same way graduation is: only this contract's owner can reach `createPool` at all,
 * because the factory itself refuses anyone else (`contracts/uniswap-v3/README.md`).
 */
describe('Bridge pools', () => {
  async function stackFixture() {
    return deployLaunchpad();
  }

  it('lets the owner open a pool between two quote assets, found through the factory', async () => {
    const { listingManager, v3Factory, weth, dollar, owner, publicClient } = await loadFixture(stackFixture);

    const wethIsToken0 = weth.address.toLowerCase() < dollar.address.toLowerCase();
    const sqrtPriceX96 = sqrtPriceX96For(parseEther('3000'), wethIsToken0, USD_DECIMALS);

    expect(await v3Factory.read.getPool([weth.address, dollar.address, POOL_FEE])).to.equal(zeroAddress);

    const hash = await listingManager.write.openBridgePool(
      [weth.address, dollar.address, POOL_FEE, sqrtPriceX96],
      { account: owner.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });

    const pool = await v3Factory.read.getPool([weth.address, dollar.address, POOL_FEE]);
    expect(pool).to.not.equal(zeroAddress);

    const poolContract = await hre.viem.getContractAt('UniswapV3Pool', pool);
    const [gotSqrtPriceX96] = await poolContract.read.slot0();
    expect(gotSqrtPriceX96).to.equal(sqrtPriceX96);

    // A bridge pool is not a coin's pool: the launchpad's own registry never lists it.
    expect(await listingManager.read.poolOf([weth.address])).to.equal(zeroAddress);
    expect(await listingManager.read.poolOf([dollar.address])).to.equal(zeroAddress);
  });

  it('refuses anyone but the owner', async () => {
    const { listingManager, weth, dollar, alice } = await loadFixture(stackFixture);
    const wethIsToken0 = weth.address.toLowerCase() < dollar.address.toLowerCase();
    const sqrtPriceX96 = sqrtPriceX96For(parseEther('3000'), wethIsToken0, USD_DECIMALS);

    await expect(
      listingManager.write.openBridgePool([weth.address, dollar.address, POOL_FEE, sqrtPriceX96], {
        account: alice.account,
      })
    ).to.be.rejected;
  });

  it('refuses a pair that already has a pool', async () => {
    const { listingManager, weth, dollar, owner, publicClient } = await loadFixture(stackFixture);
    const wethIsToken0 = weth.address.toLowerCase() < dollar.address.toLowerCase();
    const sqrtPriceX96 = sqrtPriceX96For(parseEther('3000'), wethIsToken0, USD_DECIMALS);

    const hash = await listingManager.write.openBridgePool(
      [weth.address, dollar.address, POOL_FEE, sqrtPriceX96],
      { account: owner.account }
    );
    await publicClient.waitForTransactionReceipt({ hash });

    await expect(
      listingManager.write.openBridgePool([weth.address, dollar.address, POOL_FEE, sqrtPriceX96], {
        account: owner.account,
      })
    ).to.be.rejected;
  });

  it('refuses a fee tier the factory has not enabled', async () => {
    const { listingManager, weth, dollar, owner } = await loadFixture(stackFixture);
    const wethIsToken0 = weth.address.toLowerCase() < dollar.address.toLowerCase();
    const sqrtPriceX96 = sqrtPriceX96For(parseEther('3000'), wethIsToken0, USD_DECIMALS);

    await expect(
      listingManager.write.openBridgePool([weth.address, dollar.address, 1234, sqrtPriceX96], {
        account: owner.account,
      })
    ).to.be.rejected;
  });

  it('refuses to bridge a coin the platform launched', async () => {
    const { listingManager, weth, launch, alice, owner } = await loadFixture(stackFixture);
    const coin = await launch(alice, 'Front Page Pepe', 'PEPE');

    const coinIsToken0 = coin.address.toLowerCase() < weth.address.toLowerCase();
    const sqrtPriceX96 = sqrtPriceX96For(parseEther('1'), coinIsToken0);

    await expect(
      listingManager.write.openBridgePool([coin.address, weth.address, POOL_FEE, sqrtPriceX96], {
        account: owner.account,
      })
    ).to.be.rejected;
  });
});
