// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReleasable {
    function release(address asset) external;
}

/// @dev Test double for a destination whose `receive()` calls the router back, the shape audit
///      F-03 used: an operations wallet or grants contract with a hook, not a plain Safe.
contract ReenteringReceiver {
    IReleasable public immutable router;
    uint256 public received;
    bool private _entered;

    constructor(IReleasable router_) {
        router = router_;
    }

    receive() external payable {
        received += msg.value;
        if (_entered) return;
        _entered = true;
        // Swallowed, so the re-entry does not take the outer payment down with it: the point
        // is what the router pays, not what this contract does with the failure.
        try router.release(address(0)) {} catch {}
        _entered = false;
    }
}
