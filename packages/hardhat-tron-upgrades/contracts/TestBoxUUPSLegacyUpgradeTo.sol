// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "openzeppelin-tron-solidity/contracts/proxy/utils/Initializable.sol";
import {StorageSlot} from "openzeppelin-tron-solidity/contracts/utils/StorageSlot.sol";

/// UUPS-style implementation exposing only the v4 upgrade entry point,
/// upgradeTo(address) — no upgradeToAndCall, no UPGRADE_INTERFACE_VERSION.
/// upgrades-core accepts either entry point as UUPS-safe, so the plugin must
/// be able to upgrade a proxy whose CURRENT implementation looks like this.
/// Storage-compatible with TestBoxUUPSV1 (and upgradeable to TestBoxUUPSV2) —
/// inherits Initializable so the ERC-7201 namespace is preserved.
contract TestBoxUUPSLegacyUpgradeTo is Initializable {
    bytes32 internal constant _IMPL_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    uint256 public value;
    address public owner;

    event Upgraded(address indexed implementation);

    function upgradeTo(address newImplementation) external {
        require(msg.sender == owner, "not the owner");
        StorageSlot.getAddressSlot(_IMPL_SLOT).value = newImplementation;
        emit Upgraded(newImplementation);
    }

    /// ERC-1822: required by the v5 upgradeToAndCall that installs this
    /// contract (it verifies the new implementation is proxiable).
    function proxiableUUID() external pure returns (bytes32) {
        return _IMPL_SLOT;
    }

    function version() external pure returns (string memory) {
        return "legacy";
    }
}
