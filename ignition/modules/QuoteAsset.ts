import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/**
 * Lists one more asset a coin can be priced in, on a CoinFactory that already exists.
 *
 * Required parameters:
 *   coinFactory   the Launchpad module's CoinFactory
 *   token         the asset's ERC20 — a stablecoin, a tokenised share, anything with ≤ 18 decimals
 *   cap           the reserve, in the asset's raw units, at which a coin priced in it graduates
 *
 * Run it once per asset, with a distinct `--deployment-id` each time so Ignition keeps them
 * apart. The same run with `enabled` false pauses an asset: coins already launched on it keep
 * trading, and nothing new launches against it.
 *
 *   pnpm --filter @outbidfun/protocol exec hardhat ignition deploy ignition/modules/QuoteAsset.ts \
 *     --network robinhood --parameters ignition/config/quote-usdg.json --deployment-id quote-usdg
 */
const QuoteAssetModule = buildModule('QuoteAsset', (m) => {
  const coinFactory = m.contractAt('CoinFactory', m.getParameter<string>('coinFactory'));
  const token = m.getParameter<string>('token');
  const cap = m.getParameter<bigint>('cap');
  const enabled = m.getParameter('enabled', true);

  m.call(coinFactory, 'setQuoteAsset', [token, cap, enabled]);

  return { coinFactory };
});

export default QuoteAssetModule;
