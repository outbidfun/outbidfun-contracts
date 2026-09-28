// Verifies an Ignition deployment's contracts on Sourcify and on Etherscan, and any coins given
// after it, which CoinCreator deployed from the same build.
//
//   node scripts/verify.mjs <deploymentId> [coin address ...]
//   ONLY=<address,...> node scripts/verify.mjs <deploymentId>   # just those contracts
//
// `hardhat ignition verify` is not used for this: it waits on Etherscan's "Pending in queue"
// without limit, one contract at a time, and Etherscan's queue for Robinhood Chain has taken well
// over ten minutes a contract, so a run sat silent for longer than anyone would wait. This submits
// everything first, then polls every submission together, a request a second (the free API allows
// three), for a bounded time, and prints each outcome as it lands.
//
// Sourcify answers in seconds and is what the chain's Blockscout explorer shows. Etherscan
// (robin.etherscan.io) needs ETHERSCAN_API_KEY in .env and covers mainnet only; on the testnet
// this verifies on Sourcify alone.
import 'dotenv/config';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
// pnpm keeps ignition-core under hardhat-ignition, so it resolves from there.
const require = createRequire(realpathSync(join(packageRoot, 'node_modules/@nomicfoundation/hardhat-ignition/package.json')));
const { getVerificationInformation } = require('@nomicfoundation/ignition-core');

const SOURCIFY = 'https://sourcify.dev/server';
const ETHERSCAN = 'https://api.etherscan.io/v2/api';
/** Chains Etherscan verifies; Sourcify verifies both. */
const ETHERSCAN_CHAINS = new Set([4663]);
const POLL_MINUTES = 30;

const [deploymentId, ...coins] = process.argv.slice(2);
if (!deploymentId) throw new Error('usage: node scripts/verify.mjs <deploymentId> [coin address ...]');
const chainId = Number(/^chain-(\d+)/.exec(deploymentId)?.[1]);
if (!chainId) throw new Error(`cannot read a chain id from ${deploymentId}`);
const etherscanKey = ETHERSCAN_CHAINS.has(chainId) ? process.env.ETHERSCAN_API_KEY : undefined;
if (ETHERSCAN_CHAINS.has(chainId) && !etherscanKey) console.log('ETHERSCAN_API_KEY is not set: Sourcify only.');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (name) => name.split(':').pop();

/** What to verify: every contract in the deployment, then each coin from CoinCreator's build. */
const contracts = [];
const chains = [{ network: 'deployment', chainId, urls: { apiURL: ETHERSCAN, browserURL: '' } }];
for await (const [chain, info] of getVerificationInformation(join(packageRoot, 'ignition/deployments', deploymentId), chains, true)) {
  if (chain === null) console.log(`skipped ${info}: no artifacts`);
  else contracts.push(info);
}
const only = (process.env.ONLY ?? '').split(',').map((address) => address.trim().toLowerCase()).filter(Boolean);
const creator = contracts.find((info) => info.name.endsWith(':CoinCreator'));
if (coins.length && !creator) throw new Error('coins need the deployment’s CoinCreator build');
for (const address of coins) {
  contracts.push({ ...creator, address, name: 'contracts/Coin.sol:Coin', args: '' });
}

async function etherscan(params, init) {
  const url = `${ETHERSCAN}?chainid=${chainId}${init ? '' : `&${new URLSearchParams({ apikey: etherscanKey, ...params })}`}`;
  const response = await fetch(url, init);
  return response.json();
}

/** Submits to both; returns the jobs still to poll. */
async function submit(info) {
  const jobs = [];
  const label = `${short(info.name)} ${info.address}`;

  const existing = await fetch(`${SOURCIFY}/v2/contract/${chainId}/${info.address}`).then((r) => r.json()).catch(() => ({}));
  if (existing.match) console.log(`sourcify   ${existing.match.padEnd(18)} ${label}`);
  else {
    const response = await fetch(`${SOURCIFY}/v2/verify/${chainId}/${info.address}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stdJsonInput: JSON.parse(info.sourceCode),
        compilerVersion: info.compilerVersion.replace(/^v/, ''),
        contractIdentifier: info.name,
      }),
    });
    const json = await response.json().catch(() => ({}));
    if (json.verificationId) jobs.push({ at: 'sourcify', id: json.verificationId, label });
    else console.log(`sourcify   rejected           ${label}  ${JSON.stringify(json).slice(0, 200)}`);
  }

  if (etherscanKey) {
    await sleep(1100);
    const source = await etherscan({ module: 'contract', action: 'getsourcecode', address: info.address });
    if (source.result?.[0]?.SourceCode) console.log(`etherscan  verified           ${label}`);
    else {
      await sleep(1100);
      const json = await etherscan(undefined, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          apikey: etherscanKey,
          module: 'contract',
          action: 'verifysourcecode',
          contractaddress: info.address,
          sourceCode: info.sourceCode,
          codeformat: 'solidity-standard-json-input',
          contractname: info.name,
          compilerversion: info.compilerVersion,
          constructorArguements: info.args, // Etherscan's spelling
        }),
      });
      if (json.status === '1') jobs.push({ at: 'etherscan', id: json.result, label });
      else if (/already verified/i.test(json.result)) console.log(`etherscan  verified           ${label}`);
      else console.log(`etherscan  rejected           ${label}  ${json.result}`);
    }
  }
  return jobs;
}

/** One status read: the outcome, or null while it is still running. */
async function settle(job) {
  if (job.at === 'sourcify') {
    const status = await fetch(`${SOURCIFY}/v2/verify/${job.id}`).then((r) => r.json()).catch(() => ({}));
    if (!status.isJobCompleted) return null;
    return status.contract?.match ?? `failed: ${JSON.stringify(status.error).slice(0, 200)}`;
  }
  const status = await etherscan({ module: 'contract', action: 'checkverifystatus', guid: job.id }).catch(() => ({}));
  const message = String(status.result ?? '');
  if (!message || /pending in queue|rate limit/i.test(message)) return null;
  return message;
}

let pending = [];
for (const info of contracts) {
  if (only.length > 0 && !only.includes(info.address.toLowerCase())) continue;
  pending.push(...(await submit(info)));
}

const end = Date.now() + POLL_MINUTES * 60_000;
while (pending.length && Date.now() < end) {
  await sleep(5000);
  for (const job of [...pending]) {
    await sleep(1100);
    const outcome = await settle(job);
    if (outcome === null) continue;
    console.log(`${job.at.padEnd(10)} ${outcome.padEnd(18)} ${job.label}`);
    pending = pending.filter((other) => other !== job);
  }
}
for (const job of pending) console.log(`${job.at.padEnd(10)} still pending      ${job.label}  (${job.id})`);
