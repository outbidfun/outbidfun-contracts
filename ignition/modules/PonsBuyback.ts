import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/** The PONS V2 launch factory on Robinhood Chain (github.com/ponsdotdev/pons-labs). */
const PONS_V2_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const ETHER = '0x0000000000000000000000000000000000000000';

/**
 * Turns the buyback on, once $OUTBID has launched on PONS. Run it after the token exists.
 *
 * It deploys the PONS venue, names the Uniswap V4 pool ether is swapped through into $OUTBID's
 * pair asset (USDG, say) — most revenue arrives as ether, and PONS trades a launch only in its
 * pair — and enables the vault with the token and the venue. Enabling is once: the vault can
 * never be pointed at another token afterwards. The venue can be replaced later with
 * `buyback.setVenue`, and routes changed with `venue.setRoute`.
 *
 * Parameters (see ignition/config/pons-buyback.example.json):
 *   buyback            the OutbidBuyback the OutbidEconomy module deployed
 *   outbidToken        $OUTBID's address on PONS
 *   pairToken          the asset $OUTBID was launched against on PONS
 *   routeFee           the ether/pair V4 pool's fee, in hundredths of a basis point (500 = 0.05%)
 *   routeTickSpacing   its tick spacing
 *   routeHooks         its hook, zero for a plain pool
 *   pons               the PONS V2 factory; defaults to the live one
 *
 * The route pool must already exist on the PoolManager PONS uses; the venue reads that manager
 * from the PONS factory. On Robinhood Chain the plain ETH/USDG pool at 0.05% and tick spacing 10
 * is one such.
 *
 * For a launch paired with ether itself, no route is needed: pass the zero address as
 * `pairToken`, and the route this module sets is never used.
 */
const PonsBuybackModule = buildModule('PonsBuyback', (m) => {
  const owner = m.getAccount(0);
  const pons = m.getParameter<string>('pons', PONS_V2_FACTORY);
  const buybackAddress = m.getParameter<string>('buyback');
  const outbidToken = m.getParameter<string>('outbidToken');
  const pairToken = m.getParameter<string>('pairToken');
  const routeFee = m.getParameter('routeFee', 500);
  const routeTickSpacing = m.getParameter('routeTickSpacing', 10);
  const routeHooks = m.getParameter<string>('routeHooks', ETHER);

  const venue = m.contract('PonsBuybackVenue', [owner, pons]);
  // Ether is currency zero in V4 and sorts below every token, so it is always currency0.
  m.call(venue, 'setRoute', [
    ETHER,
    { currency0: ETHER, currency1: pairToken, fee: routeFee, tickSpacing: routeTickSpacing, hooks: routeHooks },
  ]);

  const buyback = m.contractAt('OutbidBuyback', buybackAddress);
  m.call(buyback, 'enableBuyback', [outbidToken, venue]);

  return { venue };
});

export default PonsBuybackModule;
