// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/tron-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/tron-contracts/proxy/utils/UUPSUpgradeable.sol";

/// Safe from TestBoxUUPSV1, but unsafe from TestBoxUUPSV2 because its appended slot
/// changes meaning from incrementCount to rewardPoints.
contract TestBoxUUPSV2Incompat is Initializable, UUPSUpgradeable {
    uint256 public value;
    address public owner;
    uint256 public rewardPoints;

    error NotOwner();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function version() external pure returns (string memory) {
        return "v2-incompatible";
    }

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != owner) revert NotOwner();
    }
}
