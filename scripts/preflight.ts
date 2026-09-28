/**
 * Everything worth knowing before spending gas.
 *
 *   pnpm --filter @outbidfun/protocol preflight --network sepolia
 *
 * The Launchpad module deploys a dozen contracts, including the Uniswap V3 factory, in one run.
 * Ignition stops at the first failure and leaves the rest undeployed, so the failures worth
 * catching are the ones that are obvious beforehand: an RPC that does not answer, a deployer
 * with no key or no funds, and a WETH parameter that points at nothing on this chain. The router
 * and quoter wrap and unwrap through that address, and it is the first asset coins can be priced
 * in, so a wrong one is not recoverable by redeploying a single contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import hre from 'hardhat';
import { formatEther, type Address } from 'viem';

/** Ignition parameter files are not network-scoped, so each chain has its own. */
const PARAMETERS: Record<number, string> = {
  11155111: 'sepolia.json',
  4663: 'base.json',
  46630: 'robinhood-testnet.json',
};

/** Deploying the whole Launchpad costs roughly this much gas, measured against a local node. */
const DEPLOY_GAS = 26_000_000n;

const client = await hre.viem.getPublicClient();
const chainId = await client.getChainId();
const [wallet] = await hre.viem.getWalletClients();
const problems: string[] = [];

console.log(`\nNetwork      chain ${chainId}, head ${await client.getBlockNumber()}`);

const block = await client.getBlock();
console.log(`Block limit  ${block.gasLimit.toLocaleString()} gas`);
// A graduation is the largest single transaction the platform ever sends.
if (block.gasLimit < 12_000_000n) {
  problems.push(`The block gas limit is ${block.gasLimit}, under the 12,000,000 a graduation needs.`);
}

const file = PARAMETERS[chainId];
if (!file) {
  problems.push(`No Ignition parameters file is mapped for chain ${chainId}.`);
} else {
  const parameters = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'ignition', 'config', file), 'utf8')
  );
  const weth = parameters?.Launchpad?.weth as string | undefined;
  if (!weth) {
    problems.push(`\`weth\` is not set in ignition/config/${file}.`);
  } else {
    const code = await client.getCode({ address: weth as Address }).catch(() => undefined);
    if (!code || code === '0x') {
      problems.push(`The WETH address in ${file} (${weth}) has no code on chain ${chainId}.`);
    } else {
      const symbol = await client
        .readContract({
          address: weth as Address,
          abi: [{ name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }],
          functionName: 'symbol',
        })
        .catch(() => '(unreadable)');
      console.log(`WETH         ${weth} — ${symbol}, ${(code.length - 2) / 2} bytes`);
    }
  }
}

if (!wallet) {
  problems.push('DEPLOYER_PRIVATE_KEY is not set in packages/protocol/.env.');
} else {
  const balance = await client.getBalance({ address: wallet.account.address });
  const price = await client.getGasPrice();
  const needed = DEPLOY_GAS * price;
  console.log(`Deployer     ${wallet.account.address}`);
  console.log(`Balance      ${formatEther(balance)} ETH`);
  console.log(`Estimate     ~${formatEther(needed)} ETH at ${Number(price) / 1e9} gwei for ~${DEPLOY_GAS.toLocaleString()} gas`);
  if (balance < needed) {
    problems.push(
      `The deployer holds ${formatEther(balance)} ETH; the run needs roughly ${formatEther(needed)}.`
    );
  }
}

if (problems.length === 0) {
  console.log('\nReady to deploy.\n');
} else {
  console.log(`\n${problems.length} thing${problems.length === 1 ? '' : 's'} to fix first:`);
  for (const problem of problems) console.log(`  · ${problem}`);
  console.log('');
  process.exitCode = 1;
}
