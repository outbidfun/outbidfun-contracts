import hre from 'hardhat';
import { time } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { getAddress, maxUint256, parseEther, type Address } from 'viem';

/** Fee tier the listing manager opens pools in: 1%, tick spacing 200. */
export const POOL_FEE = 10_000;

/** What a coin priced in ether graduates at. */
export const WETH_CAP = parseEther('4.2');
/** What a coin priced in the six-decimal dollar graduates at: thirty thousand of them. */
export const USD_DECIMALS = 6;
export const USD_CAP = 14_000n * 10n ** BigInt(USD_DECIMALS);
/** Coins every curve has sold by the time it graduates, whatever it is priced in. */
/** What every curve sells by graduation; the pool gets 1 / 2.2 of it, for a billion in all. */
export const SUPPLY_AT_CAP = parseEther('687500000');
export const TOTAL_SUPPLY = parseEther('1000000000');

/** The fee terms every coin launches with, the same PONS trades on. */
export const LAUNCH_FEE = parseEther('0.0005');
export const FEE_BPS = 100n;
export const PROTOCOL_SHARE_BPS = 3_000n;
export const MAX_CREATOR_TAX_BPS = 1_000n;
export const SNIPE_TAX_START_BPS = 9_900n;
export const SNIPE_TAX_SECONDS = 3;
export const BPS = 10_000n;

export const usd = (amount: string | number) => BigInt(Math.round(Number(amount) * 1e6));

type Wallet = NonNullable<Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number]>;

export type LaunchOptions = {
  quote?: Address;
  preBuy?: bigint;
  creatorTaxBps?: number;
  creatorFeeRecipient?: Address;
  snipeExemptions?: Address[];
  /** A reward coin's share of every transfer for its holders, in basis points. Zero: a standard coin. */
  rewardFeeBps?: number;
  /** Give every creator fee to the holders. A reward coin only. */
  shareFeesWithHolders?: boolean;
  /** Leave the launch window open, so the snipe tax can be tested. Skipped past by default. */
  inWindow?: boolean;
  socials?: string;
};

/**
 * The whole launchpad, wired the way Ignition deploys it: WETH9, the Uniswap V3 factory,
 * router and quoter, the curve formula, the treasury, the fee escrow, the listing manager
 * (which owns the factory, so only it can open pools), the coin creator, the CoinFactory and
 * the LiquidityManager.
 *
 * Two assets a coin can be priced in: wrapped ether, and a six-decimal dollar standing in for
 * the stablecoins and tokenised assets the platform lists. Every wallet holds plenty of both.
 */
export async function deployLaunchpad() {
  const [owner, alice, bob, carol] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();

  const weth = await hre.viem.deployContract('WETH9', []);
  const dollar = await hre.viem.deployContract('MockERC20', ['Dollar', 'USD', USD_DECIMALS, 0n]);
  const v3Factory = await hre.viem.deployContract('UniswapV3Factory', []);
  const swapRouter = await hre.viem.deployContract('SwapRouter', [v3Factory.address, weth.address]);
  const quoter = await hre.viem.deployContract('QuoterV2', [v3Factory.address, weth.address]);

  const formula = await hre.viem.deployContract('Formula', []);
  await formula.write.init();
  const treasury = await hre.viem.deployContract('Treasury', [owner!.account.address]);
  const feeEscrow = await hre.viem.deployContract('FeeEscrow', []);
  const listingManager = await hre.viem.deployContract('CoinListingManager', [
    owner!.account.address,
    treasury.address,
    v3Factory.address,
    feeEscrow.address,
    POOL_FEE,
  ]);
  const coinCreator = await hre.viem.deployContract('CoinCreator', [owner!.account.address]);
  const holderRewards = await hre.viem.deployContract('HolderRewards', []);
  const coinFactory = await hre.viem.deployContract('CoinFactory', [
    formula.address,
    listingManager.address,
    feeEscrow.address,
    coinCreator.address,
    holderRewards.address,
  ]);
  await coinCreator.write.setFactory([coinFactory.address]);
  await listingManager.write.setCoinFactory([coinFactory.address]);
  await v3Factory.write.setOwner([listingManager.address]);
  await coinFactory.write.setQuoteAsset([weth.address, WETH_CAP, true]);
  await coinFactory.write.setQuoteAsset([dollar.address, USD_CAP, true]);
  const liquidityManager = await hre.viem.deployContract('LiquidityManager', [v3Factory.address]);

  for (const wallet of [owner!, alice!, bob!, carol!]) {
    await weth.write.deposit({ value: parseEther('500'), account: wallet.account });
    await dollar.write.mint([wallet.account.address, usd(10_000_000)]);
  }

  /** The ERC20 at `address`, bound to `wallet`. WETH9 answers the same calls a plain token does. */
  const erc20 = (address: Address, wallet: Wallet) =>
    hre.viem.getContractAt('MockERC20', address, { client: { wallet } });

  /** Launches a coin and returns it bound to `wallet`. Pays the launch fee; skips the snipe window. */
  async function launch(wallet: Wallet, name: string, symbol: string, options: LaunchOptions = {}) {
    const quote = options.quote ?? weth.address;
    const preBuy = options.preBuy ?? 0n;
    if (preBuy > 0n) {
      const token = await erc20(quote, wallet);
      const approval = await token.write.approve([coinFactory.address, preBuy], { account: wallet.account });
      await publicClient.waitForTransactionReceipt({ hash: approval });
    }
    const hash = await coinFactory.write.deploy(
      [
        {
          name,
          symbol,
          description: '',
          image: '',
          socials: options.socials ?? '',
          quoteAsset: quote,
          preBuy,
          creatorFeeRecipient: options.creatorFeeRecipient ?? ('0x0000000000000000000000000000000000000000' as Address),
          creatorTaxBps: options.creatorTaxBps ?? 0,
          rewardFeeBps: options.rewardFeeBps ?? 0,
          shareFeesWithHolders: options.shareFeesWithHolders ?? false,
        },
        options.snipeExemptions ?? [],
      ],
      { account: wallet.account, value: LAUNCH_FEE }
    );
    await publicClient.waitForTransactionReceipt({ hash });
    // The snipe tax runs for the first seconds after a launch. Almost every test wants the
    // curve as it is after that, so the clock is moved past it unless asked otherwise.
    if (!options.inWindow) await time.increase(SNIPE_TAX_SECONDS + 1);
    const address = getAddress(await coinFactory.read.getAddress([symbol])) as Address;
    return hre.viem.getContractAt('Coin', address, { client: { wallet } });
  }

  type Coin = Awaited<ReturnType<typeof launch>>;

  /** Buys on the curve: approves `amount` of the coin's reserve token and spends it. */
  async function buy(coin: Coin, wallet: Wallet, amount: bigint, minOut = 0n) {
    const token = await erc20(await coin.read.reserveToken(), wallet);
    const approval = await token.write.approve([coin.address, amount], { account: wallet.account });
    await publicClient.waitForTransactionReceipt({ hash: approval });
    const hash = await coin.write.buy([amount, minOut], { account: wallet.account });
    return publicClient.waitForTransactionReceipt({ hash });
  }

  async function sell(coin: Coin, wallet: Wallet, amount: bigint, minOut = 0n) {
    const hash = await coin.write.sell([amount, minOut], { account: wallet.account });
    return publicClient.waitForTransactionReceipt({ hash });
  }

  /** Approves everything a liquidity provider might spend, once. */
  async function approveAll(wallet: Wallet, tokens: Address[], spender: Address) {
    for (const address of tokens) {
      const token = await erc20(address, wallet);
      const hash = await token.write.approve([spender, maxUint256], { account: wallet.account });
      await publicClient.waitForTransactionReceipt({ hash });
    }
  }

  return {
    owner: owner!,
    alice: alice!,
    bob: bob!,
    carol: carol!,
    publicClient,
    weth,
    dollar,
    v3Factory,
    swapRouter,
    quoter,
    formula,
    treasury,
    feeEscrow,
    listingManager,
    coinCreator,
    coinFactory,
    holderRewards,
    liquidityManager,
    erc20,
    launch,
    buy,
    sell,
    approveAll,
  };
}

/** What the curve keeps of a payment once the 1% fee has come off, and no creator tax. */
export function netOfFee(amount: bigint): bigint {
  return amount - (amount * FEE_BPS) / BPS;
}

/**
 * The quote asset per whole coin implied by a pool's sqrtPriceX96, at eighteen decimals whatever
 * the quote's own — which is how every contract here states a price.
 */
export function poolPriceX18(sqrtPriceX96: bigint, coinIsToken0: boolean, quoteDecimals = 18): bigint {
  const q192 = 1n << 192n;
  const ratioX192 = sqrtPriceX96 * sqrtPriceX96; // token1 per token0 in raw units, scaled by 2^192
  const scale = 10n ** BigInt(18 - quoteDecimals);
  return coinIsToken0
    ? (ratioX192 * 10n ** 18n * scale) / q192
    : (q192 * 10n ** 18n * scale) / ratioX192;
}

/** Newton's method, integer square root. Exact for a perfect square, floored otherwise. */
function isqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x0 = value;
  let x1 = (x0 + 1n) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }
  return x0;
}

/**
 * The sqrtPriceX96 a pool should be initialized at for `priceX18` (the quote asset per whole
 * coin, at eighteen decimals whatever the quote's own — the exact convention `poolPriceX18`
 * reads back) — the inverse of that function, and how a test opens a pool at a chosen price
 * without going through a curve.
 */
export function sqrtPriceX96For(priceX18: bigint, coinIsToken0: boolean, quoteDecimals = 18): bigint {
  const q192 = 1n << 192n;
  const scale = 10n ** BigInt(18 - quoteDecimals);
  const ratioX192 = coinIsToken0
    ? (priceX18 * q192) / (10n ** 18n * scale)
    : (q192 * 10n ** 18n * scale) / priceX18;
  return isqrt(ratioX192);
}

/** |a - b| / b, as parts per million. */
export function ppm(a: bigint, b: bigint): bigint {
  if (b === 0n) return a === 0n ? 0n : 1_000_000n;
  const diff = a > b ? a - b : b - a;
  return (diff * 1_000_000n) / b;
}
