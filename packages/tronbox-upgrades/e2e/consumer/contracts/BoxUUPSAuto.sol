// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/tron-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/tron-contracts/proxy/utils/UUPSUpgradeable.sol";

// A second UUPS implementation, deployed with the `kind` option OMITTED: the
// plugin must INFER uups from the public upgrade entry point — never default
// to transparent — so its proxy's 1967 admin slot must stay empty. A
// separate contract from BoxUUPS on purpose: each omitted-option scenario
// needs its own replay memory, and BoxUUPS's proxy is recorded under the
// explicit-kind deploy.
contract BoxUUPSAuto is Initializable, UUPSUpgradeable {
    uint256 private _value;
    address private _upgrader;

    function initialize(uint256 value_) public initializer {
        _value = value_;
        _upgrader = msg.sender;
    }

    function value() public view returns (uint256) {
        return _value;
    }

    function _authorizeUpgrade(address) internal view override {
        require(msg.sender == _upgrader, "BoxUUPSAuto: caller cannot upgrade");
    }
}
