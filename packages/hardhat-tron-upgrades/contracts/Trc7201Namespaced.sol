// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// TRC-7201 (TIP-7201) namespaced storage cases. Identical to the ERC-7201
// fixtures in Namespaced.sol except for the annotation prefix: tron-contracts
// annotates namespaces with `@custom:storage-location trc7201:<id>`. The
// slot-derivation formula is identical to ERC-7201's, so the same namespace id
// yields the same slot. Annotations are passed to upgrades-core verbatim;
// identity for cross-prefix collision detection is prefix-insensitive (see
// src/utils/namespace-prefix.ts). Coexisting with the erc7201 fixtures, these
// also exercise the mixed case.

// -- packing change: reordering members shifts their slots ------------------
contract TrcNsPackV1 {
    /// @custom:storage-location trc7201:example.trc.pack
    struct MainStorage {
        uint128 a;
        uint128 b;
        uint256 c;
    }

    bytes32 private constant LOCATION =
        0xad72ba1ecf8b75354b933ec81c7c2d308c494361c551b69e4a52dae8ebdc4d00;

    function _s() private pure returns (MainStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function c() external view returns (uint256) {
        return _s().c;
    }
}

contract TrcNsPackV2 {
    /// @custom:storage-location trc7201:example.trc.pack
    struct MainStorage {
        uint128 a;
        uint256 c;
        uint128 b;
    }

    bytes32 private constant LOCATION =
        0xad72ba1ecf8b75354b933ec81c7c2d308c494361c551b69e4a52dae8ebdc4d00;

    function _s() private pure returns (MainStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function c() external view returns (uint256) {
        return _s().c;
    }
}

// -- append: a new trailing member is safe ----------------------------------
contract TrcNsAppendV1 {
    /// @custom:storage-location trc7201:example.trc.append
    struct AppendStorage {
        uint256 a;
        uint256 b;
    }

    bytes32 private constant LOCATION =
        0x93526f735de8eac0d4f3c8f1725f09aaf12124df936f836e81b21dfe0c4f1900;

    function _s() private pure returns (AppendStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function a() external view returns (uint256) {
        return _s().a;
    }
}

contract TrcNsAppendV2 {
    /// @custom:storage-location trc7201:example.trc.append
    struct AppendStorage {
        uint256 a;
        uint256 b;
        uint256 c;
    }

    bytes32 private constant LOCATION =
        0x93526f735de8eac0d4f3c8f1725f09aaf12124df936f836e81b21dfe0c4f1900;

    function _s() private pure returns (AppendStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function a() external view returns (uint256) {
        return _s().a;
    }
}

// -- padding insert: a member fills intra-slot padding without moving others -
contract TrcNsPadV1 {
    /// @custom:storage-location trc7201:example.trc.pad
    struct PadStorage {
        uint128 a;
        uint256 b;
    }

    bytes32 private constant LOCATION =
        0x66b35466c539698068ce01848d80fc88f1c05e1cd1783716695da43405afdb00;

    function _s() private pure returns (PadStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function b() external view returns (uint256) {
        return _s().b;
    }
}

contract TrcNsPadV2 {
    /// @custom:storage-location trc7201:example.trc.pad
    struct PadStorage {
        uint128 a;
        uint128 x;
        uint256 b;
    }

    bytes32 private constant LOCATION =
        0x66b35466c539698068ce01848d80fc88f1c05e1cd1783716695da43405afdb00;

    function _s() private pure returns (PadStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function b() external view returns (uint256) {
        return _s().b;
    }
}

// -- namespace id change: renaming a namespace is unsafe --------------------
contract TrcNsIdV1 {
    /// @custom:storage-location trc7201:example.trc.renamed.before
    struct IdStorage {
        uint256 a;
    }

    bytes32 private constant LOCATION =
        0x2420b6a7b1c31b14f827e2ff8fc5035577927f5b3971a76bd5fe6153ea8cf500;

    function _s() private pure returns (IdStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function a() external view returns (uint256) {
        return _s().a;
    }
}

contract TrcNsIdV2 {
    /// @custom:storage-location trc7201:example.trc.renamed.after
    struct IdStorage {
        uint256 a;
    }

    bytes32 private constant LOCATION =
        0xef788cb98a1fef87d1c237d904ed79612585216f6d59c1b6ff18a7979348c500;

    function _s() private pure returns (IdStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function a() external view returns (uint256) {
        return _s().a;
    }
}
