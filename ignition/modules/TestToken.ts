import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/**
 * A plain ERC20 for networks that lack an asset the platform needs: on Robinhood Chain's testnet
 * there is no USDG, and every bid is paid in USDG. `MockERC20.mint` is open, so anyone can give
 * themselves test dollars. Never deploy this where the real asset exists.
 *
 * Parameters (`ignition/config/test-usdg.json`): `name`, `symbol`, `decimals`, and `supply`
 * minted to the deployer, in raw units.
 */
const TestTokenModule = buildModule('TestToken', (m) => {
  const name = m.getParameter('name', 'Global Dollar');
  const symbol = m.getParameter('symbol', 'USDG');
  const decimals = m.getParameter('decimals', 6);
  const supply = m.getParameter('supply', 0n);

  const token = m.contract('MockERC20', [name, symbol, decimals, supply]);

  return { token };
});

export default TestTokenModule;
