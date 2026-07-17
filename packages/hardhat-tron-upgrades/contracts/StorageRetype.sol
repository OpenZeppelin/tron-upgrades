// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Same-size retype pair: `data` changes type but keeps its 32-byte width, and
// the change is annotated as intentional. Confirming the width is unchanged
// needs numberOfBytes from storageLayout; AST alone rejects it as "Layout
// could have changed".
contract StorageRetypeV1 {
    uint256 public x;
    uint256 public data;
}

contract StorageRetypeV2 {
    uint256 public x;
    /// @custom:oz-retyped-from uint256
    bytes32 public data;
}
