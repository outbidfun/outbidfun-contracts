import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { getAddress, hexToString, parseEventLogs, stringToHex, zeroAddress, type Address } from 'viem';

/** A kind as the registry takes it: the name's ASCII, as a bytes32. */
const kind = (name: string) => stringToHex(name, { size: 32 });

/**
 * `ProtocolRegistry`: the one address readers outside the protocol follow redeploys by. It lists
 * contracts by kind, each with its deployment block, only as the owner adds them, once each, and
 * never forgets one.
 */
describe('ProtocolRegistry', () => {
  async function registryFixture() {
    const [owner, stranger] = await hre.viem.getWalletClients();
    const registry = await hre.viem.deployContract('ProtocolRegistry', [owner!.account.address]);
    // Three contracts to register: anything with code will do.
    const a = await hre.viem.deployContract('WETH9', []);
    const b = await hre.viem.deployContract('WETH9', []);
    const c = await hre.viem.deployContract('WETH9', []);
    const publicClient = await hre.viem.getPublicClient();
    return { registry, owner: owner!, stranger: stranger!, a: getAddress(a.address), b: getAddress(b.address), c: getAddress(c.address), publicClient };
  }

  it('lists contracts by kind, each with its block, the latest last, and says what kind each is', async () => {
    const { registry, publicClient, a, b, c } = await loadFixture(registryFixture);
    let hash = await registry.write.register([kind('TradeRouter'), a, 1n]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const [registered] = parseEventLogs({ abi: registry.abi, logs: receipt.logs, eventName: 'Registered' });
    expect(registered!.args).to.deep.equal({ kind: kind('TradeRouter'), target: a, fromBlock: 1n });
    hash = await registry.write.register([kind('TradeRouter'), b, 2n]);
    await publicClient.waitForTransactionReceipt({ hash });
    hash = await registry.write.register([kind('CoinFactory'), c, 3n]);
    await publicClient.waitForTransactionReceipt({ hash });

    expect(await registry.read.addresses([kind('TradeRouter')])).to.deep.equal([a, b]);
    expect(await registry.read.entries([kind('TradeRouter')])).to.deep.equal([
      { target: a, fromBlock: 1n },
      { target: b, fromBlock: 2n },
    ]);
    expect(await registry.read.latest([kind('TradeRouter')])).to.equal(b);
    expect(await registry.read.count([kind('TradeRouter')])).to.equal(2n);
    expect(await registry.read.kindOf([c])).to.equal(kind('CoinFactory'));
    expect((await registry.read.kinds()).map((k) => hexToString(k, { size: 32 }))).to.deep.equal(['TradeRouter', 'CoinFactory']);
    // A kind nothing is registered as is empty, not an error.
    expect(await registry.read.addresses([kind('OutbidMarket')])).to.deep.equal([]);
    expect(await registry.read.latest([kind('OutbidMarket')])).to.equal(zeroAddress);
  });

  it('registers several at once, in order', async () => {
    const { registry, publicClient, a, b, c } = await loadFixture(registryFixture);
    const hash = await registry.write.registerMany([
      [kind('CoinFactory'), kind('CoinFactory'), kind('RevenueRouter')],
      [a, b, c],
      [1n, 2n, 3n],
    ]);
    await publicClient.waitForTransactionReceipt({ hash });
    expect(await registry.read.addresses([kind('CoinFactory')])).to.deep.equal([a, b]);
    expect(await registry.read.latest([kind('RevenueRouter')])).to.equal(c);
    await expect(registry.write.registerMany([[kind('CoinFactory')], [a, b], [1n]])).to.be.rejectedWith('LengthMismatch');
  });

  it('takes a contract once, with code and a kind, from the owner alone', async () => {
    const { registry, publicClient, stranger, a, b } = await loadFixture(registryFixture);
    const hash = await registry.write.register([kind('TradeRouter'), a, 1n]);
    await publicClient.waitForTransactionReceipt({ hash });
    // Once, and never as another kind: what a reader was told stays true.
    await expect(registry.write.register([kind('TradeRouter'), a, 1n])).to.be.rejectedWith('AlreadyRegistered');
    await expect(registry.write.register([kind('CoinFactory'), a, 1n])).to.be.rejectedWith('AlreadyRegistered');
    await expect(registry.write.register([kind('TradeRouter'), stranger.account.address as Address, 1n])).to.be.rejectedWith('NoCode');
    await expect(registry.write.register([`0x${'00'.repeat(32)}`, b, 1n])).to.be.rejectedWith('NoKind');
    await expect(registry.write.register([kind('TradeRouter'), b, 1n], { account: stranger.account })).to.be.rejectedWith(
      'OwnableUnauthorizedAccount'
    );
    // Nothing to remove, and nothing to change: the registry has no such function.
    expect(registry.abi.filter((item) => item.type === 'function').map((item) => item.name).sort()).to.deep.equal(
      ['addresses', 'count', 'entries', 'kindOf', 'kinds', 'latest', 'owner', 'register', 'registerMany', 'renounceOwnership', 'transferOwnership'].sort()
    );
  });

  it('takes a deployment block above the EVM\'s block.number, as an Arbitrum chain\'s own blocks are', async () => {
    // On Robinhood Chain `block.number` is Ethereum's block (about 26 million) while logs are
    // looked up by the chain's own (about 76 million): the registry must take the latter.
    const { registry, publicClient, a } = await loadFixture(registryFixture);
    const hash = await registry.write.register([kind('TradeRouter'), a, 75_757_709n]);
    await publicClient.waitForTransactionReceipt({ hash });
    expect(await registry.read.entries([kind('TradeRouter')])).to.deep.equal([{ target: a, fromBlock: 75_757_709n }]);
  });
});
