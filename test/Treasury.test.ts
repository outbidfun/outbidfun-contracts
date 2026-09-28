import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { getAddress, parseEther, zeroAddress } from 'viem';

async function deployFixture() {
  const [owner, alice, bob] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const treasury = await hre.viem.deployContract('Treasury', [owner.account.address]);
  return { owner, alice, bob, publicClient, treasury };
}

describe('Treasury', () => {
  it('accounts for ETH per source', async () => {
    const { treasury, alice, bob } = await loadFixture(deployFixture);
    await alice.sendTransaction({ to: treasury.address, value: parseEther('1') });
    await bob.sendTransaction({ to: treasury.address, value: parseEther('2') });
    await alice.sendTransaction({ to: treasury.address, value: parseEther('0.5') });

    expect(await treasury.read.receivedFrom([alice.account.address])).to.equal(parseEther('1.5'));
    expect(await treasury.read.receivedFrom([bob.account.address])).to.equal(parseEther('2'));
    expect(await treasury.read.totalReceived()).to.equal(parseEther('3.5'));

    const events = await treasury.getEvents.Received(undefined, { fromBlock: 0n });
    expect(events).to.have.lengthOf(3);
    expect(events[1].args.source).to.equal(getAddress(bob.account.address));
    expect(events[1].args.amount).to.equal(parseEther('2'));
  });

  it('lets only the owner withdraw', async () => {
    const { treasury, owner, alice, bob, publicClient } = await loadFixture(deployFixture);
    await alice.sendTransaction({ to: treasury.address, value: parseEther('3') });

    await expect(
      treasury.write.withdraw([alice.account.address, parseEther('1')], { account: alice.account })
    ).to.be.rejectedWith('OwnableUnauthorizedAccount');
    await expect(
      treasury.write.withdraw([zeroAddress, parseEther('1')], { account: owner.account })
    ).to.be.rejectedWith('ZeroAddress');

    const before = await publicClient.getBalance({ address: bob.account.address });
    await treasury.write.withdraw([bob.account.address, parseEther('1')], { account: owner.account });
    const after = await publicClient.getBalance({ address: bob.account.address });

    expect(after - before).to.equal(parseEther('1'));
    expect(await treasury.read.totalWithdrawn()).to.equal(parseEther('1'));
    expect(await publicClient.getBalance({ address: treasury.address })).to.equal(parseEther('2'));
  });

  it('lets only the owner withdraw tokens, such as the coin side of pool fees', async () => {
    const { treasury, owner, alice } = await loadFixture(deployFixture);
    const token = await hre.viem.deployContract('MockERC20', ['Token', 'TKN', 18, parseEther('10')]);
    await token.write.transfer([treasury.address, parseEther('4')], { account: owner.account });

    await expect(
      treasury.write.withdrawToken([token.address, alice.account.address, parseEther('1')], {
        account: alice.account,
      })
    ).to.be.rejectedWith('OwnableUnauthorizedAccount');
    await treasury.write.withdrawToken([token.address, alice.account.address, parseEther('1')], {
      account: owner.account,
    });

    expect(await token.read.balanceOf([alice.account.address])).to.equal(parseEther('1'));
    expect(await token.read.balanceOf([treasury.address])).to.equal(parseEther('3'));
  });
});
