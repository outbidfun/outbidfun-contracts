/**
 * Lists Robinhood Stock Tokens and tokenised ETFs on the factory as assets coins can be priced in,
 * each graduating at about the same dollar value as the other assets (14,000 USDG).
 *
 *   pnpm --filter @outbidfun/protocol list-assets --network robinhood             # dry run
 *   EXECUTE=1 pnpm --filter @outbidfun/protocol list-assets --network robinhood   # send
 *
 * Every address comes from Robinhood's own registry (api.robinhood.com/rhj/assets) and is checked
 * on chain for its symbol and 18 decimals before anything is sent; every price from Robinhood's
 * public quotes (api.robinhood.com/quotes). A cap is TARGET_USD of the share at its last trade,
 * rounded up to a whole share, so a coin priced in it graduates at a figure a person can read
 * ("40 AVGO"). An asset already listed is left as it is. Without EXECUTE it only prints the plan.
 *
 * ASSETS=AAPL,NVDA narrows the list; TARGET_USD changes the dollar figure. The factory is the one
 * in this network's deployment record, and the caller must own it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import hre from 'hardhat';
import { getAddress, parseAbi, parseUnits, type Address } from 'viem';

/** The shares and ETFs the platform names (apps/web/src/constants/quoteAssets.ts), where Robinhood issues them. */
const DEFAULT_ASSETS = [
  'SPY', 'QQQ', 'SGOV', 'GLD', 'SLV', 'BND', 'SMH', 'XLK',
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'AMD', 'TSM', 'PLTR', 'COIN', 'MSTR',
  'CRCL', 'CRWV', 'APLD', 'VRT', 'MU', 'MRVL', 'CRWD', 'NET', 'SNOW', 'SOFI', 'RDDT', 'SHOP', 'RKLB',
  'ASTS', 'LUNR', 'IONQ', 'QBTS', 'RGTI', 'OKLO', 'SMR', 'GME', 'RIVN', 'HIMS', 'XOM',
];

const REGISTRY = 'https://api.robinhood.com/rhj/assets';
const QUOTES = 'https://api.robinhood.com/quotes/?symbols=';

const erc20 = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const factoryAbi = parseAbi([
  'function owner() view returns (address)',
  'function quoteAssets(address) view returns (uint96 cap, uint8 decimals, bool enabled)',
  'function setQuoteAsset(address token, uint96 cap, bool enabled)',
]);

const client = await hre.viem.getPublicClient();
const chainId = await client.getChainId();
const [wallet] = await hre.viem.getWalletClients();
if (!wallet) throw new Error('DEPLOYER_PRIVATE_KEY is not set in packages/protocol/.env.');
const execute = process.env.EXECUTE === '1';
const targetUsd = Number(process.env.TARGET_USD ?? 14_000);
const wanted = (process.env.ASSETS?.split(',').map((ticker) => ticker.trim().toUpperCase()) ?? DEFAULT_ASSETS).filter(Boolean);

const deployed = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'ignition', 'deployments', `chain-${chainId}`, 'deployed_addresses.json'), 'utf8')
) as Record<string, Address>;
const factory = deployed['Launchpad#CoinFactory'];
if (!factory) throw new Error(`No CoinFactory in the chain-${chainId} deployment.`);
const owner = getAddress(await client.readContract({ address: factory, abi: factoryAbi, functionName: 'owner' }));

console.log(`\nChain      ${chainId}`);
console.log(`Factory    ${factory}, owned by ${owner}${owner === getAddress(wallet.account.address) ? ' (this key)' : ''}`);
console.log(`Target     ${targetUsd.toLocaleString('en-US')} USD a cap\n`);

const registry = (await (await fetch(REGISTRY)).json()) as {
  assets: { tokenSymbol: string; status: string; deployments: { chainId: number; contractAddress: string }[] }[];
};
const addressOf = new Map<string, Address>();
for (const asset of registry.assets) {
  const deployment = asset.deployments.find((entry) => entry.chainId === chainId);
  if (asset.status === 'ASSET_STATUS_ACTIVE' && deployment) addressOf.set(asset.tokenSymbol, getAddress(deployment.contractAddress));
}

const quotes = (await (await fetch(QUOTES + wanted.join(','))).json()) as {
  results: ({ symbol: string; last_trade_price: string } | null)[];
};
const priceOf = new Map(quotes.results.filter(Boolean).map((quote) => [quote!.symbol, Number(quote!.last_trade_price)]));

const plan: { ticker: string; token: Address; cap: bigint }[] = [];
for (const ticker of wanted) {
  const token = addressOf.get(ticker);
  const price = priceOf.get(ticker);
  if (!token) {
    console.log(`  ${ticker.padEnd(6)} skipped: not in Robinhood's registry on chain ${chainId}`);
    continue;
  }
  if (!price || !(price > 0)) {
    console.log(`  ${ticker.padEnd(6)} skipped: no price`);
    continue;
  }
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20, functionName: 'symbol' }),
    client.readContract({ address: token, abi: erc20, functionName: 'decimals' }),
  ]);
  if (symbol !== ticker || decimals !== 18) {
    console.log(`  ${ticker.padEnd(6)} skipped: the token at ${token} says ${symbol}, ${decimals} decimals`);
    continue;
  }
  const shares = Math.ceil(targetUsd / price);
  const cap = parseUnits(String(shares), 18);
  const [listedCap, , enabled] = await client.readContract({ address: factory, abi: factoryAbi, functionName: 'quoteAssets', args: [token] });
  const state = listedCap > 0n ? (enabled ? 'already listed' : 'listed, paused') : 'to list';
  console.log(`  ${ticker.padEnd(6)} ${token}  $${price.toFixed(2).padStart(9)}  cap ${String(shares).padStart(5)} ${ticker.padEnd(6)} ${state}`);
  if (listedCap === 0n) plan.push({ ticker, token, cap });
}

if (plan.length === 0) {
  console.log('\nNothing to list.');
  process.exit(0);
}
if (!execute) {
  console.log(`\nDry run: ${plan.length} asset(s) to list. Run again with EXECUTE=1 to send.`);
  process.exit(0);
}

console.log('');
for (const { ticker, token, cap } of plan) {
  const hash = await wallet.writeContract({ address: factory, abi: factoryAbi, functionName: 'setQuoteAsset', args: [token, cap, true] });
  await client.waitForTransactionReceipt({ hash });
  const [listedCap, , enabled] = await client.readContract({ address: factory, abi: factoryAbi, functionName: 'quoteAssets', args: [token] });
  console.log(`  ${ticker.padEnd(6)} ${listedCap === cap && enabled ? 'listed' : 'NOT LISTED'}  ${hash}`);
}
console.log('');
