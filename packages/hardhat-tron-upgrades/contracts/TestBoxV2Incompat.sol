// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Safe from TestBoxV1 (one appended slot), but unsafe from TestBoxV2 because slot 2
/// changes meaning from incrementCount to rewardPoints.
contract TestBoxV2Incompat {
    uint256 public value;
    address public owner;
    bool private _initialized;
    uint256 public rewardPoints;

    function version() external pure returns (string memory) {
        return "v2-incompatible";
    }
}
