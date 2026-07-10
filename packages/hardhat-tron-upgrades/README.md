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

// transparent (default kind):
// validate → deploy implementation → deploy proxy (+ admin) → initialize → record
const box = await upgrades.deployProxy('BoxV1', [owner, 42n]);

// uups: same API — the upgrade mechanism lives in the implementation
// (it must inherit UUPSUpgradeable from the ported library)
const ubox = await upgrades.deployProxy('MyUUPSBox', [owner, 42n], { kind: 'uups' });

// validate layout compatibility (+ upgrade-mechanism presence for uups)
// → deploy v2 → re-point → verify slot
const boxV2 = await upgrades.upgradeProxy(box, 'BoxV2');

// beacon: one upgrade moves a whole fleet of proxies atomically
const beacon = await upgrades.deployBeacon('MyBox');
const p1 = await upgrades.deployBeaconProxy(beacon, 'MyBox', [owner, 1n]);
const p2 = await upgrades.deployBeaconProxy(beacon, 'MyBox', [owner, 2n]);
await upgrades.upgradeBeacon(beacon, 'MyBoxV2'); // p1 AND p2 now run V2

// unsafe upgrades are rejected BEFORE anything touches the chain:
await upgrades.upgradeProxy(box, 'BoxV2Broken'); // throws: storage layout incompatible
await upgrades.upgradeProxy(ubox, 'NoButtonBox'); // throws: missing upgradeToAndCall (anti-brick)

// inspection helpers (raw 1967 slots / beacon call)
await upgrades.erc1967.getImplementationAddress(box);
await upgrades.erc1967.getAdminAddress(box);
await upgrades.erc1967.getBeaconAddress(p1);
await upgrades.beacon.getImplementationAddress(beacon);
```

## How it works

- **Validation** runs off-chain via `@openzeppelin/upgrades-core` over the
  project's compiler build-info (tron-solc output is supported as-is).
- **Deployment** runs through the consumer's TronWeb-bridged `hre.ethers`.
- **Proxy bytecode** comes from the ported contracts library
  (`openzeppelin-tron-solidity`). Add ONE import anywhere in your `contracts/`
  so the proxy artifacts are compiled locally:

  ```solidity
  import "@openzeppelin/hardhat-tron-upgrades/contracts/Proxies.sol";
  ```

- **Deployment records** are written to `.openzeppelin/<network>.json` so
  `upgradeProxy` knows which contract currently backs a proxy (not yet
  compatible with the upstream manifest schema).

## Current limitations

- Proxy kinds: `transparent`, `uups`, and `beacon` — all fully supported
  (`deployProxy`/`upgradeProxy`, `deployBeacon`/`deployBeaconProxy`/`upgradeBeacon`).
- `kind` must be explicit for UUPS — upstream-style inference from the
  implementation's bytecode is a planned follow-up.
- `initializer: false` is not supported for `uups` (the ported `TRC1967Proxy`
  rejects empty constructor data); the plugin throws a clear error. Beacon
  proxies DO support it (uninitialized deploy, upstream parity).
- If a proxy has no deployment record (fresh network, lost manifest), pass
  `{ from, kind }` explicitly; conflicting record/`opts.kind` values throw.
- The manifest is a minimal deployment record, not the upstream format.
- **Upgrade validation currently relies on the local manifest.** If a proxy or
  beacon is upgraded outside this plugin (governance, multisig, another
  checkout), do not perform another plugin-driven upgrade until its current
  implementation has been reconciled — validation would otherwise compare
  against a stale baseline. Chain-first validation and `forceImport` are
  planned.
- Requires the consumer to compile the ported proxy contracts (see above).

## Development

```bash
npm install
npm test              # builds TypeScript, boots a Dockerized TRON node, runs the full suite
npm run test:examples # consumer E2E: examples/ install the packed tarballs like an npm user
```

Test fixtures live in `contracts/` (upstream-plugin pattern) and are excluded
from the published package via the `files` whitelist — only `dist/` and
`contracts/Proxies.sol` ship.

## License

MIT
