// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// ERC-7201 namespaced storage cases. Namespace struct members are not ordinary
// storage variables, so they carry no slot/offset in the primary build-info.
// Deciding these upgrades needs a second compilation of source rewritten to
// expose the members as storage variables (upgrades-core's makeNamespacedInput).

// -- packing change: reordering members shifts their slots ------------------
contract NsPackV1 {
    /// @custom:storage-location erc7201:example.main
    struct MainStorage {
        uint128 a;
        uint128 b;
        uint256 c;
    }

    bytes32 private constant LOCATION =
        0x183a6125c38840424c4a85fa12bab2ab606c4b6d0e7cc73c0c06ba5300eab500;

    function _s() private pure returns (MainStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function c() external view returns (uint256) {
        return _s().c;
    }
}

contract NsPackV2 {
    /// @custom:storage-location erc7201:example.main
    struct MainStorage {
        uint128 a;
        uint256 c;
        uint128 b;
    }

    bytes32 private constant LOCATION =
        0x183a6125c38840424c4a85fa12bab2ab606c4b6d0e7cc73c0c06ba5300eab500;

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
contract NsAppendV1 {
    /// @custom:storage-location erc7201:example.append
    struct AppendStorage {
        uint256 a;
        uint256 b;
    }

    bytes32 private constant LOCATION =
        0x26261a64516a9f040ade8da10dc97da56c09cc408c16e99f0362c20384152700;

    function _s() private pure returns (AppendStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function a() external view returns (uint256) {
        return _s().a;
    }
}

contract NsAppendV2 {
    /// @custom:storage-location erc7201:example.append
    struct AppendStorage {
        uint256 a;
        uint256 b;
        uint256 c;
    }

    bytes32 private constant LOCATION =
        0x26261a64516a9f040ade8da10dc97da56c09cc408c16e99f0362c20384152700;

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
contract NsPadV1 {
    /// @custom:storage-location erc7201:example.pad
    struct PadStorage {
        uint128 a;
        uint256 b;
    }

    bytes32 private constant LOCATION =
        0x21a2c6d3c7c0af37ff39948590567c6627b89a85c510ec1ad3110c70d4ebde00;

    function _s() private pure returns (PadStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function b() external view returns (uint256) {
        return _s().b;
    }
}

contract NsPadV2 {
    /// @custom:storage-location erc7201:example.pad
    struct PadStorage {
        uint128 a;
        uint128 x;
        uint256 b;
    }

    bytes32 private constant LOCATION =
        0x21a2c6d3c7c0af37ff39948590567c6627b89a85c510ec1ad3110c70d4ebde00;

    function _s() private pure returns (PadStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function b() external view returns (uint256) {
        return _s().b;
    }
}

// -- namespace deletion: dropping a namespace is unsafe ----------------------
contract NsDeleteV1 {
    /// @custom:storage-location erc7201:example.delete
    struct DeleteStorage {
        uint256 a;
        uint256 b;
    }

    bytes32 private constant LOCATION =
        0x063008e3131617e3077d22a384b7d9fed05c5c74a777d824e909e9feb9c39600;

    function _s() private pure returns (DeleteStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function a() external view returns (uint256) {
        return _s().a;
    }
}

contract NsDeleteV2 {
    uint256 public unrelated;
}

// -- namespace id change: renaming a namespace is unsafe --------------------
contract NsIdV1 {
    /// @custom:storage-location erc7201:example.renamed.before
    struct IdStorage {
        uint256 a;
    }

    bytes32 private constant LOCATION =
        0x04770d0881dc55328b93cc821082c2e2641ae68072333649ccae61a14af06800;

    function _s() private pure returns (IdStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function a() external view returns (uint256) {
        return _s().a;
    }
}

contract NsIdV2 {
    /// @custom:storage-location erc7201:example.renamed.after
    struct IdStorage {
        uint256 a;
    }

    bytes32 private constant LOCATION =
        0x54964b6ba1c7978d6b50fc45ed31aa86b940f24de0d2a003e471a42f23401b00;

    function _s() private pure returns (IdStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function a() external view returns (uint256) {
        return _s().a;
    }
}

// -- nested struct change: shrinking a nested struct shifts later members ----
contract NsNestedV1 {
    struct Inner {
        uint256 p;
        uint256 q;
    }

    /// @custom:storage-location erc7201:example.nested
    struct NestedStorage {
        Inner inner;
        uint256 c;
    }

    bytes32 private constant LOCATION =
        0x7c8eeffe93d2c8691027a60bcd0ff9a95d1610b7167c1a5d4723646b2d90e500;

    function _s() private pure returns (NestedStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function c() external view returns (uint256) {
        return _s().c;
    }
}

contract NsNestedV2 {
    struct Inner {
        uint256 p;
    }

    /// @custom:storage-location erc7201:example.nested
    struct NestedStorage {
        Inner inner;
        uint256 c;
    }

    bytes32 private constant LOCATION =
        0x7c8eeffe93d2c8691027a60bcd0ff9a95d1610b7167c1a5d4723646b2d90e500;

    function _s() private pure returns (NestedStorage storage $) {
        assembly {
            $.slot := LOCATION
        }
    }

    function c() external view returns (uint256) {
        return _s().c;
    }
}
