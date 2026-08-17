// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Never deployed. Exists so the `initializer: false` refusal can be asserted
// against an artifact with no recorded proxy — a recorded one is reused
// before the initializer rule runs, so only a fresh artifact makes the
// refusal replay identically on every migrate run.
contract BoxSolo {
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
