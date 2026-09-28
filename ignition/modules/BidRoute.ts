import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/**
 * Names the Uniswap V4 pools one asset is swapped to USDG through when a bidder pays with it, so
 * bids can be paid in that asset: one pool pairing it with USDG, or up to three in a row — a
 * share to ether, say, then ether to USDG. Ether is the zero address, as the asset and on the
 * way, and wrapped ether uses ether's route.
 *
 * One asset per run, because Ignition parameters cannot be iterated; give each asset its own
 * deployment id (`--deployment-id bid-route-<ticker>`), since a second run under the same id
 * with another asset reads as a changed argument.
 *
 * Parameters (`ignition/config/bid-route-*.json`):
 *   market   the OutbidMarket
 *   assetIn  the asset bidders pay with; the zero address for ether
 *   path     the pools' keys in order, from `assetIn` to USDG, each as the PoolManager keeps it:
 *            currency0 and currency1 sorted, fee, tickSpacing, hooks
 */
const BidRouteModule = buildModule('BidRoute', (m) => {
  const market = m.contractAt('OutbidMarket', m.getParameter<string>('market'));
  const assetIn = m.getParameter<string>('assetIn', '0x0000000000000000000000000000000000000000');
  const path = m.getParameter('path');

  m.call(market, 'setRoute', [assetIn, path]);

  return { market };
});

export default BidRouteModule;
