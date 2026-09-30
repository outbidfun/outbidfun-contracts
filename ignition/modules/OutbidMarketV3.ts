import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/**
 * The Outbid market behind a proxy (contracts/OutbidMarket.sol, UUPS; contracts/OutbidMarketProxy.sol,
 * ERC-1967), replacing `OutbidMarketV2#OutbidMarket`. Behind one address for good — the board, the
 * site, the subgraph and DefiLlama keep it through every later version, which the owner installs
 * with `upgradeToAndCall`. It takes bids on the launchpad's own coins as before, split 75 / 20 / 5,
 * and on coins PONS launched (`PonsTokenRegistry`) as ad spots, split 80 / 20 between the $OUTBID
 * buyback and the treasury.
 *
 * The proxy initializes the implementation in its own constructor, so the market is never open to
 * anyone else's `initialize`. It is deployed empty and open for migration:
 * `scripts/migrate-market.ts` with OLD_MARKET and NEW_MARKET carries V2's board over, freezes V2,
 * and closes the migration, before the site points at the proxy
 * (`NEXT_PUBLIC_OUTBID_MARKET_ADDRESS`).
 *
 * Parameters (`ignition/config/outbid-market-v3.json`, `outbid-market-v3-testnet.json`), each
 * read from the market it replaces where that has it:
 *   usdg, weth, poolManager   what it is paid in, wrapped ether, and the V4 PoolManager
 *   buyback, treasury         where the shares go
 *   minBid, outbidIncrement   the floor and the step, in USDG at 18 decimals
 *   registry                  the launchpad's coins (TokenRegistryUnion)
 *   executor                  the SwapExecutor `bidVia` swaps through (zero: none)
 *   ponsFactories             PONS's launch factories, `{ factory, kind }`: kind 0 for
 *                             PonsLaunchFactory, 1 for the V2 factory
 */
const OutbidMarketV3Module = buildModule('OutbidMarketV3', (m) => {
  const owner = m.getAccount(0);
  const implementation = m.contract('OutbidMarket', [], { id: 'Implementation' });
  const initialize = m.encodeFunctionCall(implementation, 'initialize', [
    owner,
    m.getParameter<string>('usdg'),
    m.getParameter<string>('weth'),
    m.getParameter<string>('poolManager'),
    m.getParameter<string>('buyback'),
    m.getParameter<string>('treasury'),
    m.getParameter<bigint>('minBid'),
    m.getParameter<bigint>('outbidIncrement'),
  ]);
  const proxy = m.contract('OutbidMarketProxy', [implementation, initialize], { id: 'Proxy' });
  const market = m.contractAt('OutbidMarket', proxy, { id: 'Market' });
  const pons = m.contract('PonsTokenRegistry', [owner, m.getParameter('ponsFactories')], { id: 'PonsTokenRegistry' });

  m.call(market, 'setRegistry', [m.getParameter<string>('registry')], { id: 'setRegistry' });
  m.call(market, 'setExternalRegistry', [pons], { id: 'setExternalRegistry' });
  m.call(market, 'setExecutor', [m.getParameter<string>('executor')], { id: 'setExecutor' });
  return { market, proxy, implementation, pons };
});

export default OutbidMarketV3Module;
