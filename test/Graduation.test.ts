import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import { encodeFunctionData, getAddress, parseEther, zeroAddress } from 'viem';
import hre from 'hardhat';
import {
  BPS,
  FEE_BPS,
  LAUNCH_FEE,
  POOL_FEE,
  PROTOCOL_SHARE_BPS,
  SUPPLY_AT_CAP,
  TOTAL_SUPPLY,
  USD_CAP,
  WETH_CAP,
  USD_DECIMALS,
  deployLaunchpad,
  netOfFee,
  poolPriceX18,
  ppm,
  usd,
} from './helpers/launchpad';

const DEADLINE = 4_102_444_800n; // 2100-01-01

describe('Graduation into an outbidfun.lol pool', () => {
  async function launchedFixture() {
    const stack = await deployLaunchpad();
    const coin = await stack.launch(stack.alice, 'Front Page Pepe', 'PEPE');
    const coinIsToken0 = coin.address.toLowerCase() < stack.weth.address.toLowerCase();
    return { ...stack, coin, coinIsToken0 };
  }

  async function graduatedFixture() {
    const stack = await launchedFixture();
    const { coin, alice, buy, listingManager } = stack;
    await buy(coin, alice, parseEther('1'));
    const priceBefore = await coin.read.price();
    // 4.2 ETH cap; after the 1% fee a 10 ETH buy crosses it with change to spare.
    const graduation = await buy(coin, alice, parseEther('10'));
    const pool = await listingManager.read.poolOf([coin.address]);
    return { ...stack, priceBefore, pool, graduation };
  }

  describe('before the curve fills', () => {
    it('has no pool, and nobody can open one', async () => {
      const { coin, listingManager, v3Factory, weth, bob } = await loadFixture(launchedFixture);

      expect(await listingManager.read.poolOf([coin.address])).to.equal(zeroAddress);
      expect(await v3Factory.read.getPool([coin.address, weth.address, POOL_FEE])).to.equal(zeroAddress);

      // Only the factory owner, the listing manager, may create pools.
      await expect(
        v3Factory.write.createPool([coin.address, weth.address, POOL_FEE], { account: bob.account })
      ).to.be.rejected;
      // And only a coin the launchpad deployed may ask it to.
      await expect(
        listingManager.write.listMemeCoin([1n, 1n, 1n], { account: bob.account })
      ).to.be.rejectedWith('UnknownCoin');
      await expect(listingManager.read.positionTicks([coin.address])).to.be.rejectedWith('NotListed');
    });

    it('keeps launches cheap: no pool is deployed until graduation', async () => {
      const { coinFactory, weth, bob, publicClient } = await loadFixture(launchedFixture);
      const hash = await coinFactory.write.deploy(
        [
          {
            name: 'Cheap',
            symbol: 'CHEAP',
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
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      // A V3 pool alone costs about five million gas to deploy.
      expect(receipt.gasUsed < 5_000_000n).to.equal(true);
    });
  });

  describe('when the curve fills', () => {
    it('opens the pool at the curve price and locks the curve reserve with fresh supply', async () => {
      const {
        coin,
        pool,
        weth,
        v3Factory,
        listingManager,
        coinFactory,
        coinIsToken0,
        priceBefore,
        graduation,
      } = await loadFixture(graduatedFixture);

      expect(await coin.read.cap()).to.equal(0n);
      expect(pool).to.not.equal(zeroAddress);
      expect((await v3Factory.read.getPool([coin.address, weth.address, POOL_FEE])).toLowerCase()).to.equal(
        pool.toLowerCase()
      );
      expect(getAddress(await listingManager.read.quoteOf([coin.address]))).to.equal(getAddress(weth.address));
      // Well inside the 16.7M per-transaction cap of EIP-7825, pool deployment included.
      expect(graduation.gasUsed < 12_000_000n).to.equal(true);

      const poolContract = await hre.viem.getContractAt('UniswapV3Pool', pool);
      expect(await poolContract.read.fee()).to.equal(POOL_FEE);
      expect((await poolContract.read.liquidity()) > 0n).to.equal(true);

      // The whole 4.2 ETH cap, to the wei the position could use. Nothing is taken at graduation.
      const wethInPool = await weth.read.balanceOf([pool]);
      expect(ppm(wethInPool, WETH_CAP) < 1n).to.equal(true);
      expect(await weth.read.balanceOf([coin.address])).to.equal(0n);

      // The pool opens at the price the curve reached: (1 + powerN / powerD) * cap over the
      // supply the curve had sold. (coin.price() is no longer that figure, because the supply
      // it reads now includes what was minted into the pool.)
      const [sqrtPriceX96] = await poolContract.read.slot0();
      const soldByTheCurve = (await coin.read.totalSupply()) - (await coin.read.balanceOf([pool]));
      const curvePrice = (11n * WETH_CAP * parseEther('1')) / (5n * soldByTheCurve);
      expect(ppm(poolPriceX18(sqrtPriceX96, coinIsToken0), curvePrice) < 10n).to.equal(true);
      expect(ppm(priceBefore, curvePrice) > 1000n).to.equal(true); // it really moved

      // Every curve sells the same supply by the time it fills, whatever it is priced in, and the
      // pool's share on top makes a billion.
      expect(ppm(soldByTheCurve, SUPPLY_AT_CAP) < 10n, `sold ${soldByTheCurve}`).to.equal(true);
      expect(ppm(await coin.read.totalSupply(), TOTAL_SUPPLY) < 10n).to.equal(true);
      // So the factory knows the opening price before a single buy.
      const graduationPrice = await coinFactory.read.graduationPrice([weth.address]);
      expect(ppm(graduationPrice, curvePrice) < 10n, `estimate ${graduationPrice} vs ${curvePrice}`).to.equal(true);

      // Nothing minted for the listing is left over, and the manager holds no reserve.
      expect(await coin.read.balanceOf([listingManager.address])).to.equal(0n);
      expect(await weth.read.balanceOf([listingManager.address])).to.equal(0n);
    });

    it('pays the fee on what was bought, refunds the excess, and takes nothing at graduation', async () => {
      const stack = await loadFixture(launchedFixture);
      const { coin, buy, alice, treasury, weth, feeEscrow } = stack;

      const treasuryBefore = await weth.read.balanceOf([treasury.address]);
      const aliceBefore = await weth.read.balanceOf([alice.account.address]);
      await buy(coin, alice, parseEther('20'));
      const aliceAfter = await weth.read.balanceOf([alice.account.address]);
      const treasuryAfter = await weth.read.balanceOf([treasury.address]);

      // 20 ETH offered, and only the 4.2 ETH of room is bought: the fee follows the spend, so
      // 4.2424 leaves the wallet (4.2 to the curve, 0.0424 in fees) and 15.7576 comes straight
      // back. The buyer is charged 1% of what they bought, not of what they offered.
      const spent = 4_242_424_242_424_242_425n; // ceil(4.2 ETH * 10000 / 9900)
      expect(aliceBefore - aliceAfter).to.equal(spent);
      // The fee is the only thing taken, and it is shared: 30% to the treasury, 70% to the
      // creator. The graduation itself costs nothing.
      const fee = spent - WETH_CAP;
      expect(ppm(treasuryAfter - treasuryBefore, (fee * PROTOCOL_SHARE_BPS) / BPS) < 1n).to.equal(true);
      expect(
        ppm(await feeEscrow.read.balanceOf([alice.account.address, weth.address]), fee - (fee * PROTOCOL_SHARE_BPS) / BPS) < 1n
      ).to.equal(true);
    });

    it('closes the curve for good and lists only once', async () => {
      const { coin, buy, alice, bob, listingManager } = await loadFixture(graduatedFixture);
      await expect(buy(coin, bob, parseEther('1'))).to.be.rejectedWith('Already listed');
      await expect(coin.write.sell([1n, 0n], { account: alice.account })).to.be.rejectedWith(
        'Already listed'
      );
      await expect(coin.write.transfer([bob.account.address, 1n], { account: alice.account })).to.not
        .be.rejected;
      // Even the coin itself could not list again.
      await expect(
        listingManager.write.listMemeCoin([1n, 1n, 1n], { account: bob.account })
      ).to.be.rejectedWith('UnknownCoin');
    });

    it('graduates a coin priced in dollars into a dollar pool', async () => {
      const { launch, buy, dollar, alice, v3Factory, listingManager, coinFactory, treasury } =
        await loadFixture(launchedFixture);
      const coin = await launch(alice, 'Greenback', 'BUCK', { quote: dollar.address });
      const coinIsToken0 = coin.address.toLowerCase() < dollar.address.toLowerCase();

      await buy(coin, alice, usd(5_000));
      const aliceBefore = await dollar.read.balanceOf([alice.account.address]);
      const treasuryBefore = await dollar.read.balanceOf([treasury.address]);
      await buy(coin, alice, usd(40_000));

      const pool = await listingManager.read.poolOf([coin.address]);
      expect(pool).to.not.equal(zeroAddress);
      expect((await v3Factory.read.getPool([coin.address, dollar.address, POOL_FEE])).toLowerCase()).to.equal(
        pool.toLowerCase()
      );
      expect(getAddress(await listingManager.read.quoteOf([coin.address]))).to.equal(getAddress(dollar.address));

      // The whole 30,000 dollar cap is in the pool, and the buyer got the rest of the 40,000 back.
      const room = USD_CAP - netOfFee(usd(5_000));
      const spent = (room * BPS + (BPS - FEE_BPS) - 1n) / (BPS - FEE_BPS);
      expect(aliceBefore - (await dollar.read.balanceOf([alice.account.address]))).to.equal(spent);
      expect(ppm(await dollar.read.balanceOf([pool]), USD_CAP) < 1n).to.equal(true);
      expect(await dollar.read.balanceOf([coin.address])).to.equal(0n);
      const fee = spent - room;
      expect(
        ppm((await dollar.read.balanceOf([treasury.address])) - treasuryBefore, (fee * PROTOCOL_SHARE_BPS) / BPS) < 10n
      ).to.equal(true);

      // The pool opens where the curve ended, read in dollars per coin at eighteen decimals.
      const poolContract = await hre.viem.getContractAt('UniswapV3Pool', pool);
      const [sqrtPriceX96] = await poolContract.read.slot0();
      const soldByTheCurve = (await coin.read.totalSupply()) - (await coin.read.balanceOf([pool]));
      const curvePrice = (11n * USD_CAP * 10n ** 12n * parseEther('1')) / (5n * soldByTheCurve);
      expect(ppm(poolPriceX18(sqrtPriceX96, coinIsToken0, USD_DECIMALS), curvePrice) < 10n).to.equal(true);
      expect(ppm(soldByTheCurve, SUPPLY_AT_CAP) < 10n).to.equal(true);
      expect(ppm(await coinFactory.read.graduationPrice([dollar.address]), curvePrice) < 10n).to.equal(true);
    });
  });

  describe('after graduation', () => {
    it('trades through the SwapRouter at the QuoterV2 quote', async () => {
      const { coin, weth, swapRouter, quoter, bob, publicClient } = await loadFixture(graduatedFixture);

      // Buy: ETH in, coins out. The router wraps it, since the pool is against WETH.
      const amountIn = parseEther('0.1');
      const { result: quote } = await quoter.simulate.quoteExactInputSingle([
        { tokenIn: weth.address, tokenOut: coin.address, amountIn, fee: POOL_FEE, sqrtPriceLimitX96: 0n },
      ]);
      const expectedOut = quote[0];
      expect(expectedOut > 0n).to.equal(true);

      let hash = await swapRouter.write.exactInputSingle(
        [
          {
            tokenIn: weth.address,
            tokenOut: coin.address,
            fee: POOL_FEE,
            recipient: bob.account.address,
            deadline: DEADLINE,
            amountIn,
            amountOutMinimum: expectedOut,
            sqrtPriceLimitX96: 0n,
          },
        ],
        { value: amountIn, account: bob.account }
      );
      await publicClient.waitForTransactionReceipt({ hash });
      const held = await coin.read.balanceOf([bob.account.address]);
      expect(held).to.equal(expectedOut);

      // Sell: coins in, ETH out, unwrapped in the same call.
      hash = await coin.write.approve([swapRouter.address, held], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      const { result: sellQuote } = await quoter.simulate.quoteExactInputSingle([
        { tokenIn: coin.address, tokenOut: weth.address, amountIn: held, fee: POOL_FEE, sqrtPriceLimitX96: 0n },
      ]);
      const ethBefore = await publicClient.getBalance({ address: bob.account.address });
      hash = await swapRouter.write.multicall(
        [
          [
            encodeFunctionData({
              abi: swapRouter.abi,
              functionName: 'exactInputSingle',
              args: [
                {
                  tokenIn: coin.address,
                  tokenOut: weth.address,
                  fee: POOL_FEE,
                  recipient: zeroAddress, // the router itself, so it can unwrap
                  deadline: DEADLINE,
                  amountIn: held,
                  amountOutMinimum: sellQuote[0],
                  sqrtPriceLimitX96: 0n,
                },
              ],
            }),
            encodeFunctionData({
              abi: swapRouter.abi,
              functionName: 'unwrapWETH9',
              args: [sellQuote[0], bob.account.address],
            }),
          ],
        ],
        { account: bob.account }
      );
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const ethAfter = await publicClient.getBalance({ address: bob.account.address });
      expect(ethAfter - ethBefore + receipt.gasUsed * receipt.effectiveGasPrice).to.equal(sellQuote[0]);
      expect(await coin.read.balanceOf([bob.account.address])).to.equal(0n);
    });

    it('trades a dollar coin for dollars through the same router', async () => {
      const { launch, buy, dollar, alice, bob, swapRouter, quoter, listingManager, publicClient } =
        await loadFixture(launchedFixture);
      const coin = await launch(alice, 'Greenback', 'BUCK', { quote: dollar.address });
      await buy(coin, alice, usd(40_000));
      expect(await listingManager.read.poolOf([coin.address])).to.not.equal(zeroAddress);

      const amountIn = usd(250);
      let hash = await dollar.write.approve([swapRouter.address, amountIn], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      const { result: quote } = await quoter.simulate.quoteExactInputSingle([
        { tokenIn: dollar.address, tokenOut: coin.address, amountIn, fee: POOL_FEE, sqrtPriceLimitX96: 0n },
      ]);
      hash = await swapRouter.write.exactInputSingle(
        [
          {
            tokenIn: dollar.address,
            tokenOut: coin.address,
            fee: POOL_FEE,
            recipient: bob.account.address,
            deadline: DEADLINE,
            amountIn,
            amountOutMinimum: quote[0],
            sqrtPriceLimitX96: 0n,
          },
        ],
        { account: bob.account }
      );
      await publicClient.waitForTransactionReceipt({ hash });
      expect(await coin.read.balanceOf([bob.account.address])).to.equal(quote[0]);
    });

    it('shares the swap fees the locked position earns between the protocol and the creator', async () => {
      const { coin, weth, swapRouter, listingManager, treasury, feeEscrow, alice, bob, publicClient } =
        await loadFixture(graduatedFixture);

      const amountIn = parseEther('1');
      let hash = await swapRouter.write.exactInputSingle(
        [
          {
            tokenIn: weth.address,
            tokenOut: coin.address,
            fee: POOL_FEE,
            recipient: bob.account.address,
            deadline: DEADLINE,
            amountIn,
            amountOutMinimum: 0n,
            sqrtPriceLimitX96: 0n,
          },
        ],
        { value: amountIn, account: bob.account }
      );
      await publicClient.waitForTransactionReceipt({ hash });

      const treasuryBefore = await weth.read.balanceOf([treasury.address]);
      const creatorBefore = await feeEscrow.read.balanceOf([alice.account.address, weth.address]);
      hash = await listingManager.write.collectFees([coin.address], { account: bob.account });
      await publicClient.waitForTransactionReceipt({ hash });
      const treasuryAfter = await weth.read.balanceOf([treasury.address]);
      const creatorAfter = await feeEscrow.read.balanceOf([alice.account.address, weth.address]);

      // 1% of 1 ETH, all of it on the quote side because the buyer paid in it, shared the way
      // every fee here is: 30% to the treasury, 70% to the creator's claimable balance.
      expect(ppm(treasuryAfter - treasuryBefore, parseEther('0.003')) < 100n).to.equal(true);
      expect(ppm(creatorAfter - creatorBefore, parseEther('0.007')) < 100n).to.equal(true);
      expect(await weth.read.balanceOf([listingManager.address])).to.equal(0n);

      // Nothing on the manager can take the liquidity out.
      const names = listingManager.abi.filter((entry) => entry.type === 'function').map((entry) => entry.name);
      expect(names).to.not.include.members(['burn', 'collect', 'withdraw', 'execute']);
    });
  });
});
