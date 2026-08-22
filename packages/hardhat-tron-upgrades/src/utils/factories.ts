// Proxy artifacts come from the ported contracts library, compiled by the
// consumer project (see README). Fully-qualified names are required because
// the bridge's bare-name artifact index only covers local sources.
const PROXY_PKG = '@openzeppelin/tron-contracts/proxy';

export const FQN = {
  transparent: `${PROXY_PKG}/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy`,
  proxyAdmin: `${PROXY_PKG}/transparent/ProxyAdmin.sol:ProxyAdmin`,
  trc1967: `${PROXY_PKG}/TRC1967/TRC1967Proxy.sol:TRC1967Proxy`,
  beacon: `${PROXY_PKG}/beacon/UpgradeableBeacon.sol:UpgradeableBeacon`,
  beaconProxy: `${PROXY_PKG}/beacon/BeaconProxy.sol:BeaconProxy`,
};
