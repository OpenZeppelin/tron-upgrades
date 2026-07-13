// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "openzeppelin-tron-solidity/contracts/proxy/utils/Initializable.sol";

/// Negative fixture: storage-compatible with TestBoxUUPSV1 but does NOT inherit
/// UUPSUpgradeable — it has no upgrade mechanism. Upgrading a UUPS proxy to
/// this contract would brick it permanently, so the upgrade-safety validation
/// must reject it before anything reaches the chain.
contract TestBoxUUPSV2MissingUpgradeFunction is Initializable {
    uint256 public value;
    address public owner;
    uint256 public incrementCount;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, uint256 value_) external initializer {
        owner = owner_;
        value = value_;
    }

    function version() external pure returns (string memory) {
        return "v2-no-button";
    }
}
