// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {TRC1967Proxy} from "openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Proxy.sol";
import {TRC1967Utils} from "openzeppelin-tron-solidity/contracts/proxy/TRC1967/TRC1967Utils.sol";

/// A v4-style transparent proxy fixture. Unlike the ported v5
/// TransparentUpgradeableProxy (which owns an immutable ProxyAdmin and
/// dispatches only upgradeToAndCall), the admin here is an EXTERNAL contract set
/// in the admin slot at construction, and the proxy exposes v4's separate
/// upgradeTo / upgradeToAndCall entry points behind an admin guard.
///
/// upgradeToAndCall reproduces v4's force-call constraint: it requires non-empty
/// data (v4 force-calls the implementation, so empty data would invoke a
/// receive/fallback that these implementations do not define). A plain upgrade
/// must therefore go through upgradeTo — which is exactly why a v4 ProxyAdmin
/// needs `upgrade(proxy, impl)` for the no-data case.
contract TestTransparentProxyV4 is TRC1967Proxy {
    constructor(
        address logic,
        address admin,
        bytes memory data
    ) payable TRC1967Proxy(logic, data) {
        TRC1967Utils.changeAdmin(admin);
    }

    modifier ifAdmin() {
        if (msg.sender == TRC1967Utils.getAdmin()) {
            _;
        } else {
            _fallback();
        }
    }

    function upgradeTo(address newImplementation) external ifAdmin {
        TRC1967Utils.upgradeToAndCall(newImplementation, "");
    }

    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable ifAdmin {
        require(data.length > 0, "TestTransparentProxyV4: use upgradeTo for empty data");
        TRC1967Utils.upgradeToAndCall(newImplementation, data);
    }
}
