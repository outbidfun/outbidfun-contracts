/**
 * Moves the Outbid board from the first market (`Outbidfun#OutbidMarket`) to its replacement
 * (`OutbidMarketV2#OutbidMarket`), both from this network's deployment record.
 *
 *   pnpm --filter @outbidfun/protocol migrate-market --network robinhood                      # plan only
 *   EXECUTE=1 pnpm --filter @outbidfun/protocol migrate-market --network robinhood            # settings + board
 *   EXECUTE=1 FREEZE=1 pnpm --filter @outbidfun/protocol migrate-market --network robinhood   # and freeze, close
 *
 * 1. Reads the first market: its terms (floor, step, split, vault, treasury, launchpad), the V4
 *    route of ether and of every asset the factory lists, and its whole board — each position as
 *    it stands, in the order the positions were opened, and the top spot.
 * 2. Brings the new market's terms and routes in line with those, where they differ.
 * 3. Writes the board into the new market (`migrate`), in batches, in the same order.
 * 4. With FREEZE: unsets the first market's registry, after which every bid on it reverts
 *    (`NoRegistry`) and its board cannot move. Reads that board again, writes any position that
 *    moved in the meantime, and closes the migration for good.
 * 5. Compares the two boards position by position, and the top spot, and says whether they match.
 *
 * The caller must own both markets. Without EXECUTE it only prints what it would do.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import hre from 'hardhat';
import { getAddress, parseAbi, zeroAddress, type Address } from 'viem';

const marketAbi = parseAbi([
  'struct Position { uint256 totalBid; uint64 firstBidAt; uint64 lastBidAt; address lastBidder; }',
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'function owner() view returns (address)',
  'function registry() view returns (address)',
  'function buyback() view returns (address)',
  'function treasury() view returns (address)',
  'function minBid() view returns (uint256)',
  'function outbidIncrement() view returns (uint256)',
  'function burnBps() view returns (uint16)',
  'function buybackBps() view returns (uint16)',
  'function treasuryBps() view returns (uint16)',
  'function topToken() view returns (address)',
  'function tokenCount() view returns (uint256)',
  'function tokenAt(uint256) view returns (address)',
  'function getPosition(address) view returns (Position)',
  'function routeOf(address) view returns (PoolKey[])',
  'function setRegistry(address)',
  'function setDestinations(address, address)',
  'function setSplit(uint16, uint16, uint16)',
  'function setMinBid(uint256)',
  'function setOutbidIncrement(uint256)',
  'function setRoute(address, PoolKey[])',
]);
const v2Abi = parseAbi([
  'struct Position { uint256 totalBid; uint64 firstBidAt; uint64 lastBidAt; address lastBidder; }',
  'function migrationOpen() view returns (bool)',
  'function executor() view returns (address)',
  'function migrate(address[] tokens, Position[] positions)',
  'function closeMigration()',
]);
const factoryAbi = parseAbi(['function allQuoteAssets() view returns (address[])']);

type Position = { totalBid: bigint; firstBidAt: bigint; lastBidAt: bigint; lastBidder: Address };
const BATCH = 40;

const client = await hre.viem.getPublicClient();
const chainId = await client.getChainId();
const [wallet] = await hre.viem.getWalletClients();
if (!wallet) throw new Error('DEPLOYER_PRIVATE_KEY is not set in packages/protocol/.env.');
const execute = process.env.EXECUTE === '1';
const freeze = execute && process.env.FREEZE === '1';

const deployed = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'ignition', 'deployments', `chain-${chainId}`, 'deployed_addresses.json'), 'utf8')
) as Record<string, Address>;
const OLD = deployed['Outbidfun#OutbidMarket'];
const NEW = deployed['OutbidMarketV2#OutbidMarket'];
if (!OLD || !NEW) throw new Error(`chain-${chainId} needs both Outbidfun#OutbidMarket and OutbidMarketV2#OutbidMarket.`);
console.log(`First market ${OLD}\nNew market   ${NEW}\nCaller       ${wallet.account.address}${execute ? '' : '   (plan only: set EXECUTE=1 to send)'}\n`);

const read = <T>(address: Address, functionName: string, args: readonly unknown[] = []) =>
  client.readContract({ address, abi: marketAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
async function send(address: Address, abi: typeof marketAbi | typeof v2Abi, functionName: string, args: readonly unknown[], what: string) {
  console.log(`  → ${what}`);
  if (!execute) return;
  const hash = await wallet!.writeContract({ address, abi, functionName: functionName as never, args: args as never, chain: wallet!.chain });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${what} reverted: ${hash}`);
  console.log(`    ${hash}`);
}

for (const market of [OLD, NEW]) {
  const owner = await read<Address>(market, 'owner');
  if (getAddress(owner) !== getAddress(wallet.account.address)) throw new Error(`${market} is owned by ${owner}, not the caller.`);
}

/** Every position on a market, in the order its positions were opened, and its top spot. */
async function boardOf(market: Address) {
  const count = await read<bigint>(market, 'tokenCount');
  const tokens: Address[] = [];
  for (let i = 0n; i < count; i++) tokens.push(getAddress(await read<Address>(market, 'tokenAt', [i])));
  const positions: Position[] = [];
  for (const token of tokens) positions.push(await read<Position>(market, 'getPosition', [token]));
  return { tokens, positions, top: getAddress(await read<Address>(market, 'topToken')) };
}
const same = (a: Position, b: Position) =>
  a.totalBid === b.totalBid && a.firstBidAt === b.firstBidAt && a.lastBidAt === b.lastBidAt && getAddress(a.lastBidder) === getAddress(b.lastBidder);

// 1–2. Terms and routes.
console.log('Terms');
const terms = ['minBid', 'outbidIncrement', 'burnBps', 'buybackBps', 'treasuryBps', 'buyback', 'treasury', 'registry'] as const;
const was: Record<string, unknown> = {};
const now: Record<string, unknown> = {};
for (const name of terms) {
  was[name] = await read(OLD, name);
  now[name] = await read(NEW, name);
  console.log(`  ${name.padEnd(16)} ${String(was[name])}${String(was[name]) === String(now[name]) ? '' : `   (new market: ${String(now[name])})`}`);
}
const registry = was.registry as Address;
if (registry === zeroAddress && !freeze) console.log('  The first market is already frozen (no registry).');
if (was.minBid !== now.minBid) await send(NEW, marketAbi, 'setMinBid', [was.minBid], `setMinBid(${was.minBid})`);
if (was.outbidIncrement !== now.outbidIncrement) await send(NEW, marketAbi, 'setOutbidIncrement', [was.outbidIncrement], `setOutbidIncrement(${was.outbidIncrement})`);
if (was.burnBps !== now.burnBps || was.buybackBps !== now.buybackBps || was.treasuryBps !== now.treasuryBps) {
  await send(NEW, marketAbi, 'setSplit', [was.burnBps, was.buybackBps, was.treasuryBps], `setSplit(${was.burnBps}, ${was.buybackBps}, ${was.treasuryBps})`);
}
if (String(was.buyback) !== String(now.buyback) || String(was.treasury) !== String(now.treasury)) {
  await send(NEW, marketAbi, 'setDestinations', [was.buyback, was.treasury], `setDestinations(${was.buyback}, ${was.treasury})`);
}
console.log(`  executor         ${await client.readContract({ address: NEW, abi: v2Abi, functionName: 'executor' })} (new market)`);

console.log('Routes');
const listed = (await client
  .readContract({ address: registry === zeroAddress ? (now.registry as Address) : registry, abi: factoryAbi, functionName: 'allQuoteAssets' })
  .catch(() => [])) as readonly Address[];
const assets = [zeroAddress as Address, ...listed];
for (const asset of assets) {
  const oldRoute = await read<readonly unknown[]>(OLD, 'routeOf', [asset]);
  const newRoute = await read<readonly unknown[]>(NEW, 'routeOf', [asset]);
  const label = asset === zeroAddress ? 'ether' : asset;
  if (oldRoute.length === 0) console.log(`  ${label}: none`);
  else if (JSON.stringify(oldRoute, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) === JSON.stringify(newRoute, (_, v) => (typeof v === 'bigint' ? v.toString() : v))) console.log(`  ${label}: already set`);
  else await send(NEW, marketAbi, 'setRoute', [asset, oldRoute], `setRoute(${label}, ${oldRoute.length} pools)`);
}

/** Writes the positions that differ from the new market's, in the first market's order. */
async function write(board: Awaited<ReturnType<typeof boardOf>>) {
  const current = await boardOf(NEW);
  const pending: [Address, Position][] = [];
  board.tokens.forEach((token, index) => {
    const at = current.tokens.indexOf(token);
    if (at < 0 || !same(current.positions[at]!, board.positions[index]!)) pending.push([token, board.positions[index]!]);
  });
  if (pending.length === 0) return console.log('  nothing to write: the new market already has it');
  const open = await client.readContract({ address: NEW, abi: v2Abi, functionName: 'migrationOpen' });
  if (!open) throw new Error('The new market has closed its migration; it cannot take the board now.');
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    await send(
      NEW,
      v2Abi,
      'migrate',
      [batch.map(([token]) => token), batch.map(([, position]) => position)],
      `migrate ${batch.length} position(s): ${batch.map(([token, p]) => `${token} ${p.totalBid}`).join(', ')}`
    );
  }
}

// 3. The board.
console.log('Board');
let board = await boardOf(OLD);
console.log(`  ${board.tokens.length} position(s) on the first market, top ${board.top}`);
await write(board);

// 4. Freeze, read again, close.
if (freeze) {
  console.log('Freeze');
  if (registry !== zeroAddress) await send(OLD, marketAbi, 'setRegistry', [zeroAddress], 'setRegistry(0) on the first market: every bid on it now reverts');
  board = await boardOf(OLD);
  console.log(`  read again after the freeze: ${board.tokens.length} position(s), top ${board.top}`);
  await write(board);
  if (await client.readContract({ address: NEW, abi: v2Abi, functionName: 'migrationOpen' })) {
    await send(NEW, v2Abi, 'closeMigration', [], 'closeMigration on the new market');
  }
}

// 5. Compare.
if (execute) {
  const moved = await boardOf(NEW);
  const matches =
    moved.tokens.length === board.tokens.length &&
    moved.tokens.every((token, index) => token === board.tokens[index] && same(moved.positions[index]!, board.positions[index]!)) &&
    moved.top === board.top;
  console.log(`\nThe new market's board ${matches ? 'matches' : 'DOES NOT match'} the first market's: ${moved.tokens.length} position(s), top ${moved.top}.`);
  moved.tokens.forEach((token, index) => {
    const p = moved.positions[index]!;
    console.log(`  ${index + 1}. ${token}  ${p.totalBid}  first ${p.firstBidAt}  last ${p.lastBidAt}  by ${p.lastBidder}`);
  });
  console.log(`  migration open: ${await client.readContract({ address: NEW, abi: v2Abi, functionName: 'migrationOpen' })}`);
  if (!matches) process.exitCode = 1;
}
