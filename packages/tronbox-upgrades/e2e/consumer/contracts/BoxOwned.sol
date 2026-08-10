// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Deployed transparent with an explicit `initialOwner`: the proxy's admin
// must be owned by that address on-chain, not by the deploying account.
contract BoxOwned {
    uint256 private _value;
    bool private _initialized;

    function initialize(uint256 value_) public {
        require(!_initialized, "already initialized");
        _initialized = true;
        _value = value_;
    }

    function value() public view returns (uint256) {
        return _value;
    }
}
