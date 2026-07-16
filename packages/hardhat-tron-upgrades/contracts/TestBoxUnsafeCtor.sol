// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Deliberately non-annotated constructor for unsafeAllow tests.
contract TestBoxUnsafeCtor {
    constructor() {
        require(msg.sender != address(0), "zero deployer");
    }

    function version() external pure returns (string memory) {
        return "unsafe-ctor";
    }
}
