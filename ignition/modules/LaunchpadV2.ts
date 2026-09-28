import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { parseEther } from 'viem';
import UniswapV3Module from './UniswapV3';

/**
 * The launchpad on the constant-product curve (AUDIT-6), beside the one it replaces: its own
 * Uniswap V3 (factory, router, quoter — the UniswapV3 module, which needs `weth` in its own
 * section of the parameters), a CoinListingManager that owns that factory, a CoinCreator, a
 * CoinFactory, a LiquidityManager for the new pools, and a TokenRegistryUnion of the two
 * factories so the outbid market keeps taking bids on the first factory's coins.
 *
 * Two stacks, because only a V3 factory's owner can open pools in it: the first listing manager
 * keeps its factory, so the coins on the old curve graduate as they always would, and the new
 * manager opens the new coins' pools in a factory of its own. The treasury door (the
 * RevenueRouter), the FeeEscrow and the HolderRewards implementation are shared as they are.
 *
 * Parameters (`ignition/config/launchpad-v2.json`, each read from the deployment it joins):
 *   treasury                  where the protocol's share of every fee goes: the RevenueRouter
 *   feeEscrow, holderRewards  reused as they are
 *   oldFactory                the CoinFactory being replaced, for the registry union
 *   weth, wethCap, poolFee    the first asset the new factory lists, and the pool tier
 *
 * After this module, `scripts/migrate-launchpad.ts` carries the other listed assets across
 * with their caps, pauses every asset on the old factory, and points the market at the union;
 * `scripts/executor-venues.ts` lists the new router on the SwapExecutor.
 */
const LaunchpadV2Module = buildModule('LaunchpadV2', (m) => {
  const owner = m.getAccount(0);
  const treasury = m.getParameter<string>('treasury');
  const feeEscrow = m.getParameter<string>('feeEscrow');
  const holderRewards = m.getParameter<string>('holderRewards');
  const oldFactory = m.getParameter<string>('oldFactory');
  const weth = m.getParameter<string>('weth');
  const wethCap = m.getParameter('wethCap', parseEther('4.2'));
  const poolFee = m.getParameter('poolFee', 10_000);

  const { v3Factory, swapRouter, quoter } = m.useModule(UniswapV3Module);

  const listingManager = m.contract('CoinListingManager', [owner, treasury, v3Factory, feeEscrow, poolFee]);
  const coinCreator = m.contract('CoinCreator', [owner]);
  const coinFactory = m.contract('CoinFactory', [listingManager, feeEscrow, coinCreator, holderRewards]);
  const registry = m.contract('TokenRegistryUnion', [oldFactory, coinFactory]);
  const liquidityManager = m.contract('LiquidityManager', [v3Factory]);

  m.call(coinCreator, 'setFactory', [coinFactory]);
  m.call(listingManager, 'setCoinFactory', [coinFactory]);
  // Only the listing manager opens pools in the new factory.
  m.call(v3Factory, 'setOwner', [listingManager]);
  m.call(coinFactory, 'setQuoteAsset', [weth, wethCap, true]);

  return { v3Factory, swapRouter, quoter, listingManager, coinCreator, coinFactory, registry, liquidityManager };
});

export default LaunchpadV2Module;
