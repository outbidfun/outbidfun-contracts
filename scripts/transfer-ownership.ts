/**
 * Hands every contract the deployer owns to a new owner — a multisig, such as a Safe — on one
 * network, from that network's Ignition deployment record (ignition/deployments/chain-<id>).
 *
 *   NEW_OWNER=0x… pnpm --filter @outbidfun/protocol transfer-ownership --network robinhood
 *   NEW_OWNER=0x… EXECUTE=1 pnpm --filter @outbidfun/protocol transfer-ownership --network robinhood
 *
 * Without EXECUTE it only prints what it would do. The contracts use OpenZeppelin's one-step
 * `Ownable`: the transfer takes effect at once and nothing asks the new owner to accept, so an
 * address with a typo is control lost for good. The script therefore refuses an address with no
 * code (an EOA, or nothing) unless ALLOW_EOA=1, and shows a Safe's owners and threshold before
 * anything is sent. Do the owner-only setup first (bid routes, the buyback keeper): after this,
 * each of those is a multisig transaction.
 *
 * The Uniswap V3 factory is not on the list: the listing manager owns it, and moves with it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import hre from 'hardhat';
import { getAddress, isAddress, parseAbi, type Address } from 'viem';

/** Every contract in a deployment record that has an owner the deployer can hand on. */
const OWNED = [
  'Outbidfun#Treasury',
  'Outbidfun#OutbidMarket',
  'Launchpad#CoinCreator',
  'Launchpad#CoinListingManager',
  'Launchpad#CoinFactory',
  'OutbidEconomy#OutbidBuyback',
  'OutbidEconomy#RevenueRouter',
] as const;

const ownableAbi = parseAbi([
  'function owner() view returns (address)',
  'function transferOwnership(address newOwner)',
]);
const safeAbi = parseAbi(['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)']);

const client = await hre.viem.getPublicClient();
const chainId = await client.getChainId();
const [wallet] = await hre.viem.getWalletClients();
if (!wallet) throw new Error('DEPLOYER_PRIVATE_KEY is not set in packages/protocol/.env.');
const me = getAddress(wallet.account.address);
const execute = process.env.EXECUTE === '1';

const deployed = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'ignition', 'deployments', `chain-${chainId}`, 'deployed_addresses.json'), 'utf8')
) as Record<string, Address>;

const target = process.env.NEW_OWNER?.trim();
console.log(`\nChain      ${chainId}`);
console.log(`Deployer   ${me}`);

let newOwner: Address | undefined;
if (!target) {
  console.log('NEW_OWNER  not set: showing the current owners only.');
} else {
  if (!isAddress(target)) throw new Error(`NEW_OWNER ${target} is not an address.`);
  newOwner = getAddress(target);
  if (newOwner === me) throw new Error('NEW_OWNER is the deployer itself.');
  const code = await client.getCode({ address: newOwner });
  if (!code || code === '0x') {
    if (process.env.ALLOW_EOA !== '1') {
      throw new Error(`NEW_OWNER ${newOwner} has no code on chain ${chainId}: not a multisig. Set ALLOW_EOA=1 to hand ownership to a plain wallet anyway.`);
    }
    console.log(`NEW_OWNER  ${newOwner} — a plain wallet (ALLOW_EOA=1)`);
  } else {
    const [owners, threshold] = await Promise.all([
      client.readContract({ address: newOwner, abi: safeAbi, functionName: 'getOwners' }).catch(() => undefined),
      client.readContract({ address: newOwner, abi: safeAbi, functionName: 'getThreshold' }).catch(() => undefined),
    ]);
    if (owners && threshold !== undefined) {
      console.log(`NEW_OWNER  ${newOwner} — a Safe, ${threshold} of ${owners.length}:`);
      for (const owner of owners) console.log(`             ${owner}`);
    } else {
      console.log(`NEW_OWNER  ${newOwner} — a contract, not a Safe this script recognises; check it can call transferOwnership.`);
    }
  }
}
console.log('');

const plan: { name: string; address: Address }[] = [];
for (const name of OWNED) {
  const address = deployed[name];
  if (!address) {
    console.log(`  ${name.padEnd(30)} not in this deployment`);
    continue;
  }
  const owner = getAddress(await client.readContract({ address, abi: ownableAbi, functionName: 'owner' }));
  const mine = owner === me;
  console.log(`  ${name.padEnd(30)} ${address}  owner ${owner}${mine ? ' (deployer)' : ''}`);
  if (mine) plan.push({ name, address });
}

if (!newOwner) process.exit(0);
if (plan.length === 0) {
  console.log('\nThe deployer owns none of them; nothing to do.');
  process.exit(0);
}
if (!execute) {
  console.log(`\nDry run: ${plan.length} transfer(s) to ${newOwner}. Run again with EXECUTE=1 to send them.`);
  process.exit(0);
}

console.log('');
for (const { name, address } of plan) {
  const hash = await wallet.writeContract({ address, abi: ownableAbi, functionName: 'transferOwnership', args: [newOwner] });
  await client.waitForTransactionReceipt({ hash });
  const owner = getAddress(await client.readContract({ address, abi: ownableAbi, functionName: 'owner' }));
  console.log(`  ${name.padEnd(30)} ${owner === newOwner ? 'handed over' : `STILL ${owner}`}  ${hash}`);
}
console.log('');
