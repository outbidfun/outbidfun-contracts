// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAllocatable {
    function allocate(address asset) external;
}

/// @dev Test double for a destination whose `receive()` calls the router's `allocate` while it is
///      being paid, the shape of AUDIT-3 H-03.
contract ReallocatingReceiver {
    IAllocatable public immutable router;
    uint256 public received;
    bool private _entered;

    constructor(IAllocatable router_) {
        router = router_;
    }

    receive() external payable {
        received += msg.value;
        if (_entered) return;
        _entered = true;
        // Swallowed, so the outer payment stands: what matters is what the books say after.
        try router.allocate(address(0)) {} catch {}
        _entered = false;
    }
}
