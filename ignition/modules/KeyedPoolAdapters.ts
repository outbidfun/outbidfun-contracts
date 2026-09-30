import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/**
 * A `UniversalRouterAdapter` (contracts/UniversalRouterAdapter.sol) in front of each keyed-pool
 * AMM's Universal Router: PancakeSwap Infinity's and Uniswap v4's. The executors already deployed
 * call either as they call any V3 router, once the owner lists it as a periphery router
 * (`scripts/executor-venues.ts`, from `ignition/config/executor-venues-<chain>.json`, on the market's
 * executor and on the trade router), so no executor is redeployed for them. Each has no owner and
 * holds nothing. Put their addresses in `apps/web/src/constants/swapProviders.ts` as the two
 * providers' `router`.
 *
 * Parameters (`ignition/config/keyed-adapters.json`):
 *   weth             the wrapped ether both routers wrap into
 *   infinityRouter   PancakeSwap Infinity's Universal Router
 *   uniswapV4Router  Uniswap v4's Universal Router
 */
const KeyedPoolAdaptersModule = buildModule('KeyedPoolAdapters', (m) => {
  const weth = m.getParameter<string>('weth');
  // UniversalRouterAdapter.Flavor: 0 is Infinity, 1 is Uniswap v4.
  const infinity = m.contract('UniversalRouterAdapter', [m.getParameter<string>('infinityRouter'), 0, weth], { id: 'InfinityAdapter' });
  const uniswapV4 = m.contract('UniversalRouterAdapter', [m.getParameter<string>('uniswapV4Router'), 1, weth], { id: 'UniswapV4Adapter' });
  return { infinity, uniswapV4 };
});

export default KeyedPoolAdaptersModule;
