// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Layout-compatible successor to TestBoxV2.
contract TestBoxV3 {
    uint256 public value;
    address public owner;
    bool private _initialized;
    uint256 public incrementCount;
    uint256 public resetCount;

    function version() external pure returns (string memory) {
        return "v3";
    }
}
