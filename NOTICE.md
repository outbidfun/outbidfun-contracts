# Third-party code

Every Solidity file states its license in its SPDX header. Everything not listed here is the
outbidfun.lol code, under the MIT License in [LICENSE](LICENSE).

| Path | Origin | License |
| ---- | ------ | ------- |
| `contracts/uniswap-v3/core/` | [Uniswap/v3-core](https://github.com/Uniswap/v3-core) tag `v1.0.0` | Files headed `BUSL-1.1` are under the Business Source License 1.1 ([text and parameters](LICENSES/BUSL-1.1-Uniswap-v3-core.txt)), whose Change Date of 2023-04-01 has passed: they are now available under its Change License, GPL-2.0-or-later. The rest are `GPL-2.0-or-later` or `MIT` as headed. |
| `contracts/uniswap-v3/periphery/` | [Uniswap/v3-periphery](https://github.com/Uniswap/v3-periphery) commit `0682387` | `GPL-2.0-or-later` ([text](LICENSES/GPL-2.0-or-later.txt)), and two OpenZeppelin 3.x interfaces under `MIT`. |
| `contracts/Power.sol` | The power function of Bancor's `BancorFormula` ([bancorprotocol/contracts-solidity](https://github.com/bancorprotocol/contracts-solidity) commit `7d54d59`, December 2019, then released under Apache-2.0), ported to Solidity 0.8 and reduced to what the curve uses | `Apache-2.0` ([text](LICENSES/Apache-2.0.txt)) |
| `@openzeppelin/contracts` | npm dependency, not vendored | `MIT` |

What was changed in the vendored Uniswap V3 sources, and why, is in
[contracts/uniswap-v3/README.md](contracts/uniswap-v3/README.md): one `require` so that only the
factory's owner can create pools, imports rewritten to relative paths, and pragmas bounded below
0.8. The compiler settings match upstream, so the pool's init code hash is canonical.
