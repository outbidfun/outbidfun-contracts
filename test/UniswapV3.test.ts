import { loadFixture } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256 } from 'viem';

/**
 * The vendored Uniswap V3 build. Two things must hold for the periphery to find pools:
 * the pool's creation code has to hash to the constant PoolAddress derives addresses from,
 * and the one change to the factory (owner-only pool creation) has to behave.
 */
describe('Uniswap V3 (vendored)', () => {
  it('compiles the pool to the canonical creation code PoolAddress expects', () => {
    const root = join(__dirname, '..');
    const artifact = JSON.parse(
      readFileSync(
        join(root, 'artifacts/contracts/uniswap-v3/core/UniswapV3Pool.sol/UniswapV3Pool.json'),
        'utf8'
      )
    ) as { bytecode: `0x${string}` };
    const source = readFileSync(
      join(root, 'contracts/uniswap-v3/periphery/libraries/PoolAddress.sol'),
      'utf8'
    );
    const expected = /POOL_INIT_CODE_HASH = (0x[0-9a-f]{64});/.exec(source)?.[1];

    expect(expected).to.equal('0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54');
    expect(keccak256(artifact.bytecode)).to.equal(expected);
  });

  async function deployFixture() {
    const [owner, stranger] = await hre.viem.getWalletClients();
    const factory = await hre.viem.deployContract('UniswapV3Factory', []);
    const weth = await hre.viem.deployContract('WETH9', []);
    const token = await hre.viem.deployContract('MockERC20', ['Token', 'TKN', 18, 0n]);
    return { owner: owner!, stranger: stranger!, factory, weth, token };
  }

  it('lets only the factory owner create pools', async () => {
    const { owner, stranger, factory, weth, token } = await loadFixture(deployFixture);

    await expect(
      factory.write.createPool([token.address, weth.address, 10_000], {
        account: stranger.account,
      })
    ).to.be.rejected;

    await factory.write.createPool([token.address, weth.address, 10_000], {
      account: owner.account,
    });
    const pool = await factory.read.getPool([token.address, weth.address, 10_000]);
    expect(pool).to.not.equal('0x0000000000000000000000000000000000000000');
  });

  it('keeps the standard fee tiers and lets the owner hand the factory over', async () => {
    const { owner, stranger, factory } = await loadFixture(deployFixture);
    expect(await factory.read.feeAmountTickSpacing([500])).to.equal(10);
    expect(await factory.read.feeAmountTickSpacing([3000])).to.equal(60);
    expect(await factory.read.feeAmountTickSpacing([10_000])).to.equal(200);

    await factory.write.setOwner([stranger.account.address], { account: owner.account });
    expect((await factory.read.owner()).toLowerCase()).to.equal(
      stranger.account.address.toLowerCase()
    );
  });
});
