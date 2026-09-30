/**
 * Registers in the ProtocolRegistry what `ignition/config/registry-<chain>.json` lists.
 *
 *   pnpm --filter @outbidfun/protocol register-contracts --network robinhood             # dry run
 *   EXECUTE=1 pnpm --filter @outbidfun/protocol register-contracts --network robinhood   # send
 *
 * The registry is `ProtocolRegistry#ProtocolRegistry` in `chain-<id>-registry`, and the caller must
 * own it. An entry is an address, or `deployment` and `key` naming one in an Ignition record. Each
 * is checked first: it must have code, and a deployment block no later than the chain's own head
 * (the registry takes it as given: on an Arbitrum chain `block.number` inside a contract is the
 * parent chain's, so it cannot check). One already registered as its kind is left as it is; one
 * registered as another kind stops the run, since the registry never changes what it said. What
 * is left is sent in one `registerMany`, in the file's order, and read back afterwards. Without
 * EXECUTE it only prints the plan.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import hre from 'hardhat';
import { getAddress, hexToString, stringToHex, type Address } from 'viem';

type Entry = { kind: string; name: string; fromBlock: number } & ({ address: string } | { deployment: string; key: string });

const client = await hre.viem.getPublicClient();
const chainId = await client.getChainId();
const [wallet] = await hre.viem.getWalletClients();
if (!wallet) throw new Error('DEPLOYER_PRIVATE_KEY is not set in packages/protocol/.env.');
const execute = process.env.EXECUTE === '1';

const root = join(import.meta.dirname, '..', 'ignition');
const recordOf = (deployment: string): Record<string, Address> => {
  const file = join(root, 'deployments', deployment, 'deployed_addresses.json');
  if (!existsSync(file)) throw new Error(`No Ignition record ${deployment}.`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, Address>;
};

const registryAddress = recordOf(`chain-${chainId}-registry`)['ProtocolRegistry#ProtocolRegistry'];
if (!registryAddress) throw new Error(`No ProtocolRegistry#ProtocolRegistry in chain-${chainId}-registry.`);
const registry = await hre.viem.getContractAt('ProtocolRegistry', registryAddress);
const { entries } = JSON.parse(readFileSync(join(root, 'config', `registry-${chainId}.json`), 'utf8')) as { entries: Entry[] };

const owner = getAddress(await registry.read.owner());
console.log(`\nChain      ${chainId}`);
console.log(`Registry   ${registryAddress}, owned by ${owner}${owner === getAddress(wallet.account.address) ? ' (this key)' : ''}\n`);

const head = await client.getBlockNumber();
const plan: { kind: Address; target: Address; fromBlock: bigint }[] = [];
for (const entry of entries) {
  const target = getAddress('address' in entry ? entry.address : recordOf(entry.deployment)[entry.key] ?? '');
  const label = `${entry.kind.padEnd(19)} ${entry.name.padEnd(32)} ${target}`;
  const code = await client.getCode({ address: target });
  if (!code || code === '0x') throw new Error(`${label}: no code there.`);
  if (!Number.isInteger(entry.fromBlock) || entry.fromBlock < 1 || BigInt(entry.fromBlock) > head) {
    throw new Error(`${label}: deployment block ${entry.fromBlock} is not a block of this chain's (head ${head}).`);
  }
  const kind = stringToHex(entry.kind, { size: 32 });
  const current = await registry.read.kindOf([target]);
  if (current === kind) {
    console.log(`  ${label}  already registered`);
    continue;
  }
  if (!/^0x0{64}$/.test(current)) throw new Error(`${label}: registered as ${hexToString(current, { size: 32 })}, which cannot change.`);
  console.log(`  ${label}  from block ${entry.fromBlock}, to register`);
  plan.push({ kind, target, fromBlock: BigInt(entry.fromBlock) });
}

if (plan.length === 0) {
  console.log('\nNothing to register.');
  process.exit(0);
}
if (!execute) {
  console.log(`\nDry run: ${plan.length} contract(s) to register. Run again with EXECUTE=1 to send.`);
  process.exit(0);
}

const hash = await registry.write.registerMany([plan.map((p) => p.kind), plan.map((p) => p.target), plan.map((p) => p.fromBlock)]);
await client.waitForTransactionReceipt({ hash });
for (const { kind, target } of plan) {
  const registered = (await registry.read.kindOf([target])) === kind;
  console.log(`  ${hexToString(kind, { size: 32 }).padEnd(19)} ${target}  ${registered ? 'registered' : 'NOT REGISTERED'}`);
}
console.log(`\n${hash}\n`);
