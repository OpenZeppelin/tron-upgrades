// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Bytecode-distinct from every normally deployed implementation so the
// reuse-only upgrade path has no exact version available in the record.
contract BoxNever {
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

    function neverMarker() public pure returns (bytes4) {
        return 0x4e455645;
    }
}
