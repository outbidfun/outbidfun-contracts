import { encodeAbiParameters, encodePacked, keccak256, type Address, type Hex } from 'viem';

/**
 * The two encoders the tests share with the outbidfun.lol web app, which is not part of this
 * repository: a Uniswap V3 swap path, and the `SwapExecutor` trade a route's hash is taken over.
 * They are copies of the app's own (`encodeSwapPath` in `src/utils/route.ts`, `routeHashOf` in
 * `src/utils/routing/execution.ts`), so the tests check the same bytes the app sends.
 */

/**
 * A Uniswap V3 swap path: 20 bytes of token, 3 of fee, repeating, ending at `tokenOut`. The router
 * reads it as tightly packed bytes with no ABI decoding, so a wrongly packed path is a different
 * path rather than an error.
 */
export function encodeSwapPath(hops: readonly (readonly [Address, number])[], tokenOut: Address): Hex {
  const types: ('address' | 'uint24')[] = [];
  const values: (Address | number)[] = [];
  for (const [token, fee] of hops) {
    types.push('address', 'uint24');
    values.push(token, fee);
  }
  types.push('address');
  values.push(tokenOut);
  return encodePacked(types, values);
}

/** The executor's `Trade`, which is also what a route's hash is taken over. */
export type Trade = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  recipient: Address;
  deadline: bigint;
  legs: { amountIn: bigint; minOut: bigint; steps: { router: Address; path: Hex }[] }[];
};

const TRADE = [
  {
    type: 'tuple',
    components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
      { name: 'deadline', type: 'uint256' },
      {
        name: 'legs',
        type: 'tuple[]',
        components: [
          { name: 'amountIn', type: 'uint256' },
          { name: 'minOut', type: 'uint256' },
          {
            name: 'steps',
            type: 'tuple[]',
            components: [
              { name: 'router', type: 'address' },
              { name: 'path', type: 'bytes' },
            ],
          },
        ],
      },
    ],
  },
] as const;

/** `keccak256(abi.encode(trade))`: what `SwapExecutor` emits as `routeHash`. */
export function routeHashOf(trade: Trade): Hex {
  return keccak256(encodeAbiParameters(TRADE, [trade]));
}
