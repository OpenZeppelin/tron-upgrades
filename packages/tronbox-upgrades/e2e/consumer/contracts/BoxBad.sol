// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Deliberately unsafe for an upgradeable implementation: an open delegatecall.
// The validation refusal test expects this contract to be rejected by name.
contract BoxBad {
    uint256 private _value;

    function smash(address target, bytes calldata data) public {
        (bool ok, ) = target.delegatecall(data);
        require(ok, "delegatecall failed");
    }
}
