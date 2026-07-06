// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Deliberately layout-INCOMPATIBLE upgrade of BoxV1: `owner` and `value`
/// are swapped, so v1's slot 0 (uint256 value) would be read as an address.
/// The upgrade-safety validator must reject BoxV1 -> BoxV2Broken.
contract BoxV2Broken {
    address public owner; // was slot 1 — now slot 0: INCOMPATIBLE
    uint256 public value; // was slot 0 — now slot 1: INCOMPATIBLE
    bool private _initialized;

    function initialize(address owner_, uint256 value_) external {
        require(!_initialized, "already initialized");
        _initialized = true;
        owner = owner_;
        value = value_;
    }

    function version() external pure returns (string memory) {
        return "v2-broken";
    }
}
