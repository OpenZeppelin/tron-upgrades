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
await upgrades.upgradeProxy(ubox, 'NoButtonBox'); // throws: missing upgrade mechanism (anti-brick)

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

- **Chain-first validation.** Before any upgrade, the plugin reads the
  implementation CURRENTLY installed on-chain (the ERC-1967 slot for
  transparent/uups proxies, `implementation()` for beacons) and validates the
  new contract against the storage layout stored **for that exact address** in
  the manifest — never against a locally recorded contract name, which could
  drift the moment the proxy is upgraded outside this plugin.
- **The manifest** uses the upstream `.openzeppelin` schema
  (`unknown-<chainId>.json`): implementations keyed by version hash with their
  storage layouts (repeated deploys of the same version merge into
  `allAddresses`), proxies with their kind. It is a safety artifact, not just
  bookkeeping — keep it for real networks.
- **Unknown implementations are a hard stop.** If the chain reports an
  implementation address the manifest has never seen (e.g. the proxy was
  upgraded by governance, a multisig, or another checkout), the upgrade
  refuses to guess and asks you to register it first with
  `await upgrades.forceImport(proxyAddress, 'CurrentImplementation')`. A lost
  PROXY record alone is recoverable: pass `{ kind }` and the implementation is
  found on-chain.

## Architecture

The source mirrors upstream `@openzeppelin/hardhat-upgrades` v3.x (the
Hardhat 2 line): one module per operation (`deploy-proxy.ts`,
`upgrade-proxy.ts`, `deploy-beacon.ts`, `deploy-beacon-proxy.ts`,
`upgrade-beacon.ts`, `validate-implementation.ts`, `validate-upgrade.ts`),
each exporting a `make*` factory, composed onto `hre.upgrades` in `index.ts`
— the same place upstream v3.x composes. Shared internals live in `utils/`;
two of them are TRON-specific by design: `utils/manifest.ts` (deployment
records) and `utils/slots.ts` (ERC-1967 slot reads through the TronWeb
bridge). Import direction is enforced by `npm run check:architecture`:
operations import utils, never each other.

One deliberate difference from upstream: no compile-task hooks. Upstream
v3.x caches validations at compile time (and recompiles modified contracts
for namespaced-storage checks); this plugin reads `tron-solc` build-info and
validates on demand, because compilation is owned by the bridge.

## Current limitations

- Proxy kinds: `transparent`, `uups`, and `beacon` — all supported
  (`deployProxy`/`upgradeProxy`, `deployBeacon`/`deployBeaconProxy`/`upgradeBeacon`).
- `kind` must be explicit for UUPS — upstream-style inference from the
  implementation's validation data is a planned follow-up.
- `initializer: false` is not supported for `uups` (the ported `TRC1967Proxy`
  rejects empty constructor data); the plugin throws a clear error. Beacon
  proxies DO support it (uninitialized deploy, upstream parity).
- Manifests from plugin versions before the upstream schema are refused with
  a migration error (they recorded contract names — the drift-prone baseline
  this version removes).
- Requires the consumer to compile the ported proxy contracts (see above).

## Development

```bash
npm install
npm test              # builds TypeScript, boots a Dockerized TRON node, runs the full suite
npm run test:examples # consumer E2E: examples/ install the packed tarballs like an npm user
```

Package tests use the `TestBox*` fixtures in `contracts/`. The standalone
consumer example owns separate `Box*` contracts under `examples/BoxUpgrades`,
matching upstream's separation between package fixtures and example contracts.
Package fixtures are excluded from the published package via the `files`
whitelist; only `dist/` and `contracts/Proxies.sol` ship.

## License

MIT
