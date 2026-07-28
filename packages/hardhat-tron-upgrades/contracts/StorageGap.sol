// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Gap-consumption pair: V2 spends one reserved slot on a new variable and
// shrinks the trailing gap to match. Total slots are preserved. Deciding this
// is safe needs slot/offset data from storageLayout; AST alone rejects it as a
// "Bad storage gap resize".
contract StorageGapV1 {
    uint256 public a;
    uint256[50] private __gap;
}

contract StorageGapV2 {
    uint256 public a;
    uint256 public b;
    uint256[49] private __gap;
}
