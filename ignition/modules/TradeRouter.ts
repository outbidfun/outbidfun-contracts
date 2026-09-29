import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/**
 * The trade router: a second SwapExecutor (contracts/SwapExecutor.sol), the one the site sends every
 * trade through — swaps across the AMMs, and buys and sells on this platform's bonding curves — so
 * the trading fee is taken in the same transaction. The OutbidMarket keeps the first executor, with
 * no fee, for the swaps inside bids.
 *
 * Deployed with the platform's first SwapRouter listed; every other router is listed after it by
 * `scripts/executor-venues.ts` with EXECUTOR_DEPLOYMENT and EXECUTOR_KEY naming this one. The
 * deployer owns it; `setFee` changes the fee, never above 0.25%. Put its address in
 * `NEXT_PUBLIC_TRADE_ROUTER_ADDRESS`.
 *
 * Parameters (`ignition/config/trade-router.json`, `trade-router-testnet.json`):
 *   weth            the wrapped ether every listed router wraps into
 *   platformRouter  the platform's first v3-periphery SwapRouter
 *   usdg            a fee asset besides wrapped ether: a fee is taken in it where a trade has it
 *   coins           the registry of coins its curve trades may be made in (TokenRegistryUnion)
 *   feeBps          the fee, in basis points: 5 is 0.05%
 *   feeRecipient    who is paid it: the RevenueRouter, like every other protocol fee
 */
const TradeRouterModule = buildModule('TradeRouter', (m) => {
  const owner = m.getAccount(0);
  const router = m.contract('SwapExecutor', [m.getParameter<string>('weth'), owner], { id: 'TradeRouter' });
  m.call(router, 'setVenue', [m.getParameter<string>('platformRouter'), 1], { id: 'listPlatformRouter' });
  m.call(router, 'setFeeAsset', [m.getParameter<string>('usdg'), true], { id: 'usdgIsFeeAsset' });
  m.call(router, 'setCoins', [m.getParameter<string>('coins')], { id: 'setCoins' });
  m.call(router, 'setFee', [m.getParameter<number>('feeBps'), m.getParameter<string>('feeRecipient')], { id: 'setFee' });
  return { router };
});

export default TradeRouterModule;
