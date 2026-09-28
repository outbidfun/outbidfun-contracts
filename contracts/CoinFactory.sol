// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./CoinDeployer.sol";

contract CoinFactory is CoinDeployer {
    mapping(address => AccountInfo) public accounts;
    mapping(string => address) public nicknamesToAccounts;
    mapping(address => address[]) public memecoinsByCreators;

    struct AccountInfo {
        string nickname;
        string profilePicture;
        uint256 createdMemecoinsCount;
    }

    event AccountInfoUpdated(address indexed account, string indexed nickname, string profilePicture);

    constructor(
        address formula_,
        address listingManager_,
        address feeEscrow_,
        CoinCreator coinCreator_,
        address rewardsImplementation_
    ) CoinDeployer(formula_, listingManager_, feeEscrow_, coinCreator_, rewardsImplementation_) { }

    function updateAccountInfo(string memory nickname, string memory profilePicture) external virtual {
        require(nicknamesToAccounts[nickname] == address(0) || nicknamesToAccounts[nickname] == msg.sender, "Nickname exists");
        AccountInfo storage account = accounts[msg.sender];
        // Free the name being left behind, or nobody could ever take it (audit F-16).
        if (bytes(account.nickname).length > 0) delete nicknamesToAccounts[account.nickname];
        account.nickname = nickname;
        account.profilePicture = profilePicture;
        nicknamesToAccounts[nickname] = msg.sender;
        emit AccountInfoUpdated(msg.sender, nickname, profilePicture);
    }

    function deploy(
        LaunchParams calldata params,
        address[] calldata snipeExemptions
    ) public payable override returns (address memecoin) {
        require((getAddress(params.symbol)).code.length == 0, "Symbol is already used");

        memecoin = super.deploy(params, snipeExemptions);

        unchecked { accounts[msg.sender].createdMemecoinsCount++; }
        memecoinsByCreators[msg.sender].push(memecoin);
    }
}
