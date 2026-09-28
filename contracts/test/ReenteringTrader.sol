// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ICoinTrade {
    function buy(uint256 amountIn, uint256 minAmount) external;
    function sell(uint256 amount, uint256 minValue) external;
    function balanceOf(address account) external view returns (uint256);
    function reserveToken() external view returns (address);
}

/// @dev Test double for a contract seller that trades again while being paid, the shape audit
///      F-08 was about. The payout is a token transfer now, so the turn comes through the
///      token's own hook rather than `receive()`.
contract ReenteringTrader {
    ICoinTrade public immutable coin;
    bool public attempted;
    bool public reentered;
    bool private _selling;

    constructor(ICoinTrade coin_) {
        coin = coin_;
        IERC20(coin_.reserveToken()).approve(address(coin_), type(uint256).max);
    }

    /// @notice Spends `amount` of the reserve token this contract holds.
    function buy(uint256 amount) external {
        coin.buy(amount, 0);
    }

    function sellAll() external {
        _selling = true;
        coin.sell(coin.balanceOf(address(this)), 0);
        _selling = false;
    }

    /// @dev The reserve token calls this as the sale is paid out.
    function onTokenReceived(address, uint256) external {
        if (!_selling || attempted) return;
        attempted = true;
        // Swallowed: the point is whether the coin lets this through, not what happens after.
        try coin.buy(1e15, 0) {
            reentered = true;
        } catch {
            reentered = false;
        }
    }
}
