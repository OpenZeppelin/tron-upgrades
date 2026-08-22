// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/tron-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/tron-contracts/proxy/utils/UUPSUpgradeable.sol";

/// Layout-compatible successor to TestBoxUUPSV2.
contract TestBoxUUPSV3 is Initializable, UUPSUpgradeable {
    uint256 public value;
    address public owner;
    uint256 public incrementCount;
    uint256 public resetCount;

    error NotOwner();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function version() external pure returns (string memory) {
        return "v3";
    }

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != owner) revert NotOwner();
    }
}
