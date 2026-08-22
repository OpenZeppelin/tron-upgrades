// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/tron-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/tron-contracts/proxy/utils/UUPSUpgradeable.sol";

/// UUPS-style upgradeable implementation: the upgrade mechanism
/// (upgradeToAndCall) is inherited into this contract's bytecode.
contract TestBoxUUPSV1 is Initializable, UUPSUpgradeable {
    uint256 public value;
    address public owner;

    error NotOwner();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, uint256 value_) external initializer {
        owner = owner_;
        value = value_;
    }

    function setValue(uint256 v) external {
        value = v;
    }

    function version() external pure returns (string memory) {
        return "v1";
    }

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != owner) revert NotOwner();
    }
}
