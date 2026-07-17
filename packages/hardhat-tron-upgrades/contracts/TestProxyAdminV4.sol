// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface ITransparentProxyV4 {
    function upgradeTo(address newImplementation) external;
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

/// A v4-style ProxyAdmin fixture: owner-gated upgrade / upgradeAndCall and,
/// crucially, NO UPGRADE_INTERFACE_VERSION getter. The plugin's version probe
/// therefore reverts and must route to the v4 dispatch path — `upgrade` for a
/// plain upgrade, `upgradeAndCall` when there is post-upgrade call data.
contract TestProxyAdminV4 {
    address public owner;

    constructor(address initialOwner) {
        owner = initialOwner;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "TestProxyAdminV4: not owner");
        _;
    }

    function upgrade(address proxy, address implementation) external onlyOwner {
        ITransparentProxyV4(proxy).upgradeTo(implementation);
    }

    function upgradeAndCall(
        address proxy,
        address implementation,
        bytes calldata data
    ) external payable onlyOwner {
        ITransparentProxyV4(proxy).upgradeToAndCall{value: msg.value}(implementation, data);
    }
}
