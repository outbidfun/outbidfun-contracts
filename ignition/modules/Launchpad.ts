import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { parseEther } from 'viem';
import OutbidfunModule from './Outbidfun';
import UniswapV3Module from './UniswapV3';

/**
 * The whole platform: Treasury and OutbidMarket (Outbidfun module), the Uniswap V3 stack
 * (UniswapV3 module, needs the `weth` parameter), then the curve formula, the listing manager
 * and the CoinFactory, wired together:
 *
 *   - the listing manager becomes the V3 factory's owner, so only it can open pools;
 *   - the CoinFactory is the only caller allowed to ask the manager for a pool;
 *   - the OutbidMarket accepts bids only for coins the CoinFactory launched.
 *
 * A coin is priced in an asset the factory lists, and a fresh factory lists nothing. This module
 * lists WETH with a `wethCap` (4.2 ETH by default, PONS's graduation target) so a deployment is
 * usable as soon as it lands;
 * every other asset — a stablecoin, a tokenised share — is one run of `QuoteAsset.ts` each,
 * because Ignition parameters cannot be iterated and the assets differ per chain.
 *
 * The fee escrow is where creators' shares of fees wait to be claimed; the listing manager and
 * every coin credit it. The CoinCreator holds Coin's creation code and is bound to the factory
 * once both exist, because the factory cannot carry that code itself and stay under the size
 * limits. Fee terms and the launch fee are the factory's defaults — PONS's — and the owner can
 * change them for launches from then on with `setFeeTerms` and `setLaunchFee`.
 *
 * The LiquidityManager rides along: it is how anyone other than the protocol puts liquidity
 * into a pool here, and it needs no permission from anything else.
 *
 * Optional parameter `poolFee`: fee tier for coin pools in hundredths of a bip (default 1%).
 */
const LaunchpadModule = buildModule('Launchpad', (m) => {
  const owner = m.getAccount(0);
  const poolFee = m.getParameter('poolFee', 10_000);
  const weth = m.getParameter<string>('weth');
  const wethCap = m.getParameter('wethCap', parseEther('4.2'));

  const { treasury, auction } = m.useModule(OutbidfunModule);
  const { v3Factory, swapRouter, quoter } = m.useModule(UniswapV3Module);

  const formula = m.contract('Formula', []);
  m.call(formula, 'init');

  const feeEscrow = m.contract('FeeEscrow', []);
  const listingManager = m.contract('CoinListingManager', [owner, treasury, v3Factory, feeEscrow, poolFee]);
  const coinCreator = m.contract('CoinCreator', [owner]);
  // Every reward coin gets a clone of this distributor at launch.
  const holderRewards = m.contract('HolderRewards', []);
  const coinFactory = m.contract('CoinFactory', [formula, listingManager, feeEscrow, coinCreator, holderRewards]);
  // Third-party liquidity. It finds pools on the factory rather than through the listing
  // manager, so it reaches every pool on this deployment — OUTBID's included, which `poolOf`
  // never knows about. Nothing above depends on it; a deployment without it still works.
  const liquidityManager = m.contract('LiquidityManager', [v3Factory]);

  m.call(coinCreator, 'setFactory', [coinFactory]);
  m.call(listingManager, 'setCoinFactory', [coinFactory]);
  m.call(v3Factory, 'setOwner', [listingManager]);
  m.call(auction, 'setRegistry', [coinFactory]);
  m.call(coinFactory, 'setQuoteAsset', [weth, wethCap, true]);

  return {
    treasury,
    auction,
    v3Factory,
    swapRouter,
    quoter,
    formula,
    feeEscrow,
    listingManager,
    coinCreator,
    coinFactory,
    holderRewards,
    liquidityManager,
  };
});

export default LaunchpadModule;
