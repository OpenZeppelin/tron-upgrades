// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Implementation that itself exposes implementation() — proxy-kind
/// classification must come from the proxy's 1967 slots, never from whether
/// a delegated implementation() call happens to succeed.
contract TestBoxWithImplementationFn {
    uint256 public value;
    address public owner;
    bool private _initialized;

    function initialize(address owner_, uint256 value_) external {
        require(!_initialized, "already initialized");
        _initialized = true;
        owner = owner_;
        value = value_;
    }

    function implementation() external view returns (address) {
        return address(this);
    }

    function version() external pure returns (string memory) {
        return "with-implementation-fn";
    }
}
