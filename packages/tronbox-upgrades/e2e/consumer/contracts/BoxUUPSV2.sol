// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "openzeppelin-tron-solidity/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "openzeppelin-tron-solidity/contracts/proxy/utils/UUPSUpgradeable.sol";

// The upgrade target for BoxUUPS: same storage, one appended entry point —
// increment() exists only here, so a call through the proxy proves the new
// code is live.
contract BoxUUPSV2 is Initializable, UUPSUpgradeable {
    uint256 private _value;
    address private _upgrader;

    function initialize(uint256 value_) public initializer {
        _value = value_;
        _upgrader = msg.sender;
    }

    function value() public view returns (uint256) {
        return _value;
    }

    function increment() public {
        _value += 1;
    }

    function _authorizeUpgrade(address) internal view override {
        require(msg.sender == _upgrader, "BoxUUPSV2: caller cannot upgrade");
    }
}
