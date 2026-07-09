// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Minimal upgradeable-style implementation: initializer instead of
/// constructor, storage layout that V2 must preserve.
contract BoxV1 {
    uint256 public value;
    address public owner;
    bool private _initialized;

    event Initialized(address owner, uint256 value);

    function initialize(address owner_, uint256 value_) external {
        require(!_initialized, "already initialized");
        _initialized = true;
        owner = owner_;
        value = value_;
        emit Initialized(owner_, value_);
    }

    function setValue(uint256 v) external {
        value = v;
    }

    function version() external pure returns (string memory) {
        return "v1";
    }
}
