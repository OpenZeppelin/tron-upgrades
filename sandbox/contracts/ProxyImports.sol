// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Pull the ported proxy contracts into this project's compilation so their
// artifacts are available to tests. No code of our own here.
import {TRC1967Proxy} from "openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol";
import {TransparentUpgradeableProxy} from "openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol";
import {UpgradeableBeacon} from "openzeppelin-tron-solidity/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "openzeppelin-tron-solidity/contracts/proxy/beacon/BeaconProxy.sol";
