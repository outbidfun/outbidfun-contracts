import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { parseEther } from 'viem';

/**
 * Deploys the Treasury and the OutbidMarket with the V1 economic configuration: a 1 USDG minimum
 * bid and a fixed 2 USDG step to take the top spot, both stated at eighteen decimals.
 *
 * Every bid is paid in USDG, and only coins priced in USDG can be bid on. A bidder holding ether,
 * wrapped ether or another routed token can pay with it: the market swaps it to USDG through a
 * Uniswap V4 route in the same transaction (routes are set per asset by `BidRoute`). Each bid is
 * split 75% to buying and burning the coin bid on, 20% to $OUTBID and 5% to the treasury. The 20%
 * buys $OUTBID and burns it in the bid once the buyback vault is enabled; until then it collects
 * in the vault. The vault does not exist yet at this point, so the treasury stands in for it until
 * `OutbidEconomy` points the market at the vault with `setDestinations`.
 *
 * The step to take #1 defaults to 5 USDG over the leader's total (`outbidIncrement`, at eighteen
 * decimals), the minimum bid to 1 USDG.
 *
 * Parameters (the `Outbidfun` section of the parameters file):
 *   usdg          USDG on this chain (Robinhood Chain: 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168)
 *   weth          the chain's WETH, which bidders may pay with; it is swapped as ether
 *   poolManager   the Uniswap V4 PoolManager to swap through (Robinhood Chain:
 *                 0x8366a39CC670B4001A1121B8F6A443A643e40951). The zero address leaves the market
 *                 taking USDG only.
 *
 * Before anyone can bid, the Launchpad module sets the registry to the CoinFactory, and USDG has
 * to be listed as an asset coins can be priced in (a `QuoteAsset` run).
 */
const OutbidfunModule = buildModule('Outbidfun', (m) => {
  const owner = m.getAccount(0);
  const usdg = m.getParameter<string>('usdg');
  const weth = m.getParameter<string>('weth');
  const poolManager = m.getParameter<string>('poolManager', '0x0000000000000000000000000000000000000000');
  const minBid = m.getParameter('minBid', parseEther('1'));
  const outbidIncrement = m.getParameter('outbidIncrement', parseEther('5'));

  const treasury = m.contract('Treasury', [owner]);
  // The market lives behind its proxy, which initializes it as it is deployed (OutbidMarketV3.ts
  // says why). `Outbidfun#OutbidMarket` is the proxy, read as the market. The mainnet and testnet
  // records predate this: their `Outbidfun#OutbidMarket` is the first market, deployed directly.
  const implementation = m.contract('OutbidMarket', [], { id: 'OutbidMarketImplementation' });
  const initialize = m.encodeFunctionCall(implementation, 'initialize', [
    owner,
    usdg,
    weth,
    poolManager,
    treasury,
    treasury,
    minBid,
    outbidIncrement,
  ]);
  const proxy = m.contract('OutbidMarketProxy', [implementation, initialize]);
  const auction = m.contractAt('OutbidMarket', proxy, { id: 'OutbidMarket' });

  return { treasury, auction };
});

export default OutbidfunModule;
