import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { getAddress, parseEther, parseUnits, zeroAddress } from 'viem';

const BUYBACK_BPS = 8000n;
const OPERATIONS_BPS = 2000n;
/** The router's key for ether. */
const ETHER = zeroAddress;

async function deployFixture() {
  const [owner, buyback, operations, payer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const router = await hre.viem.deployContract('RevenueRouter', [
    owner!.account.address,
    buyback!.account.address,
    operations!.account.address,
    BUYBACK_BPS,
    OPERATIONS_BPS,
  ]);
  // A six-decimal dollar, the way a coin priced in one pays its fees.
  const usdc = await hre.viem.deployContract('MockERC20', ['USD Coin', 'USDC', 6, 0n]);
  await usdc.write.mint([payer!.account.address, parseUnits('1000000', 6)]);
  return { owner, buyback, operations, payer, publicClient, router, usdc };
}

describe('RevenueRouter', () => {
  it('cannot be re-entered into paying a destination twice (audit F-03)', async () => {
    const { owner, buyback, payer, publicClient } = await loadFixture(deployFixture);
    // The router's address is needed to construct the destination and vice versa, so deploy
    // the router pointing anywhere, then re-point it at the re-entering wallet.
    const router = await hre.viem.deployContract('RevenueRouter', [
      owner!.account.address,
      buyback!.account.address,
      payer!.account.address,
      BUYBACK_BPS,
      OPERATIONS_BPS,
    ]);
    const fund = await hre.viem.deployContract('ReenteringReceiver', [router.address]);
    await router.write.setDestinations([buyback!.account.address, fund.address], { account: owner!.account });

    await payer!.sendTransaction({ to: router.address, value: parseEther('10') });
    await router.write.allocate([ETHER]);
    // Ten more ETH arrive but are not allocated: this is what the second payment came out of.
    await payer!.sendTransaction({ to: router.address, value: parseEther('10') });

    await router.write.release([ETHER]);

    // Paid its 20% share once, not twice, and the unallocated revenue is untouched.
    expect(await fund.read.received()).to.equal(parseEther('2'));
    expect(await router.read.pending([ETHER])).to.equal(parseEther('10'));
    expect(await publicClient.getBalance({ address: router.address })).to.equal(parseEther('10'));

    // The books still match the balance, so the router is not stranded.
    await router.write.allocateAndRelease([ETHER]);
    expect(await fund.read.received()).to.equal(parseEther('4'));
    expect(await publicClient.getBalance({ address: router.address })).to.equal(0n);
  });

  it('cannot be re-entered into splitting money twice through allocate (AUDIT-3 H-03)', async () => {
    const { owner, operations, payer, publicClient } = await loadFixture(deployFixture);
    const router = await hre.viem.deployContract('RevenueRouter', [
      owner!.account.address,
      payer!.account.address,
      operations!.account.address,
      BUYBACK_BPS,
      OPERATIONS_BPS,
    ]);
    // The buyback destination calls allocate while it is being paid.
    const fund = await hre.viem.deployContract('ReallocatingReceiver', [router.address]);
    await router.write.setDestinations([fund.address, operations!.account.address], { account: owner!.account });

    await payer!.sendTransaction({ to: router.address, value: parseEther('10') });
    await router.write.allocate([ETHER]);
    await payer!.sendTransaction({ to: router.address, value: parseEther('10') });
    await router.write.release([ETHER]);

    // The re-entrant split was refused: the books never claim more than the router holds.
    const held = await publicClient.getBalance({ address: router.address });
    const owed = (await router.read.buybackBalance([ETHER])) + (await router.read.operationsBalance([ETHER]));
    expect(owed <= held).to.equal(true);
    expect(held).to.equal(parseEther('10'));
    // Counted once each: 20 ETH arrived, not the 22 the re-entrant split used to record.
    expect(await router.read.totalReceived([ETHER])).to.equal(parseEther('20'));
    expect(await fund.read.received()).to.equal(parseEther('8'));
  });

  it('stores the split from the tokenomics: 80% buyback, 20% operations', async () => {
    const { router } = await loadFixture(deployFixture);
    expect(await router.read.buybackBps()).to.equal(BUYBACK_BPS);
    expect(await router.read.operationsBps()).to.equal(OPERATIONS_BPS);
    expect(await router.read.BPS()).to.equal(10_000n);
    expect(await router.read.ETHER()).to.equal(zeroAddress);
  });

  it('rejects a split that does not add up and zero destinations', async () => {
    const { owner, buyback, operations, router } = await loadFixture(deployFixture);
    await expect(router.write.setSplit([8000n, 1000n], { account: owner!.account })).to.be.rejectedWith(
      'InvalidSplit'
    );
    await expect(
      hre.viem.deployContract('RevenueRouter', [
        owner!.account.address,
        zeroAddress,
        operations!.account.address,
        BUYBACK_BPS,
        OPERATIONS_BPS,
      ])
    ).to.be.rejectedWith('ZeroAddress');
    // Sanity: a valid change is accepted.
    await router.write.setSplit([5000n, 5000n], { account: owner!.account });
    expect(await router.read.buybackBps()).to.equal(5000n);
    expect(getAddress(await router.read.buyback())).to.equal(getAddress(buyback!.account.address));
  });

  it('counts any plain transfer of ether as revenue', async () => {
    const { router, payer } = await loadFixture(deployFixture);
    await payer!.sendTransaction({ to: router.address, value: parseEther('1') });
    await router.write.receiveRevenue({ value: parseEther('0.5'), account: payer!.account });

    expect(await router.read.pending([ETHER])).to.equal(parseEther('1.5'));
    expect(await router.read.totalReceived([ETHER])).to.equal(parseEther('1.5'));

    const events = await router.getEvents.RevenueReceived(undefined, { fromBlock: 0n });
    expect(events).to.have.lengthOf(2);
    expect(events[0]!.args.asset).to.equal(zeroAddress);
  });

  it('splits 100 ETH into 80 / 20 (tokenomics example)', async () => {
    const { router, payer } = await loadFixture(deployFixture);
    await payer!.sendTransaction({ to: router.address, value: parseEther('100') });

    await router.write.allocate([ETHER]);

    expect(await router.read.pending([ETHER])).to.equal(0n);
    expect(await router.read.buybackBalance([ETHER])).to.equal(parseEther('80'));
    expect(await router.read.operationsBalance([ETHER])).to.equal(parseEther('20'));
    expect(await router.read.totalAllocatedToBuyback([ETHER])).to.equal(parseEther('80'));
    expect(await router.read.totalAllocatedToOperations([ETHER])).to.equal(parseEther('20'));
  });

  it('splits a token the same way, kept apart from ether', async () => {
    const { router, payer, usdc, buyback, operations } = await loadFixture(deployFixture);
    // A coin priced in dollars pays its fee as a plain transfer; the router learns of it when
    // someone allocates, and the dollar's books never touch the ether's.
    await usdc.write.transfer([router.address, parseUnits('1000', 6)], { account: payer!.account });
    await payer!.sendTransaction({ to: router.address, value: parseEther('1') });

    expect(await router.read.pending([usdc.address])).to.equal(parseUnits('1000', 6));
    expect(await router.read.totalReceived([usdc.address])).to.equal(0n);

    await router.write.allocateAndRelease([usdc.address]);

    expect(await router.read.totalReceived([usdc.address])).to.equal(parseUnits('1000', 6));
    expect(await router.read.totalAllocatedToBuyback([usdc.address])).to.equal(parseUnits('800', 6));
    expect(await usdc.read.balanceOf([buyback!.account.address])).to.equal(parseUnits('800', 6));
    expect(await usdc.read.balanceOf([operations!.account.address])).to.equal(parseUnits('200', 6));
    expect(await usdc.read.balanceOf([router.address])).to.equal(0n);

    // The ether is still waiting, untouched by the dollar's release.
    expect(await router.read.pending([ETHER])).to.equal(parseEther('1'));
    expect(await router.read.totalReceived([ETHER])).to.equal(parseEther('1'));
    // And a token's arrival is not announced as ether revenue.
    const events = await router.getEvents.RevenueReceived(undefined, { fromBlock: 0n });
    expect(events).to.have.lengthOf(1);
  });

  it('gives rounding dust to the buyback so nothing is stranded', async () => {
    const { router, payer } = await loadFixture(deployFixture);
    await payer!.sendTransaction({ to: router.address, value: 7n });

    await router.write.allocate([ETHER]);

    const buyback = await router.read.buybackBalance([ETHER]);
    const operations = await router.read.operationsBalance([ETHER]);
    expect(operations).to.equal(1n); // 7 * 20%
    expect(buyback).to.equal(6n); // remainder, not 5
    expect(buyback + operations).to.equal(7n);
  });

  it('refuses to allocate nothing', async () => {
    const { router, usdc } = await loadFixture(deployFixture);
    await expect(router.write.allocate([ETHER])).to.be.rejectedWith('NothingToAllocate');
    await expect(router.write.allocate([usdc.address])).to.be.rejectedWith('NothingToAllocate');
  });

  it('releases each share to its destination', async () => {
    const { router, payer, buyback, operations, publicClient } = await loadFixture(deployFixture);
    await payer!.sendTransaction({ to: router.address, value: parseEther('10') });

    const before = {
      buyback: await publicClient.getBalance({ address: buyback!.account.address }),
      operations: await publicClient.getBalance({ address: operations!.account.address }),
    };

    await router.write.allocateAndRelease([ETHER]);

    expect((await publicClient.getBalance({ address: buyback!.account.address })) - before.buyback).to.equal(
      parseEther('8')
    );
    expect(
      (await publicClient.getBalance({ address: operations!.account.address })) - before.operations
    ).to.equal(parseEther('2'));

    expect(await router.read.buybackBalance([ETHER])).to.equal(0n);
    expect(await publicClient.getBalance({ address: router.address })).to.equal(0n);
    await expect(router.write.release([ETHER])).to.be.rejectedWith('NothingToRelease');
  });

  it('pays the destination that will take it (audit F-16)', async () => {
    const { owner, router, buyback, operations, payer, publicClient } = await loadFixture(deployFixture);
    const stubborn = await hre.viem.deployContract('RejectingReceiver', []);
    await router.write.setDestinations([buyback!.account.address, stubborn.address], { account: owner!.account });

    await payer!.sendTransaction({ to: router.address, value: parseEther('10') });
    const buybackBefore = await publicClient.getBalance({ address: buyback!.account.address });
    await router.write.allocateAndRelease([ETHER]);

    // The one that accepts is paid; the one that refuses keeps its share allocated.
    expect((await publicClient.getBalance({ address: buyback!.account.address })) - buybackBefore).to.equal(
      parseEther('8')
    );
    expect(await router.read.operationsBalance([ETHER])).to.equal(parseEther('2'));
    expect(await publicClient.getBalance({ address: router.address })).to.equal(parseEther('2'));

    // Re-point it and the share is still there to collect.
    await router.write.setDestinations([buyback!.account.address, operations!.account.address], {
      account: owner!.account,
    });
    await router.write.release([ETHER]);
    expect(await router.read.operationsBalance([ETHER])).to.equal(0n);
    expect(await publicClient.getBalance({ address: router.address })).to.equal(0n);
  });

  it('counts ETH that arrived without receive() (audit G-04)', async () => {
    const { router, buyback, publicClient } = await loadFixture(deployFixture);
    await hre.viem.deployContract('ForceSend', [router.address], { value: parseEther('5') });
    expect(await router.read.pending([ETHER])).to.equal(parseEther('5'));

    const before = await publicClient.getBalance({ address: buyback!.account.address });
    await router.write.allocateAndRelease([ETHER]);
    expect(await router.read.totalReceived([ETHER])).to.equal(parseEther('5'));
    expect((await publicClient.getBalance({ address: buyback!.account.address })) - before).to.equal(
      parseEther('4')
    );
    expect(await publicClient.getBalance({ address: router.address })).to.equal(0n);
  });

  it('names who refused when nobody takes their share (audit G-08)', async () => {
    const { owner, router, payer } = await loadFixture(deployFixture);
    const stubborn = await hre.viem.deployContract('RejectingReceiver', []);
    await router.write.setDestinations([stubborn.address, stubborn.address], { account: owner!.account });
    await payer!.sendTransaction({ to: router.address, value: parseEther('1') });
    await expect(router.write.allocateAndRelease([ETHER])).to.be.rejectedWith('TransferFailed');
  });

  it('restricts configuration to the owner', async () => {
    const { router, payer } = await loadFixture(deployFixture);
    await expect(router.write.setSplit([5000n, 5000n], { account: payer!.account })).to.be.rejectedWith(
      'OwnableUnauthorizedAccount'
    );
    await expect(
      router.write.setDestinations([payer!.account.address, payer!.account.address], { account: payer!.account })
    ).to.be.rejectedWith('OwnableUnauthorizedAccount');
  });
});
