import type { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox-viem';
import * as dotenv from 'dotenv';

dotenv.config();

// A variable that is present but blank is the normal state of a fresh .env, so treat it as
// absent everywhere: an accounts array holding an empty string fails deep inside signing, and
// an empty RPC URL is rejected by Hardhat with no hint as to which network it meant.
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();
const deployerAccounts = deployerKey ? [deployerKey as `0x${string}`] : [];

// The vendored Uniswap V3 sources (contracts/uniswap-v3) build exactly as upstream does, so the
// pool's creation code, and with it the POOL_INIT_CODE_HASH the periphery derives pool
// addresses from, stays canonical. test/UniswapV3.test.ts asserts the hash.
const uniswapV3Core = {
  version: '0.7.6',
  settings: {
    evmVersion: 'istanbul',
    optimizer: { enabled: true, runs: 800 },
    metadata: { bytecodeHash: 'none' },
  },
};
const uniswapV3Periphery = {
  version: '0.7.6',
  settings: {
    evmVersion: 'istanbul',
    optimizer: { enabled: true, runs: 1_000_000 },
    metadata: { bytecodeHash: 'none' },
  },
};

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: '0.8.24',
        // CoinFactory embeds Coin's creation code; a high runs value pushes it past 24KB.
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
      uniswapV3Core,
    ],
    overrides: {
      // The market carries its bid paths, the V4 swaps, the executor's and the board's migration:
      // 25.3KB through the legacy pipeline, past the 24KB limit even at runs 1. Through the IR
      // pipeline it is 21.5KB at the usual runs.
      'contracts/OutbidMarket.sol': { version: '0.8.24', settings: { viaIR: true, optimizer: { enabled: true, runs: 200 } } },
      // The executor's trade carries its fee side and the fee on the way out: past the legacy
      // pipeline's sixteen stack slots in \`execute\`, which the IR pipeline allocates itself.
      'contracts/SwapExecutor.sol': { version: '0.8.24', settings: { viaIR: true, optimizer: { enabled: true, runs: 200 } } },
      // A test router that imports the executor's router interface, and so compiles it too.
      'contracts/test/Router02Front.sol': { version: '0.8.24', settings: { viaIR: true, optimizer: { enabled: true, runs: 200 } } },
      'contracts/uniswap-v3/periphery/SwapRouter.sol': uniswapV3Periphery,
      'contracts/uniswap-v3/periphery/lens/QuoterV2.sol': uniswapV3Periphery,
    },
  },
  networks: {
    // Ethereum's public testnet. The platform deploys its own Uniswap V3, so the only thing it
    // needs from the chain is WETH — see ignition/config/sepolia.json.
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
      chainId: 11155111,
      accounts: deployerAccounts,
    },
    robinhood: {
      url: process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
      chainId: 4663,
      accounts: deployerAccounts,
    },
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC_URL || 'https://rpc.testnet.chain.robinhood.com',
      chainId: 46630,
      accounts: deployerAccounts,
    },
  },
  // For `hardhat verify` on one contract: Etherscan's multichain API, one key for every chain it
  // covers — Robinhood Chain mainnet among them, at robin.etherscan.io — and Blockscout, the chain's
  // own explorer, in the same run. Etherscan does not cover the testnet; Blockscout verifies it
  // alone. Mainnet's Blockscout API sits behind a bot challenge that turns scripts away; it shows
  // what Sourcify has verified. A whole deployment is verified with `scripts/verify.mjs`, not
  // `hardhat ignition verify` (the script says why).
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || '',
    customChains: [
      {
        network: 'robinhood',
        chainId: 4663,
        urls: { apiURL: 'https://api.etherscan.io/v2/api', browserURL: 'https://robin.etherscan.io' },
      },
    ],
  },
  blockscout: {
    enabled: true,
    customChains: [
      {
        network: 'robinhood',
        chainId: 4663,
        urls: {
          apiURL: 'https://robinhoodchain.blockscout.com/api',
          browserURL: 'https://robinhoodchain.blockscout.com',
        },
      },
      {
        network: 'robinhoodTestnet',
        chainId: 46630,
        urls: {
          apiURL: 'https://explorer.testnet.chain.robinhood.com/api',
          browserURL: 'https://explorer.testnet.chain.robinhood.com',
        },
      },
    ],
  },
};

export default config;
