// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// The upgrade target for BoxOptions: same storage, plus the store() the
// upgrade's `call: { fn: 'store', args: [99] }` dispatches into.
contract BoxOptionsV2 {
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

    function store(uint256 value_) public {
        _value = value_;
    }
}
