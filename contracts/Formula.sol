// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Power.sol";

contract Formula is Power {
  uint32 private constant MAX_WEIGHT = 1000000;

  /**
    * @dev The supply an outbidfun.lol curve holds at `reserve`, given that it holds `supplyAtCap`
    * when its reserve reaches `cap`:
    *
    *   supply = supplyAtCap · (reserve / cap) ^ (powerD / n),   n = powerN + powerD
    *
    * Every coin's curve has the same shape and sells the same number of coins by the time it
    * graduates; the cap fixes how much of the coin's own reserve token that takes, in that
    * token's raw units, so nothing here needs to know how many decimals the token has. Both
    * amounts are in the same units, which keeps `power()`'s base small: raising a raw wei figure
    * to the 5/11 asked it for a base near 1e19 and it answered 0.2% short (audit G-01).
    * `power()` only takes a base of at least one, so a reserve under the cap is raised the
    * other way up and divided.
    *
    * @return supply in coin wei (1e18 per whole coin)
    */
  function supplyAt(
    uint256 reserve,
    uint256 cap,
    uint256 supplyAtCap,
    uint16 powerN,
    uint16 powerD
  ) public view returns (uint256) {
    if (reserve == 0) return 0;
    require(cap > 0, "Zero cap");
    uint32 n = uint32(powerN) + powerD;

    if (reserve >= cap) {
      (uint256 above, uint8 abovePrecision) = power(reserve, cap, powerD, n);
      return (supplyAtCap * above) >> abovePrecision;
    }
    (uint256 result, uint8 precision) = power(cap, reserve, powerD, n);
    return (supplyAtCap << precision) / result;
  }

  /**
    * @dev given a token supply, reserve balance, weight and an amount (in the main token),
    * calculates the amount of reserve tokens required for purchasing the given amount of pool tokens
    *
    * Formula:
    * return = _reserveBalance * ((_amount / _supply + 1) ^ (1000000 / _reserveWeight) - 1)
    *
    * @param _supply          liquid token supply
    * @param _reserveBalance  reserve balance
    * @param _reserveWeight   reserve weight, represented in ppm (1-1000000)
    * @param _amount          requested amount of pool tokens
    *
    * @return reserve token amount
    */
  function purchaseCost(
    uint256 _supply,
    uint256 _reserveBalance,
    uint32 _reserveWeight,
    uint256 _amount
  ) public view virtual returns (uint256) {
    // validate input
    require(_supply > 0, "ERR_INVALID_SUPPLY");
    require(_reserveBalance > 0, "ERR_INVALID_RESERVE_BALANCE");
    require(_reserveWeight > 0 && _reserveWeight <= MAX_WEIGHT, "ERR_INVALID_RESERVE_RATIO");

    // special case for 0 amount
    if (_amount == 0) return 0;

    // special case if the reserve weight = 100%
    if (_reserveWeight == MAX_WEIGHT) return (_amount * _reserveBalance - 1) / _supply + 1;

    uint256 result;
    uint8 precision;
    uint256 baseN = _supply + _amount;
    (result, precision) = power(baseN, _supply, MAX_WEIGHT, _reserveWeight);
    uint256 temp = (_reserveBalance * result - 1) >> precision;
    return temp - _reserveBalance;
  }

  /**
    * @dev given a token supply, reserve balance, weight and a deposit amount (in the reserve token),
    * calculates the target amount for a given conversion (in the main token)
    *
    * Formula:
    * return = _supply * ((1 + _amount / _reserveBalance) ^ (_reserveWeight / 1000000) - 1)
    *
    * @param _supply          liquid token supply
    * @param _reserveBalance  reserve balance
    * @param _reserveWeight   reserve weight, represented in ppm (1-1000000)
    * @param _amount          amount of reserve tokens to get the target amount for
    *
    * @return target
    */
  function purchaseTargetAmount(
    uint256 _supply,
    uint256 _reserveBalance,
    uint32 _reserveWeight,
    uint256 _amount
  ) public view virtual returns (uint256) {
    // validate input
    require(_supply > 0, "ERR_INVALID_SUPPLY");
    require(_reserveBalance > 0, "ERR_INVALID_RESERVE_BALANCE");
    require(_reserveWeight > 0 && _reserveWeight <= MAX_WEIGHT, "ERR_INVALID_RESERVE_WEIGHT");

    // special case for 0 deposit amount
    if (_amount == 0) return 0;

    // special case if the weight = 100%
    if (_reserveWeight == MAX_WEIGHT) return _supply * _amount / _reserveBalance;

    uint256 result;
    uint8 precision;
    uint256 baseN = _amount + _reserveBalance;
    (result, precision) = power(baseN, _reserveBalance, _reserveWeight, MAX_WEIGHT);
    uint256 temp = (_supply * result >> precision) + 1;
    return temp - _supply;
  }

  /**
    * @dev given a token supply, reserve balance, weight and a sell amount (in the main token),
    * calculates the target amount for a given conversion (in the reserve token)
    *
    * Formula:
    * return = _reserveBalance * (1 - (1 - _amount / _supply) ^ (1000000 / _reserveWeight))
    *
    * @param _supply          liquid token supply
    * @param _reserveBalance  reserve balance
    * @param _reserveWeight   reserve weight, represented in ppm (1-1000000)
    * @param _amount          amount of liquid tokens to get the target amount for
    *
    * @return reserve token amount
    */
  function saleTargetAmount(
    uint256 _supply,
    uint256 _reserveBalance,
    uint32 _reserveWeight,
    uint256 _amount
  ) public view virtual returns (uint256) {
    // validate input
    require(_supply > 0, "ERR_INVALID_SUPPLY");
    require(_reserveBalance > 0, "ERR_INVALID_RESERVE_BALANCE");
    require(_reserveWeight > 0 && _reserveWeight <= MAX_WEIGHT, "ERR_INVALID_RESERVE_WEIGHT");
    require(_amount <= _supply, "ERR_INVALID_AMOUNT");

    // special case for 0 sell amount
    if (_amount == 0) return 0;

    // special case for selling the entire supply
    if (_amount == _supply) return _reserveBalance;

    // special case if the weight = 100%
    if (_reserveWeight == MAX_WEIGHT) return _reserveBalance * _amount / _supply;

    uint256 result;
    uint8 precision;
    uint256 baseD = _supply - _amount;
    (result, precision) = power(_supply, baseD, MAX_WEIGHT, _reserveWeight);
    uint256 temp1 = _reserveBalance * result;
    uint256 temp2 = _reserveBalance << precision;
    return (temp1 - temp2) / result;
  }
}
