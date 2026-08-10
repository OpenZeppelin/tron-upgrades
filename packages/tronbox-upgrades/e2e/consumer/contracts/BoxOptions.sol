// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// The transparent proxy that later takes an upgrade carrying a `call`
// option. V1 deliberately has no store(): the post-upgrade call must run
// against the NEW implementation.
contract BoxOptions {
    uint256 private _value;
    bool private _initialized;

    function initialize(uint256 value_) public {
        require(!_initialized, "already initialized");
        _initialized = true;
        _value = value_;
    }

    function retrieve() public view returns (uint256) {
        return _value;
    }
}
