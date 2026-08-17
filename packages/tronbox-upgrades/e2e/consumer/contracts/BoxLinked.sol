// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library LinkedMath {
    function double(uint256 value) public pure returns (uint256) {
        return value * 2;
    }
}

// The public library call leaves a real link reference in this contract's
// creation bytecode, so validation must require an explicit expert allowance.
contract BoxLinked {
    function double(uint256 value) public pure returns (uint256) {
        return LinkedMath.double(value);
    }
}
