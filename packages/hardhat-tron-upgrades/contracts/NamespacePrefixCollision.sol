// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Cross-prefix namespace cases. TRC-7201 and ERC-7201 derive the slot from the
// namespace id WITHOUT the prefix, so the same id under both prefixes is one
// slot; upgrades-core keys namespaces by the full annotation string and does
// not see the clash.

// -- collision inside a single contract -------------------------------------
contract NsCollideSelf {
    /// @custom:storage-location erc7201:example.collide
    struct AStorage {
        uint256 a;
    }

    /// @custom:storage-location trc7201:example.collide
    struct BStorage {
        uint256 b;
    }

    uint256 public dummy;
}

// -- collision inherited from a base contract -------------------------------
contract NsCollideBase {
    /// @custom:storage-location erc7201:example.collide.inherited
    struct BaseStorage {
        uint256 a;
    }
}

contract NsCollideDerived is NsCollideBase {
    /// @custom:storage-location trc7201:example.collide.inherited
    struct DerivedStorage {
        uint256 b;
    }

    uint256 public dummy;
}

// -- negative control: different ids under different prefixes ---------------
contract NsPrefixDisjoint {
    /// @custom:storage-location erc7201:example.disjoint.a
    struct AStorage {
        uint256 a;
    }

    /// @custom:storage-location trc7201:example.disjoint.b
    struct BStorage {
        uint256 b;
    }

    uint256 public dummy;
}
