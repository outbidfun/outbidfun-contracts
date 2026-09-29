/**
 * Trades through the testnet trade router, the way the site sends them, and checks each paid its
 * fee to the fee recipient: a curve buy and sale, and a pool buy and sale.
 *
 *   COIN=<curve coin> POOLED=<graduated coin> POOL=<its pool> pnpm --filter @outbidfun/protocol exec hardhat run scripts/trade-router-smoke.ts --network robinhoodTestnet
 *
 * Testnet only: it mints the test dollar (MockERC20, open mint) to pay with.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import hre from 'hardhat';
import { encodePacked, erc20Abi, maxUint256, parseAbi, parseEventLogs, parseUnits, type Address, type TransactionReceipt } from 'viem';

const routerAbi = parseAbi([
  'function feeBps() view returns (uint16)',
  'function feeRecipient() view returns (address)',
  'function buyCurve(address coin, uint256 amountIn, uint256 minCoins, address recipient, uint256 deadline) payable returns (uint256)',
  'function sellCurve(address coin, uint256 amount, uint256 minOut, address recipient, uint256 deadline, bool asEther) returns (uint256)',
  'struct Step { address router; bytes path; }',
  'struct Leg { uint256 amountIn; uint256 minOut; Step[] steps; }',
  'struct Trade { address tokenIn; address tokenOut; uint256 amountIn; uint256 minAmountOut; address recipient; uint256 deadline; Leg[] legs; }',
  'function execute(Trade trade) payable returns (uint256)',
  'event FeeCharged(address indexed payer, address indexed token, uint256 amount)',
]);
const coinAbi = parseAbi(['function reserveToken() view returns (address)']);
const poolAbi = parseAbi(['function fee() view returns (uint24)', 'function factory() view returns (address)']);
const mintAbi = parseAbi(['function mint(address to, uint256 amount)']);

const client = await hre.viem.getPublicClient();
const chainId = await client.getChainId();
if (chainId !== 46630) throw new Error('Testnet only: this mints the test dollar to pay with.');
const [wallet] = await hre.viem.getWalletClients();
if (!wallet) throw new Error('DEPLOYER_PRIVATE_KEY is not set in packages/protocol/.env.');
const me = wallet.account.address;

const root = join(import.meta.dirname, '..', 'ignition');
const deployed = JSON.parse(readFileSync(join(root, 'deployments', 'chain-46630-trade-router', 'deployed_addresses.json'), 'utf8'));
const router = deployed['TradeRouter#TradeRouter'] as Address;
const coin = process.env.COIN as Address;
const pooled = process.env.POOLED as Address;
const pool = process.env.POOL as Address;
if (!coin || !pooled || !pool) throw new Error('Set COIN, POOLED and POOL.');
// The pool's router, by the launchpad whose factory made it.
const ROUTERS: Record<string, Address> = {
  '0x6f72dd1c961bc7883921d6d6ae914264ab4ce363': '0x4295f435208c4D161681426Cd586f454961CFD05',
  '0x6ffce4fe24b35ba8c765e3441331300d22934f8b': '0xd49c70e5e6d80105A6B816ccC0b7Ab59A133F07A',
};

const feeBps = BigInt(await client.readContract({ address: router, abi: routerAbi, functionName: 'feeBps' }));
const feeRecipient = await client.readContract({ address: router, abi: routerAbi, functionName: 'feeRecipient' });
const usdg = await client.readContract({ address: coin, abi: coinAbi, functionName: 'reserveToken' });
console.log(`Router ${router}, fee ${feeBps} bps to ${feeRecipient}; paying in ${usdg}`);

const balance = (token: Address, owner: Address) =>
  client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
const send = async (hash: `0x${string}`) => {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Reverted: ${hash}`);
  return receipt;
};
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
const approve = async (token: Address) => {
  const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [me, router] });
  if (allowance < maxUint256 / 2n) await send(await wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [router, maxUint256] }));
};
/**
 * The router's own fee in a trade, from its `FeeCharged`: the fee recipient's balance would count
 * the coin's protocol fee as well, which goes to the same revenue router.
 */
const routerFee = (receipt: TransactionReceipt, token: Address) =>
  parseEventLogs({ abi: routerAbi, eventName: 'FeeCharged', logs: receipt.logs })
    .filter((log) => log.address.toLowerCase() === router.toLowerCase() && log.args.token.toLowerCase() === token.toLowerCase())
    .reduce((sum, log) => sum + log.args.amount, 0n);
function report(label: string, got: bigint, expected: bigint, receipt: TransactionReceipt) {
  console.log(`${got === expected ? 'ok  ' : 'FAIL'} ${label}: fee ${got} (expected ${expected}), tx ${receipt.transactionHash}`);
  if (got !== expected) process.exitCode = 1;
}
/** Runs a trade and checks the router charged exactly `fee` of `token`. */
async function check(label: string, token: Address, fee: bigint, trade: () => Promise<`0x${string}`>) {
  const receipt = await send(await trade());
  report(label, routerFee(receipt, token), fee, receipt);
}

const spend = parseUnits('5', 6);
await send(await wallet.writeContract({ address: usdg, abi: mintAbi, functionName: 'mint', args: [me, spend * 4n] }));
await approve(usdg);

// The curve: a buy, then a sale of what it bought.
const coinsBefore = await balance(coin, me);
await check('curve buy', usdg, (spend * feeBps) / 10_000n, () =>
  wallet.writeContract({ address: router, abi: routerAbi, functionName: 'buyCurve', args: [coin, spend, 1n, me, deadline()] })
);
const bought = (await balance(coin, me)) - coinsBefore;
console.log(`     bought ${bought} coins`);
await approve(coin);
{
  const mine = await balance(usdg, me);
  const receipt = await send(
    await wallet.writeContract({ address: router, abi: routerAbi, functionName: 'sellCurve', args: [coin, bought, 1n, me, deadline(), false] })
  );
  const fee = routerFee(receipt, usdg);
  const paid = (await balance(usdg, me)) - mine;
  // The fee is the router's share of what the curve paid it: the proceeds and the fee together.
  report('curve sale', fee, ((paid + fee) * feeBps) / 10_000n, receipt);
}

// The pool: a buy with the dollar (fee out of what is paid), a sale for it (fee out of what is bought).
const fee = await client.readContract({ address: pool, abi: poolAbi, functionName: 'fee' });
const factory = (await client.readContract({ address: pool, abi: poolAbi, functionName: 'factory' })).toLowerCase();
const poolRouter = ROUTERS[factory];
if (!poolRouter) throw new Error(`No router known for factory ${factory}`);
const leg = (amountIn: bigint, from: Address, to: Address) => ({
  amountIn,
  minOut: 1n,
  steps: [{ router: poolRouter, path: encodePacked(['address', 'uint24', 'address'], [from, fee, to]) }],
});
const pooledBefore = await balance(pooled, me);
const feeIn = (spend * feeBps) / 10_000n;
await check('pool buy', usdg, feeIn, () =>
  wallet.writeContract({
    address: router,
    abi: routerAbi,
    functionName: 'execute',
    args: [{ tokenIn: usdg, tokenOut: pooled, amountIn: spend, minAmountOut: 1n, recipient: me, deadline: deadline(), legs: [leg(spend - feeIn, usdg, pooled)] }],
  })
);
const pooledBought = (await balance(pooled, me)) - pooledBefore;
console.log(`     bought ${pooledBought} coins`);
await approve(pooled);
{
  const mine = await balance(usdg, me);
  const receipt = await send(
    await wallet.writeContract({
      address: router,
      abi: routerAbi,
      functionName: 'execute',
      args: [{ tokenIn: pooled, tokenOut: usdg, amountIn: pooledBought, minAmountOut: 1n, recipient: me, deadline: deadline(), legs: [leg(pooledBought, pooled, usdg)] }],
    })
  );
  const got = routerFee(receipt, usdg);
  const paid = (await balance(usdg, me)) - mine;
  report('pool sale', got, ((paid + got) * feeBps) / 10_000n, receipt);
}
