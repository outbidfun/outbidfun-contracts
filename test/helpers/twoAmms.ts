import hre from 'hardhat';
import { maxUint256, parseEther, type Address } from 'viem';
import { deployLaunchpad, poolPriceX18, sqrtPriceX96For } from './launchpad';

/**
 * Two AMMs on one Hardhat network, for the swap page's aggregation and splitting tests: the
 * platform's own Uniswap V3 with a coin graduated into it, and a second, separate V3 deployment
 * standing in for another AMM on the same chain, with the same coin priced a fifth cheaper.
 * Multicall3 sits where the page sends its quotes, as on Robinhood Chain.
 */

export const DEADLINE = 4_102_444_800n; // 2100-01-01
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const FEE_TIERS = [10_000, 3_000, 500] as const;
/** The fork's pool: the standard 0.3% tier, a different tier from ours on purpose. */
export const FORK_FEE = 3_000;

export async function twoAmmsFixture() {
  const stack = await deployLaunchpad();
  const { weth, dollar, alice, owner, publicClient } = stack;

  // Multicall3 where the page sends its quotes, as on Robinhood Chain.
  const multicall = await hre.viem.deployContract('Multicall3Aggregate', []);
  await hre.network.provider.request({
    method: 'hardhat_setCode',
    params: [MULTICALL3, await publicClient.getCode({ address: multicall.address })],
  });
  const coin = await stack.launch(alice, 'Front Page Pepe', 'PEPE');
  await stack.buy(coin, alice, parseEther('10'));

  // A second Uniswap V3, deployed by someone else: its own factory, router, quoter and manager.
  const forkFactory = await hre.viem.deployContract('UniswapV3Factory', []);
  const forkRouter = await hre.viem.deployContract('SwapRouter', [forkFactory.address, weth.address]);
  const forkQuoter = await hre.viem.deployContract('QuoterV2', [forkFactory.address, weth.address]);
  const forkManager = await hre.viem.deployContract('LiquidityManager', [forkFactory.address]);

  // Its coin/ether pool opens a fifth cheaper than ours, about as deep.
  const nativePool = await stack.listingManager.read.poolOf([coin.address]);
  const [nativeSqrtPrice] = await (await hre.viem.getContractAt('UniswapV3Pool', nativePool)).read.slot0();
  const coinIsToken0 = coin.address.toLowerCase() < weth.address.toLowerCase();
  const nativePrice = poolPriceX18(nativeSqrtPrice, coinIsToken0);
  let hash = await forkFactory.write.createPool([coin.address, weth.address, FORK_FEE], {
    account: owner.account,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  const forkPool = await forkFactory.read.getPool([coin.address, weth.address, FORK_FEE]);
  hash = await (await hre.viem.getContractAt('UniswapV3Pool', forkPool)).write.initialize([
    sqrtPriceX96For((nativePrice * 80n) / 100n, coinIsToken0),
  ]);
  await publicClient.waitForTransactionReceipt({ hash });

  await stack.approveAll(alice, [coin.address, weth.address], forkManager.address);
  const [lower, upper] = await forkManager.read.fullRange([coin.address, weth.address, FORK_FEE]);
  const wethIn = parseEther('5');
  const [, , coinNeeded] = await forkManager.read.quoteAdd([
    coin.address,
    weth.address,
    FORK_FEE,
    lower,
    upper,
    wethIn,
    maxUint256,
  ]);
  hash = await forkManager.write.addLiquidity(
    [
      {
        token: coin.address,
        quote: weth.address,
        fee: FORK_FEE,
        tickLower: lower,
        tickUpper: upper,
        quoteDesired: wethIn,
        tokenDesired: (coinNeeded * 101n) / 100n,
        quoteMin: 0n,
        tokenMin: 0n,
        deadline: DEADLINE,
      },
    ],
    { account: alice.account }
  );
  await publicClient.waitForTransactionReceipt({ hash });

  // Shaped as the web app's `SwapProvider`, so the routing tests can hand them to it as they are.
  const native = {
    id: 'outbidfun',
    name: 'outbidfun.lol',
    family: 'uniswap-v3' as const,
    native: true,
    router: stack.swapRouter.address,
    quoter: stack.quoter.address,
    factory: stack.v3Factory.address,
    weth: weth.address,
    feeTiers: FEE_TIERS as readonly number[],
  };
  const fork = {
    id: 'fork',
    name: 'Some Fork',
    family: 'uniswap-v3' as const,
    native: false,
    router: forkRouter.address,
    quoter: forkQuoter.address,
    factory: forkFactory.address,
    weth: weth.address,
    feeTiers: FEE_TIERS as readonly number[],
  };
  return {
    ...stack,
    coin,
    native,
    fork,
    forkFactory,
    forkManager,
    connectors: [dollar.address] as Address[],
  };
}

export type Fixture = Awaited<ReturnType<typeof twoAmmsFixture>>;

/** A pool on the fork, priced at `priceX18` of `quote` per `token` and funded full-range by Alice. */
export async function openForkPool(
  fixture: Fixture,
  token: Address,
  quote: Address,
  fee: number,
  priceX18: bigint,
  quoteDecimals: number,
  quoteIn: bigint
) {
  const { forkFactory, forkManager, owner, alice, publicClient } = fixture;
  let hash = await forkFactory.write.createPool([token, quote, fee], { account: owner.account });
  await publicClient.waitForTransactionReceipt({ hash });
  const pool = await hre.viem.getContractAt('UniswapV3Pool', await forkFactory.read.getPool([token, quote, fee]));
  hash = await pool.write.initialize([sqrtPriceX96For(priceX18, token.toLowerCase() < quote.toLowerCase(), quoteDecimals)]);
  await publicClient.waitForTransactionReceipt({ hash });
  for (const address of [token, quote]) {
    const erc20 = await hre.viem.getContractAt('MockERC20', address);
    hash = await erc20.write.approve([forkManager.address, maxUint256], { account: alice.account });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  const [lower, upper] = await forkManager.read.fullRange([token, quote, fee]);
  const [, , tokenNeeded] = await forkManager.read.quoteAdd([token, quote, fee, lower, upper, quoteIn, maxUint256]);
  hash = await forkManager.write.addLiquidity(
    [
      {
        token,
        quote,
        fee,
        tickLower: lower,
        tickUpper: upper,
        quoteDesired: quoteIn,
        tokenDesired: (tokenNeeded * 101n) / 100n,
        quoteMin: 0n,
        tokenMin: 0n,
        deadline: DEADLINE,
      },
    ],
    { account: alice.account }
  );
  await publicClient.waitForTransactionReceipt({ hash });
  return pool;
}
