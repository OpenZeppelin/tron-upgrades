// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Layout-compatible upgrade of TestBoxV1: existing variables unchanged and in
/// the same order; new variable appended at the end.
contract TestBoxV2 {
    uint256 public value;
    address public owner;
    bool private _initialized;
    uint256 public incrementCount; // appended — safe

    event Incremented(uint256 newValue);

    function initialize(address owner_, uint256 value_) external {
        require(!_initialized, "already initialized");
        _initialized = true;
        owner = owner_;
        value = value_;
    }

    function setValue(uint256 v) external {
        value = v;
    }

    function increment() external {
        value += 1;
        incrementCount += 1;
        emit Incremented(value);
    }

    function version() external pure returns (string memory) {
        return "v2";
    }
}
