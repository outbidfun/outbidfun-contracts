/**
 * Proves a deployment works by using it: launches one coin priced in the deployment's test
 * dollar, with an opening buy, and places one bid on it.
 *
 *   pnpm --filter @outbidfun/protocol smoke --network robinhoodTestnet
 *
 * Addresses come from ignition/deployments/chain-<id>/deployed_addresses.json, so it runs
 * against whatever the Ignition modules left on that network. The quote asset is the TestToken
 * module's dollar (or `SMOKE_QUOTE`), which the deployer holds; the coin's symbol is `SMOKE`
 * plus a short random suffix, so it can be run again. It spends the launch fee and a few
 * hundred test dollars, and prints what it did with explorer links.
 *
 * `SMOKE_REWARD_BPS=300` launches a reward coin instead (`SMOKE_SHARE_FEES=1` also gives the
 * creator's fees to holders), and after the bid moves a slice of the coins to another wallet,
 * so the transfer pays the reward fee, and claims what the deployer has earned.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import hre from 'hardhat';
import { formatEther, formatUnits, parseUnits, zeroAddress, type Address } from 'viem';

const client = await hre.viem.getPublicClient();
const chainId = await client.getChainId();
const [wallet] = await hre.viem.getWalletClients();
if (!wallet) throw new Error('DEPLOYER_PRIVATE_KEY is not set in packages/protocol/.env.');

const deployed = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'ignition', 'deployments', `chain-${chainId}`, 'deployed_addresses.json'), 'utf8')
) as Record<string, Address>;
const at = (key: string): Address => {
  const address = deployed[key];
  if (!address) throw new Error(`${key} is not in the chain-${chainId} deployment.`);
  return address;
};

const explorer = (hre.network.config as { chainId?: number }).chainId === 46630
  ? 'https://explorer.testnet.chain.robinhood.com'
  : 'https://robinhoodchain.blockscout.com';

const factory = await hre.viem.getContractAt('CoinFactory', at('Launchpad#CoinFactory'));
const market = await hre.viem.getContractAt('OutbidMarket', at('Outbidfun#OutbidMarket'));
const quoteAddress = (process.env.SMOKE_QUOTE as Address | undefined) ?? at('TestToken#MockERC20');
const quote = await hre.viem.getContractAt('MockERC20', quoteAddress);
const decimals = await quote.read.decimals();
const symbolOfQuote = await quote.read.symbol();
const me = wallet.account.address;

const listed = await factory.read.quoteAssets([quoteAddress]);
if (!listed[2]) throw new Error(`${symbolOfQuote} is not enabled as a quote asset on the factory.`);

const wait = (hash: `0x${string}`) => client.waitForTransactionReceipt({ hash });
const money = (raw: bigint) => `${formatUnits(raw, decimals)} ${symbolOfQuote}`;

console.log(`\nChain      ${chainId}`);
console.log(`Deployer   ${me}  ${formatEther(await client.getBalance({ address: me }))} ETH, ${money(await quote.read.balanceOf([me]))}`);

// ---------------------------------------------------------------- launch
const symbol = `SMOKE${Math.floor(Math.random() * 900 + 100)}`;
const rewardFeeBps = Number(process.env.SMOKE_REWARD_BPS ?? 0);
const shareFeesWithHolders = rewardFeeBps > 0 && process.env.SMOKE_SHARE_FEES === '1';
const preBuy = parseUnits('100', decimals);
const launchFee = await factory.read.launchFee();

await wait(await quote.write.approve([factory.address, preBuy]));
const launchHash = await factory.write.deploy(
  [
    {
      name: 'Smoke Test',
      symbol,
      description: 'Launched by scripts/smoke.ts to prove the deployment works.',
      image: '',
      socials: '',
      quoteAsset: quoteAddress,
      preBuy,
      creatorFeeRecipient: zeroAddress,
      creatorTaxBps: 0,
      rewardFeeBps,
      shareFeesWithHolders,
    },
    [],
  ],
  { value: launchFee }
);
await wait(launchHash);
const coinAddress = await factory.read.getAddress([symbol]);
const coin = await hre.viem.getContractAt('Coin', coinAddress);
console.log(`\nLaunched   $${symbol} at ${coinAddress}`);
console.log(`           ${explorer}/tx/${launchHash}`);
console.log(`           opening buy ${money(preBuy)} → ${formatEther(await coin.read.balanceOf([me]))} coins; reserve ${money(await coin.read.reserveBalance())}`);

// ---------------------------------------------------------------- bid
const bid = parseUnits('50', decimals);
await wait(await quote.write.approve([market.address, bid]));
const bidHash = await market.write.bid([coinAddress, bid, 0n, 0n]);
await wait(bidHash);
const position = await market.read.getPosition([coinAddress]);
const dead = await coin.read.balanceOf(['0x000000000000000000000000000000000000dEaD']);
console.log(`\nBid        ${money(bid)} on $${symbol}`);
console.log(`           ${explorer}/tx/${bidHash}`);
console.log(`           total bid ${formatEther(position.totalBid)} USDG (18 dec); top token ${await market.read.topToken()}`);
console.log(`           coins burned to the dead address: ${formatEther(dead)}`);
console.log(`           reserve now ${money(await coin.read.reserveBalance())}; price ${formatEther(await coin.read.price())} ${symbolOfQuote}/coin\n`);

// ---------------------------------------------------------------- rewards
if (rewardFeeBps > 0) {
  const distributor = await hre.viem.getContractAt('HolderRewards', await coin.read.rewardDistributor());
  const other = '0x000000000000000000000000000000000000bEEF' as Address;
  const sent = (await coin.read.balanceOf([me])) / 10n;
  const transferHash = await coin.write.transfer([other, sent]);
  await wait(transferHash);
  const [coinsOwed, assetOwed] = await distributor.read.claimable([me]);
  console.log(`Rewards    ${rewardFeeBps / 100}% reward coin${shareFeesWithHolders ? ', creator fees shared with holders' : ''}; distributor ${distributor.address}`);
  console.log(`           sent ${formatEther(sent)} coins to ${other}; it received ${formatEther(await coin.read.balanceOf([other]))}`);
  console.log(`           ${explorer}/tx/${transferHash}`);
  console.log(`           claimable by the deployer: ${formatEther(coinsOwed)} coins and ${money(assetOwed)}`);
  const claimHash = await distributor.write.claim();
  await wait(claimHash);
  console.log(`           claimed: ${explorer}/tx/${claimHash}`);
  console.log(`           shared so far: ${formatEther(await distributor.read.totalDistributed([coinAddress]))} coins, ${money(await distributor.read.totalDistributed([quoteAddress]))}\n`);
}
