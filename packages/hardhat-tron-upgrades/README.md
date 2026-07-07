# @openzeppelin/hardhat-tron-upgrades

Deploy and upgrade proxies on TRON (TVM) with upgrade-safety validations —
the Upgrades plugin for Hardhat projects using
[`@openzeppelin/hardhat-tron`](https://github.com/OpenZeppelin/hardhat-tron).

> **Status: early development — API and manifest format may change. Not audited, not published.**

```js
// hardhat.config.cjs
require('@openzeppelin/hardhat-tron');
require('@openzeppelin/hardhat-tron-upgrades');
```

```js
const { upgrades } = require('hardhat');

// validate → deploy implementation → deploy proxy → initialize → record
const box = await upgrades.deployProxy('BoxV1', [owner, 42n]);

// validate layout compatibility → deploy v2 → re-point → verify slot
const boxV2 = await upgrades.upgradeProxy(box, 'BoxV2');

// unsafe upgrades are rejected BEFORE anything touches the chain
await upgrades.upgradeProxy(box, 'BoxV2Broken'); // throws: storage layout incompatible
```

## How it works

- **Validation** runs off-chain via `@openzeppelin/upgrades-core` over the
  project's compiler build-info (tron-solc output is supported as-is).
- **Deployment** runs through the consumer's TronWeb-bridged `hre.ethers`.
- **Proxy bytecode** comes from the ported contracts library
  (`openzeppelin-tron-solidity`): the consumer project must import the proxy
  contracts so their artifacts are compiled locally, e.g.:

  ```solidity
  import {TransparentUpgradeableProxy} from "openzeppelin-tron-solidity/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
  import {ProxyAdmin} from "openzeppelin-tron-solidity/contracts/proxy/transparent/ProxyAdmin.sol";
  ```

- **Deployment records** are written to `.openzeppelin/<network>.json` so
  `upgradeProxy` knows which contract currently backs a proxy (not yet
  compatible with the upstream manifest schema).

## Current limitations

- Proxy kinds: `transparent` (full support) and `trc1967` (deploy only);
  UUPS and beacon helpers are on the roadmap.
- The manifest is a minimal deployment record, not the upstream format.
- Requires the consumer to compile the ported proxy contracts (see above).

## License

MIT
