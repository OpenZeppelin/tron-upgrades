// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "openzeppelin-tron-solidity/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "openzeppelin-tron-solidity/contracts/proxy/utils/UUPSUpgradeable.sol";

// A UUPS implementation: the upgrade entry point lives on the implementation
// itself (through the proxy), and there is no ProxyAdmin — the 1967 admin
// slot of its proxy must stay empty.
contract BoxUUPS is Initializable, UUPSUpgradeable {
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
        require(msg.sender == _upgrader, "BoxUUPS: caller cannot upgrade");
    }
}
