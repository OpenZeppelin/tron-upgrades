// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Unsafe repack pair: widening `a` from uint128 to uint256 pushes `b` out of
// the slot it shared with `a` and into the next slot. This must stay rejected
// whether or not storageLayout is present.
contract StorageRepackV1 {
    uint128 public a;
    uint128 public b;
}

contract StorageRepackV2 {
    uint256 public a;
    uint128 public b;
}
