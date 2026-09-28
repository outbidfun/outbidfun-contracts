import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import LaunchpadModule from './Launchpad';

/**
 * Deploys the $OUTBID revenue economy on top of the launchpad: the revenue router with the 80/20
 * split and the buyback vault — and then wires the protocol's money to them. The listing
 * manager's treasury is pointed at the router, so every launch fee and the protocol's share of
 * every trading fee arrive there, in whatever asset they were paid, and are split 80% to the
 * buyback and 20% to operations; operations money lands in the Treasury contract. Bids do not go
 * through the router: the outbid market splits each one itself — 75% buys and burns the coin bid
 * on, 20% to the buyback vault, 5% to the treasury — and is pointed at the vault here.
 *
 * $OUTBID itself launches on PONS, later, so the vault is deployed without a token: it collects
 * its share from the first fee and spends none of it until the owner enables it with the token
 * and a venue (ignition/modules/PonsBuyback.ts). Revenue paid in anything but ether — the asset
 * a coin was priced in, a coin itself — waits in the vault the same way.
 *
 * After deploying, allowlist the keeper that will run buybacks: `buyback.setKeeper(keeper, true)`.
 * Nobody else can execute one.
 *
 * The launchpad's own parameters (`weth`, `wethCap`, `poolFee`) come from its section of the
 * same parameters file. An already-deployed launchpad in the same deployment folder is reused,
 * not redeployed.
 */
const OutbidEconomyModule = buildModule('OutbidEconomy', (m) => {
  const owner = m.getAccount(0);

  const cooldown = m.getParameter('buybackCooldown', 6n * 60n * 60n);
  const buybackBps = m.getParameter('buybackBps', 8000n);
  const operationsBps = m.getParameter('operationsBps', 2000n);

  const { treasury, auction, v3Factory, listingManager } = m.useModule(LaunchpadModule);
  const weth = m.getParameter<string>('weth');

  const buyback = m.contract('OutbidBuyback', [owner, weth, v3Factory, cooldown]);
  const revenueRouter = m.contract('RevenueRouter', [owner, buyback, treasury, buybackBps, operationsBps]);

  // The router becomes the door for fees; bids pay the vault and the treasury directly.
  m.call(listingManager, 'setTreasury', [revenueRouter]);
  m.call(auction, 'setDestinations', [buyback, treasury]);

  return { buyback, revenueRouter };
});

export default OutbidEconomyModule;
