/**
 * Lists the AMM routers the SwapExecutor may call, from `ignition/config/executor-venues-<chain>.json`.
 *
 *   pnpm --filter @outbidfun/protocol executor-venues --network robinhood             # dry run
 *   EXECUTE=1 pnpm --filter @outbidfun/protocol executor-venues --network robinhood   # send
 *
 * The executor is the market's, `SwapExecutor#SwapExecutor` in `chain-<id>`, unless
 * EXECUTOR_DEPLOYMENT and EXECUTOR_KEY name another: the trade router is
 * `EXECUTOR_DEPLOYMENT=chain-<id>-trade-router EXECUTOR_KEY=TradeRouter#TradeRouter`.
 *
 * A venue names its router by address, or by `deployment` and `key` in an Ignition record — the
 * platform's own adapters (`KeyedPoolAdapters`), left out until that record exists. Every router is
 * checked on chain first: it must have code, and wrap into the same wrapped ether the executor
 * does (`WETH9()`), or it is left out. A router already listed as asked is left as it
 * is. The executor is the one in this network's deployment record, and the caller must own it.
 * Without EXECUTE it only prints the plan.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import hre from 'hardhat';
import { getAddress, parseAbi, type Address } from 'viem';

const routerAbi = parseAbi(['function WETH9() view returns (address)']);
const swapExecutorAbi = parseAbi([
  'function owner() view returns (address)',
  'function weth() view returns (address)',
  'function venues(address router) view returns (uint8)',
  'function setVenue(address router, uint8 venue)',
]);
const VENUE = ['unlisted', 'v3-periphery', 'SwapRouter02'];

const client = await hre.viem.getPublicClient();
const chainId = await client.getChainId();
const [wallet] = await hre.viem.getWalletClients();
if (!wallet) throw new Error('DEPLOYER_PRIVATE_KEY is not set in packages/protocol/.env.');
const execute = process.env.EXECUTE === '1';

const root = join(import.meta.dirname, '..', 'ignition');
const deployment = process.env.EXECUTOR_DEPLOYMENT || `chain-${chainId}`;
const key = process.env.EXECUTOR_KEY || 'SwapExecutor#SwapExecutor';
const deployed = JSON.parse(readFileSync(join(root, 'deployments', deployment, 'deployed_addresses.json'), 'utf8')) as Record<
  string,
  Address
>;
const executor = deployed[key];
if (!executor) throw new Error(`No ${key} in the ${deployment} deployment.`);
const { venues: listed } = JSON.parse(readFileSync(join(root, 'config', `executor-venues-${chainId}.json`), 'utf8')) as {
  venues: ({ name: string; venue: number } & ({ router: Address } | { deployment: string; key: string }))[];
};
/** Each venue's router: its address, or where its Ignition record says it is; none before that record exists. */
const venues = listed.flatMap((entry) => {
  if ('router' in entry) return [{ name: entry.name, router: entry.router, venue: entry.venue }];
  const file = join(root, 'deployments', entry.deployment, 'deployed_addresses.json');
  const router = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Address>)[entry.key] : undefined;
  if (!router) {
    console.log(`  ${entry.name.padEnd(12)} skipped: ${entry.key} is not deployed (${entry.deployment})`);
    return [];
  }
  return [{ name: entry.name, router, venue: entry.venue }];
});

const owner = getAddress(await client.readContract({ address: executor, abi: swapExecutorAbi, functionName: 'owner' }));
const weth = getAddress(await client.readContract({ address: executor, abi: swapExecutorAbi, functionName: 'weth' }));
console.log(`\nChain      ${chainId}`);
console.log(`Executor   ${executor}, owned by ${owner}${owner === getAddress(wallet.account.address) ? ' (this key)' : ''}`);
console.log(`WETH       ${weth}\n`);

const plan: { name: string; router: Address; venue: number }[] = [];
for (const { name, router, venue } of venues) {
  const code = await client.getCode({ address: router });
  if (!code || code === '0x') {
    console.log(`  ${name.padEnd(12)} skipped: no code at ${router}`);
    continue;
  }
  const wraps = await client.readContract({ address: router, abi: routerAbi, functionName: 'WETH9' }).catch(() => null);
  if (!wraps || getAddress(wraps) !== weth) {
    console.log(`  ${name.padEnd(12)} skipped: wraps into ${wraps ?? 'nothing it says'}, not ${weth}`);
    continue;
  }
  const listed = Number(await client.readContract({ address: executor, abi: swapExecutorAbi, functionName: 'venues', args: [router] }));
  const state = listed === venue ? 'already listed' : listed === 0 ? 'to list' : `listed as ${VENUE[listed]}, to change`;
  console.log(`  ${name.padEnd(12)} ${router}  ${VENUE[venue]!.padEnd(13)} ${state}`);
  if (listed !== venue) plan.push({ name, router, venue });
}

if (plan.length === 0) {
  console.log('\nNothing to list.');
  process.exit(0);
}
if (!execute) {
  console.log(`\nDry run: ${plan.length} router(s) to list. Run again with EXECUTE=1 to send.`);
  process.exit(0);
}

console.log('');
for (const { name, router, venue } of plan) {
  const hash = await wallet.writeContract({ address: executor, abi: swapExecutorAbi, functionName: 'setVenue', args: [router, venue] });
  await client.waitForTransactionReceipt({ hash });
  const listed = Number(await client.readContract({ address: executor, abi: swapExecutorAbi, functionName: 'venues', args: [router] }));
  console.log(`  ${name.padEnd(12)} ${listed === venue ? 'listed' : 'NOT LISTED'}  ${hash}`);
}
console.log('');
