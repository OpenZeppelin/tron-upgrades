// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// Import this file once from any contract in your project to make the ported
// proxy artifacts available to the plugin:
//
//   import "@openzeppelin/hardhat-tron-upgrades/contracts/Proxies.sol";
//
// Hardhat only compiles node_modules sources that are imported by the
// project, and the plugin deploys these proxies by artifact name.
import {TRC1967Proxy} from "openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol";
import {TransparentUpgradeableProxy} from "openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol";
import {UpgradeableBeacon} from "openzeppelin-tron-solidity/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "openzeppelin-tron-solidity/contracts/proxy/beacon/BeaconProxy.sol";

/// Stable upgrade entry points for UUPS proxies. The plugin calls the CURRENT
/// implementation through the proxy, dispatching on the proxy's reported
/// UPGRADE_INTERFACE_VERSION: v5 exposes upgradeToAndCall, v4-style
/// implementations expose upgradeTo. Attaching this interface (never the new
/// implementation's ABI) keeps the call shape independent of either side.
interface ITronUpgradesUUPS {
    function upgradeTo(address newImplementation) external;
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}
