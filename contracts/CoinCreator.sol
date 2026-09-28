// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./Coin.sol";

/// @title The one contract that deploys coins
/// @notice The CoinFactory used to carry Coin's creation code inside its own, which left it a
///         few hundred bytes under the contract size limit with nothing to spare for the fee
///         rules the coin now enforces. So this contract holds the creation code and deploys
///         every coin, and the factory keeps the registry; each has room. It is deployed on its
///         own and bound to the factory once, because a factory that created it from its own
///         constructor would carry the creation code in its init code and break the init code
///         limit instead. A coin's address is derived from this contract's, which is why the
///         factory reads `initCodeHash` from here.
contract CoinCreator is Ownable {
    address public factory;
    bytes32 public immutable initCodeHash;

    event FactorySet(address indexed factory);

    error NotFactory();
    error FactoryAlreadySet();
    error ZeroAddress();

    constructor(address initialOwner) Ownable(initialOwner) {
        initCodeHash = keccak256(type(Coin).creationCode);
    }

    /// @notice Binds the factory that may deploy through this contract. Set once.
    function setFactory(address factory_) external onlyOwner {
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Deploys a coin at the CREATE2 address `salt` gives. The coin reads its terms from
    ///         the factory, which has set them just before calling.
    function create(bytes32 salt) external returns (address) {
        if (msg.sender != factory || factory == address(0)) revert NotFactory();
        return address(new Coin{salt: salt}());
    }
}
