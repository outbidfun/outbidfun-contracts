// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IERC20ParametersPacker.sol";

interface ICoinDeployer is IERC20ParametersPacker {
    /// @dev What a Coin reads from the factory while it is being constructed.
    struct MemeCoinParameters {
        address listingManager;
        /// @dev The asset the coin is priced in and raises: what a buy pays and a sell returns.
        address reserveToken;
        /// @dev Reserve, in that asset's own raw units, at which the coin graduates.
        uint96 cap;
        uint8 reserveDecimals;
        address formula;
        uint16 powerN;
        uint16 powerD;
        /// @dev Coins the curve has sold by the time it reaches the cap, in coin wei.
        uint128 supplyAtCap;
        uint32 coinIndex;
        address owner;
        /// @dev Where the creator's share of fees is credited, and who receives it.
        address feeEscrow;
        address creatorFeeRecipient;
        /// @dev The fee terms this coin keeps for life: the trading fee, the protocol's share of
        ///      it, the creator's own tax on top, and the launch-window snipe tax.
        uint16 feeBps;
        uint16 protocolShareBps;
        uint16 creatorTaxBps;
        uint16 snipeTaxStartBps;
        uint32 snipeTaxSeconds;
        /// @dev A reward coin's holder distributor and the share of every transfer it takes, in
        ///      basis points of the coins moved. Both zero for a standard coin.
        address rewardDistributor;
        uint16 rewardFeeBps;
        string description;
        string image;
        /// @dev The creator's links, as one JSON string: {"x":"…","telegram":"…","website":"…"}.
        string socials;
    }

    function allMemecoinsCount() external view returns (uint32);

    function parameters() external view returns (MemeCoinParameters memory);

    function isMemeCoinLegit(address memecoin) external view returns (bool);

    /// @notice Whether `account` was named at `memecoin`'s launch as exempt from the snipe tax.
    function isSnipeExempt(address memecoin, address account) external view returns (bool);
}

/// @notice What a Coin needs from the contract that deploys it: which factory to read from.
interface ICoinCreator {
    function factory() external view returns (address);
}
