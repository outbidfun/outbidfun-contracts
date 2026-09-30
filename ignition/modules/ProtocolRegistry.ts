import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';

/**
 * The protocol registry (contracts/ProtocolRegistry.sol): the one permanent address that says which
 * contracts are outbidfun.lol's, by kind, each with its deployment block. DefiLlama's adapters and
 * the subgraph read it, so a redeploy is a `register` call here rather than a change to each of
 * them. Append-only and not upgradeable: deployed once per network, for good.
 *
 * The deployer owns it; `scripts/register-contracts.ts` registers what
 * `ignition/config/registry-<chain>.json` lists, and the owner registers every contract deployed
 * after it. Hand it to the multisig with the rest (`transfer-ownership`).
 */
const ProtocolRegistryModule = buildModule('ProtocolRegistry', (m) => {
  const registry = m.contract('ProtocolRegistry', [m.getAccount(0)]);
  return { registry };
});

export default ProtocolRegistryModule;
