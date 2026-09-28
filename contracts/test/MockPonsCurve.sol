// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPonsV2BondingCurve} from "../interfaces/IPonsV2.sol";

/// @dev A PONS curve at a fixed price, `tokensPerQuote` launch tokens (wei) per whole unit of the
///      pair, with PONS's partial fill: a buy past what is left is filled to it and the rest
///      refunded to the caller, and `minTokensOut` then bounds the price, not the quantity.
contract MockPonsCurve is IPonsV2BondingCurve {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    /// Zero for a native launch.
    address public immutable pairToken;
    uint256 public immutable tokensPerQuote;
    uint256 private immutable _quoteUnit;
    bool public override graduated;
    uint256 public override sellableTokens;

    error CurveGraduated();
    error SlippageExceeded(uint256 tokensOut, uint256 minTokensOut);

    constructor(IERC20 token_, address pairToken_, uint8 pairDecimals, uint256 tokensPerQuote_) {
        token = token_;
        pairToken = pairToken_;
        tokensPerQuote = tokensPerQuote_;
        _quoteUnit = 10 ** pairDecimals;
    }

    /// @dev The tests fund the curve with what it may sell.
    function stock(uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
        sellableTokens += amount;
    }

    function setGraduated(bool value) external {
        graduated = value;
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable override returns (uint256 tokensOut) {
        if (graduated || sellableTokens == 0) revert CurveGraduated();
        if (pairToken == address(0)) {
            require(msg.value == quoteIn, "value");
        } else {
            require(msg.value == 0, "value");
            IERC20(pairToken).safeTransferFrom(msg.sender, address(this), quoteIn);
        }
        uint256 spent = quoteIn;
        tokensOut = (quoteIn * tokensPerQuote) / _quoteUnit;
        if (tokensOut > sellableTokens) {
            tokensOut = sellableTokens;
            spent = (tokensOut * _quoteUnit + tokensPerQuote - 1) / tokensPerQuote;
        }
        if (spent * minTokensOut > quoteIn * tokensOut) revert SlippageExceeded(tokensOut, minTokensOut);
        sellableTokens -= tokensOut;
        token.safeTransfer(recipient, tokensOut);
        uint256 refund = quoteIn - spent;
        if (refund != 0) {
            if (pairToken == address(0)) {
                (bool ok, ) = payable(msg.sender).call{value: refund}("");
                require(ok, "refund");
            } else {
                IERC20(pairToken).safeTransfer(msg.sender, refund);
            }
        }
    }
}
