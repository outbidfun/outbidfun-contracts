/**
 * Finishes the move from the first launchpad (`Launchpad#…` in this network's deployment record)
 * to the one on the constant-product curve (`LaunchpadV2#…` in `chain-<id>-launchpad-v2`),
 * after the LaunchpadV2 Ignition module has deployed and wired the new contracts and handed the
 * V3 factory over.
 *
 *   pnpm --filter @outbidfun/protocol migrate-launchpad --network robinhood             # plan only
 *   EXECUTE=1 pnpm --filter @outbidfun/protocol migrate-launchpad --network robinhood   # send
 *
 * 1. Reads every asset the old factory lists, with its cap, and lists each on the new factory
 *    with the same cap, where it is not listed so already.
 * 2. Pauses every asset on the old factory, so nothing launches on the old curve again. Coins
 *    already launched keep trading.
 * 3. Points the outbid market at the registry union, so bids land on both factories' coins.
 * 4. Reads back what the module did — the V3 factory's owner, the new manager's factory, the
 *    creator's factory — and the fee terms and launch fee on both factories, which are the same
 *    defaults unless the owner changed the old one's.
 *
 * Idempotent: a second run finds nothing to send. The caller must own everything it touches.
 * Without EXECUTE it only prints what it would do.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import hre from 'hardhat';
import { formatUnits, getAddress, parseAbi, type Address } from 'viem';

const factoryAbi = parseAbi([
  'function owner() view returns (address)',
  'function allQuoteAssets() view returns (address[])',
  'function quoteAssets(address) view returns (uint96 cap, uint8 decimals, bool enabled)',
  'function setQuoteAsset(address token, uint96 cap, bool enabled)',
  'function feeTerms() view returns (uint16 feeBps, uint16 protocolShareBps, uint16 maxCreatorTaxBps, uint16 snipeTaxStartBps, uint32 snipeTaxSeconds)',
  'function launchFee() view returns (uint256)',
  'function listingManager() view returns (address)',
  'function coinCreator() view returns (address)',
]);
const managerAbi = parseAbi([
  'function coinFactory() view returns (address)',
  'function treasury() view returns (address)',
  'function uniswapV3Factory() view returns (address)',
]);
const creatorAbi = parseAbi(['function factory() view returns (address)']);
const ownedAbi = parseAbi(['function owner() view returns (address)']);
const marketAbi = parseAbi(['function registry() view returns (address)', 'function setRegistry(address)']);
const unionAbi = parseAbi(['function first() view returns (address)', 'function second() view returns (address)']);
const erc20Abi = parseAbi(['function symbol() view returns (string)']);

const client = await hre.viem.getPublicClient();
const chainId = await client.getChainId();
const [wallet] = await hre.viem.getWalletClients();
if (!wallet) throw new Error('DEPLOYER_PRIVATE_KEY is not set in packages/protocol/.env.');
const execute = process.env.EXECUTE === '1';

const record = (id: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'ignition', 'deployments', id, 'deployed_addresses.json'), 'utf8')) as Record<string, Address>;
const before = record(`chain-${chainId}`);
const after = record(`chain-${chainId}-launchpad-v2`);
const OLD_FACTORY = before['Launchpad#CoinFactory'];
const OLD_MANAGER = before['Launchpad#CoinListingManager'];
const MARKET = before['OutbidMarketV2#OutbidMarket'] ?? before['Outbidfun#OutbidMarket'];
const NEW_FACTORY = after['LaunchpadV2#CoinFactory'];
const NEW_MANAGER = after['LaunchpadV2#CoinListingManager'];
const CREATOR = after['LaunchpadV2#CoinCreator'];
const UNION = after['LaunchpadV2#TokenRegistryUnion'];
if (!OLD_FACTORY || !OLD_MANAGER || !MARKET) throw new Error(`chain-${chainId} needs Launchpad#CoinFactory, Launchpad#CoinListingManager and a market.`);
if (!NEW_FACTORY || !NEW_MANAGER || !CREATOR || !UNION) throw new Error(`chain-${chainId}-launchpad-v2 is incomplete: run the LaunchpadV2 module first.`);
console.log(
  `Old factory  ${OLD_FACTORY}\nNew factory  ${NEW_FACTORY}\nMarket       ${MARKET}\nRegistry     ${UNION}\nCaller       ${wallet.account.address}${execute ? '' : '   (plan only: set EXECUTE=1 to send)'}\n`
);

const read = <T>(address: Address, abi: any, functionName: string, args: readonly unknown[] = []) =>
  client.readContract({ address, abi, functionName: functionName as never, args: args as never }) as Promise<T>;
async function send(address: Address, abi: any, functionName: string, args: readonly unknown[], what: string) {
  console.log(`  → ${what}`);
  if (!execute) return;
  const hash = await wallet!.writeContract({ address, abi, functionName: functionName as never, args: args as never, chain: wallet!.chain });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${what} reverted: ${hash}`);
  console.log(`    ${hash}`);
}

for (const [name, address] of [['old factory', OLD_FACTORY], ['new factory', NEW_FACTORY], ['market', MARKET]] as const) {
  const owner = await read<Address>(address, ownedAbi, 'owner');
  if (getAddress(owner) !== getAddress(wallet.account.address)) throw new Error(`The ${name} ${address} is owned by ${owner}, not the caller.`);
}

// 1. The assets, with their caps.
console.log('Assets');
const assets = await read<readonly Address[]>(OLD_FACTORY, factoryAbi, 'allQuoteAssets');
let listed = 0;
for (const asset of assets) {
  const [cap, decimals, enabled] = await read<readonly [bigint, number, boolean]>(OLD_FACTORY, factoryAbi, 'quoteAssets', [asset]);
  const [newCap, , newEnabled] = await read<readonly [bigint, number, boolean]>(NEW_FACTORY, factoryAbi, 'quoteAssets', [asset]);
  const symbol = await read<string>(asset, erc20Abi, 'symbol').catch(() => asset.slice(0, 8));
  const label = `${symbol.padEnd(6)} cap ${formatUnits(cap, decimals)}`;
  if (newCap === cap && newEnabled) {
    console.log(`  ${label}: already listed`);
  } else {
    // A paused asset is carried across paused; nothing new is offered by a migration.
    await send(NEW_FACTORY, factoryAbi, 'setQuoteAsset', [asset, cap, enabled], `list ${label}${enabled ? '' : ' (paused)'} on the new factory`);
    listed += 1;
  }
}
console.log(`  ${assets.length} asset(s), ${listed} to list`);

// 2. Pause the old factory.
console.log('Old factory');
let paused = 0;
for (const asset of assets) {
  const [cap, decimals, enabled] = await read<readonly [bigint, number, boolean]>(OLD_FACTORY, factoryAbi, 'quoteAssets', [asset]);
  if (!enabled) continue;
  const symbol = await read<string>(asset, erc20Abi, 'symbol').catch(() => asset.slice(0, 8));
  await send(OLD_FACTORY, factoryAbi, 'setQuoteAsset', [asset, cap, false], `pause ${symbol} (cap ${formatUnits(cap, decimals)}) on the old factory`);
  paused += 1;
}
if (paused === 0) console.log('  every asset is already paused');

// 3. The market's registry.
console.log('Market');
const registry = await read<Address>(MARKET, marketAbi, 'registry');
const [first, second] = await Promise.all([read<Address>(UNION, unionAbi, 'first'), read<Address>(UNION, unionAbi, 'second')]);
if (getAddress(first) !== getAddress(OLD_FACTORY) || getAddress(second) !== getAddress(NEW_FACTORY)) {
  throw new Error(`The union ${UNION} joins ${first} and ${second}, not the two factories.`);
}
if (getAddress(registry) === getAddress(UNION)) console.log('  registry is already the union');
else await send(MARKET, marketAbi, 'setRegistry', [UNION], `setRegistry(${UNION}): bids on both factories' coins`);

// 4. Read back.
console.log('Wiring');
const v3 = await read<Address>(NEW_MANAGER, managerAbi, 'uniswapV3Factory');
const oldV3 = await read<Address>(OLD_MANAGER, managerAbi, 'uniswapV3Factory');
const checks: [string, boolean, string][] = [
  ['the new V3 factory is owned by the new listing manager', getAddress(await read<Address>(v3, ownedAbi, 'owner')) === getAddress(NEW_MANAGER), v3],
  ['the old V3 factory is still owned by the old listing manager', getAddress(await read<Address>(oldV3, ownedAbi, 'owner')) === getAddress(OLD_MANAGER), oldV3],
  ['the two are different factories', getAddress(v3) !== getAddress(oldV3), `${oldV3} → ${v3}`],
  ['new listing manager graduates the new factory', getAddress(await read<Address>(NEW_MANAGER, managerAbi, 'coinFactory')) === getAddress(NEW_FACTORY), NEW_MANAGER],
  ['new listing manager pays the same door', getAddress(await read<Address>(NEW_MANAGER, managerAbi, 'treasury')) === getAddress(await read<Address>(OLD_MANAGER, managerAbi, 'treasury')), await read<Address>(NEW_MANAGER, managerAbi, 'treasury')],
  ['coin creator is bound to the new factory', getAddress(await read<Address>(CREATOR, creatorAbi, 'factory')) === getAddress(NEW_FACTORY), CREATOR],
  ['new factory deploys through that creator', getAddress(await read<Address>(NEW_FACTORY, factoryAbi, 'coinCreator')) === getAddress(CREATOR), NEW_FACTORY],
];
let ok = true;
for (const [what, holds, detail] of checks) {
  console.log(`  ${holds ? 'ok ' : 'NOT'} ${what} (${detail})`);
  ok &&= holds;
}
const terms = await Promise.all([OLD_FACTORY, NEW_FACTORY].map((f) => read<readonly [number, number, number, number, number]>(f, factoryAbi, 'feeTerms')));
const fees = await Promise.all([OLD_FACTORY, NEW_FACTORY].map((f) => read<bigint>(f, factoryAbi, 'launchFee')));
console.log(`  fee terms   old ${terms[0]!.join('/')}   new ${terms[1]!.join('/')}${terms[0]!.join('/') === terms[1]!.join('/') ? '' : '   (differ: setFeeTerms on the new factory if the old ones are wanted)'}`);
console.log(`  launch fee  old ${fees[0]}   new ${fees[1]}${fees[0] === fees[1] ? '' : '   (differ: setLaunchFee on the new factory if the old one is wanted)'}`);
if (!ok) process.exitCode = 1;
