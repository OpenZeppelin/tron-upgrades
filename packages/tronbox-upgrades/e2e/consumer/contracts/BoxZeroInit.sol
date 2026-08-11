// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// A zero-argument default initializer: `deployProxy(BoxZeroInit, [], handles)`
// with the `initializer` option OMITTED must TRY `initialize()` — the ABI
// decides, never the argument count — encode it, and deploy initialized with
// the constant below. The refusal belongs only to a contract whose ABI has
// no default initializer at all.
contract BoxZeroInit {
    uint256 private _value;
    bool private _initialized;

    function initialize() public {
        require(!_initialized, "already initialized");
        _initialized = true;
        _value = 7;
    }

    function value() public view returns (uint256) {
        return _value;
    }
}
