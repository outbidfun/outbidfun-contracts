import hre from 'hardhat';
import { encodeFunctionData, type Address } from 'viem';

/** What `OutbidMarket.initialize` takes, in order: what its constructor took before it was upgradeable. */
export type MarketArgs = readonly [
  owner: Address,
  usdg: Address,
  weth: Address,
  poolManager: Address,
  buyback: Address,
  treasury: Address,
  minBid: bigint,
  outbidIncrement: bigint,
];

/**
 * The outbid market as it is deployed: an implementation behind an `OutbidMarketProxy` that
 * initializes it with `args` in its constructor, read at the proxy's address. OpenZeppelin's proxy
 * refuses to be deployed uninitialized, so there is never a moment anyone else could initialize it.
 */
export async function deployMarket(args: MarketArgs) {
  const implementation = await hre.viem.deployContract('OutbidMarket', []);
  const proxy = await hre.viem.deployContract('OutbidMarketProxy', [implementation.address, initializeData(args)]);
  const market = await hre.viem.getContractAt('OutbidMarket', proxy.address);
  return Object.assign(market, { implementation });
}

/** `initialize`'s calldata, for a proxy that initializes in its constructor. */
export function initializeData(args: MarketArgs): `0x${string}` {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'initialize',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'initialOwner', type: 'address' },
          { name: 'usdg_', type: 'address' },
          { name: 'weth_', type: 'address' },
          { name: 'poolManager_', type: 'address' },
          { name: 'buyback_', type: 'address' },
          { name: 'treasury_', type: 'address' },
          { name: 'minBid_', type: 'uint256' },
          { name: 'outbidIncrement_', type: 'uint256' },
        ],
        outputs: [],
      },
    ],
    functionName: 'initialize',
    args: [...args],
  });
}
