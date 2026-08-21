// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

// Import this file once from any contract in your project to make the ported
// proxy artifacts available to the plugin:
//
//   import "@openzeppelin/tronbox-upgrades/contracts/Proxies.sol";
//
// TronBox compiles the import closure of your contracts/ sources, and the
// plugin deploys these proxies by artifact name — so one import here is what
// puts TransparentUpgradeableProxy, ProxyAdmin and TRC1967Proxy into your
// build output. Without it, deploy operations refuse naming the missing
// artifact and this file as the remedy.
import {TRC1967Proxy} from "@openzeppelin/tron-contracts/proxy/TRC1967/TRC1967Proxy.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/tron-contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/tron-contracts/proxy/transparent/ProxyAdmin.sol";
import {UpgradeableBeacon} from "@openzeppelin/tron-contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/tron-contracts/proxy/beacon/BeaconProxy.sol";

/// Stable upgrade entry points for UUPS proxies. The plugin calls the CURRENT
/// implementation through the proxy, dispatching on the proxy's reported
/// UPGRADE_INTERFACE_VERSION: v5 exposes upgradeToAndCall, v4-style
/// implementations expose upgradeTo. Attaching this interface (never the new
/// implementation's ABI) keeps the call shape independent of either side.
interface ITronUpgradesUUPS {
    function upgradeTo(address newImplementation) external;
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

/// v4-style ProxyAdmin entry points, for a transparent proxy imported from a v4
/// deployment whose ProxyAdmin predates UPGRADE_INTERFACE_VERSION. v5 ProxyAdmin
/// dropped `upgrade`; the plugin dispatches on the admin's reported version, so
/// both a v4 admin (this interface) and a v5 admin remain callable. `upgrade` is
/// used for a plain upgrade and `upgradeAndCall` when post-upgrade data is set.
interface ITronUpgradesProxyAdminV4 {
    function upgrade(address proxy, address implementation) external;
    function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable;
}
