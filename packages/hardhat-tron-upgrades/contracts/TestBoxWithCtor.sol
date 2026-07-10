// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Constructor arguments participate in the implementation version key even
/// when they do not affect runtime storage.
contract TestBoxWithCtor {
    uint256 public value;
    address public owner;
    bool private _initialized;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(uint256) {}

    function initialize(address owner_, uint256 value_) external {
        require(!_initialized, "already initialized");
        _initialized = true;
        owner = owner_;
        value = value_;
    }

    function version() external pure returns (string memory) {
        return "ctor";
    }
}
