// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract Counter {
    uint256 public value;

    event Incremented(uint256 newValue);

    function increment() external {
        value += 1;
        emit Incremented(value);
    }
}
