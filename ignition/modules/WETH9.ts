import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/** Wrapped Ether, for networks that have no canonical WETH yet (local nodes, fresh testnets). */
const WETH9Module = buildModule('WETH9', (m) => {
  const weth = m.contract('WETH9', []);
  return { weth };
});

export default WETH9Module;
