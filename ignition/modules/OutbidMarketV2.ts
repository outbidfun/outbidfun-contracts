import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/**
 * The Outbid market that takes a bid on any coin, paid with anything (contracts/OutbidMarket.sol,
 * `bidVia`), replacing the first one, which took coins priced in USDG only. It keeps the first
 * one's terms — the same vault, treasury and launchpad, the same floor and step — and routes through
 * the swap page's SwapExecutor.
 *
 * Deployed empty and open for migration: `scripts/migrate-market.ts` carries the first market's
 * board over, freezes the first market, and closes the migration, before the site points at this
 * one (`NEXT_PUBLIC_OUTBID_MARKET_ADDRESS`).
 *
 * Parameters (`ignition/config/base.json`), each read from the market it replaces:
 *   usdg, weth, poolManager   what it is paid in, wrapped ether, and the V4 PoolManager
 *   buyback, treasury         where the 20% and the 5% go
 *   registry                  the CoinFactory: only coins it launched can be bid on
 *   executor                  the SwapExecutor `bidVia` swaps through
 *   minBid, outbidIncrement   the floor and the step, in USDG at 18 decimals
 */
const OutbidMarketV2Module = buildModule('OutbidMarketV2', (m) => {
  const owner = m.getAccount(0);
  const market = m.contract('OutbidMarket', [
    owner,
    m.getParameter<string>('usdg'),
    m.getParameter<string>('weth'),
    m.getParameter<string>('poolManager'),
    m.getParameter<string>('buyback'),
    m.getParameter<string>('treasury'),
    m.getParameter<bigint>('minBid'),
    m.getParameter<bigint>('outbidIncrement'),
  ]);
  m.call(market, 'setRegistry', [m.getParameter<string>('registry')], { id: 'setRegistry' });
  m.call(market, 'setExecutor', [m.getParameter<string>('executor')], { id: 'setExecutor' });
  return { market };
});

export default OutbidMarketV2Module;
