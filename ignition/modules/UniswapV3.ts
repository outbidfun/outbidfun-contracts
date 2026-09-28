import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/**
 * The platform's own Uniswap V3: factory, SwapRouter and QuoterV2, built from the vendored
 * sources under contracts/uniswap-v3.
 *
 * Required parameter `weth`: the chain's WETH9. Where the chain has none, deploy
 * ignition/modules/WETH9.ts first and pass its address.
 *
 * The factory is owned by the deployer until the Launchpad module hands it to the
 * CoinListingManager, which is the only account that may open pools from then on.
 */
const UniswapV3Module = buildModule('UniswapV3', (m) => {
  const weth = m.getParameter<string>('weth');

  const v3Factory = m.contract('UniswapV3Factory', []);
  const swapRouter = m.contract('SwapRouter', [v3Factory, weth]);
  const quoter = m.contract('QuoterV2', [v3Factory, weth]);

  return { v3Factory, swapRouter, quoter };
});

export default UniswapV3Module;
