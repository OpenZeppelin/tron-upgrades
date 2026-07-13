// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "openzeppelin-tron-solidity/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "openzeppelin-tron-solidity/contracts/proxy/utils/UUPSUpgradeable.sol";

/// Layout-compatible upgrade of BoxUUPSV1: existing variables unchanged and
/// in the same order, new variable appended, upgrade mechanism retained.
contract BoxUUPSV2 is Initializable, UUPSUpgradeable {
    uint256 public value;
    address public owner;
    uint256 public incrementCount; // appended — safe

    error NotOwner();

    event Incremented(uint256 newValue);

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

    function increment() external {
        value += 1;
        incrementCount += 1;
        emit Incremented(value);
    }

    function version() external pure returns (string memory) {
        return "v2";
    }

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != owner) revert NotOwner();
    }
}
