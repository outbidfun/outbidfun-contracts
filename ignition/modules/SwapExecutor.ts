import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/**
 * The SwapExecutor (contracts/SwapExecutor.sol): where the swap page sends a trade no one AMM's
 * router can run — legs across several AMMs, or a route whose pools span them — to be run in one
 * transaction, inside the trader's terms. Deployed with the platform's own SwapRouter listed as
 * its first venue; every other AMM's router is listed after it by `scripts/executor-venues.ts`,
 * from `ignition/config/executor-venues-<chain>.json`, once its address is confirmed.
 *
 * The deployer owns it and lists the venues; hand it to the multisig with the rest
 * (`transfer-ownership`). Put its address in `NEXT_PUBLIC_SWAP_EXECUTOR_ADDRESS` for the page to use it.
 *
 * Parameters (`ignition/config/base.json`, `robinhood-testnet.json`):
 *   weth            the wrapped ether every listed router wraps into
 *   platformRouter  the platform's own v3-periphery SwapRouter (UniswapV3#SwapRouter)
 */
const SwapExecutorModule = buildModule('SwapExecutor', (m) => {
  const owner = m.getAccount(0);
  const weth = m.getParameter<string>('weth');
  const platformRouter = m.getParameter<string>('platformRouter');

  const executor = m.contract('SwapExecutor', [weth, owner]);
  // Venue 1: v3-periphery's SwapRouter, the deadline in the params.
  m.call(executor, 'setVenue', [platformRouter, 1], { id: 'listPlatformRouter' });

  return { executor };
});

export default SwapExecutorModule;
