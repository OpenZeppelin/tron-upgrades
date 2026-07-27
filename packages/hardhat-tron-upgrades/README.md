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

// uups: inferred from the implementation's public upgrade function
// (explicit { kind: 'uups' } is also supported)
const ubox = await upgrades.deployProxy('MyUUPSBox', [owner, 42n]);

// validate layout compatibility (+ upgrade-mechanism presence for uups)
// → deploy v2 → re-point → verify slot
const boxV2 = await upgrades.upgradeProxy(box, 'BoxV2');

// optional post-upgrade call, encoded against BoxV2
await upgrades.upgradeProxy(box, 'BoxV2', {
  call: { fn: 'increment', args: [] },
});

// prepare without re-pointing (for governance or multisig execution)
const prepared = await upgrades.prepareUpgrade(box, 'BoxV3');

// deploy and register an implementation without a proxy
const implementation = await upgrades.deployImplementation('BoxV1');

// implementations are reused by version by default; constructor arguments
// participate in that version key
await upgrades.deployImplementation('BoxWithCtor', {
  constructorArgs: [42n],
  redeployImplementation: 'onchange', // 'always' | 'never'
});

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

// v5 transparent proxies: hand ProxyAdmin ownership to a new account
await upgrades.admin.transferProxyAdminOwnership(box, newOwner);
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
- **Implementation reuse** follows the upstream version key and defaults to
  `redeployImplementation: 'onchange'`. Use `'always'` to force a fresh
  deployment or `'never'` to require a previously deployed version.
- **Expert options** include `unsafeAllow`, `unsafeAllowRenames`,
  `unsafeSkipStorageCheck`, `txOverrides: { value, gasLimit }`, and
  `getTxResponse` on implementation preparation APIs. Unsupported EVM-only
  transaction fields are rejected rather than silently ignored.
- **Unknown implementations are a hard stop.** If the chain reports an
  implementation address the manifest has never seen (e.g. the proxy was
  upgraded by governance, a multisig, or another checkout), the upgrade
  refuses to guess and asks you to register it first with
  `await upgrades.forceImport(proxyAddress, 'CurrentImplementation')`. A lost
  PROXY record alone is recoverable because the implementation is found
  on-chain and the kind is inferred from validation data.

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

One deliberate difference from upstream: validations are not cached at
compile time. Upstream v3.x hooks the compile task to cache validations; this
plugin reads `tron-solc` build-info and validates on demand at each
deploy/upgrade/validate call, because compilation is owned by the bridge. The
plugin does register one compile-task hook (`src/compile.ts`), but only to
pre-warm the namespaced-storage recompile cache — see Namespaced storage
below.

Upstream surfaces that intentionally have no counterpart here: `defender/*`
(no TRON deployment backend), `verify-proxy*` and the Etherscan API helpers
(Tronscan verification is separate future work), the typed `ContractFactory`
overloads (`utils/factories.ts` typed variants, `utils/contract-types.ts`,
`utils/attach-abi.ts` — this API is artifact-name based),
`scripts/migrate-oz-cli-project.ts`, `admin.changeProxyAdmin` (the ported v5
transparent proxy has an immutable admin), and the Hardhat 3-only surfaces
(`hooks/`, `compile-task-action.ts`, `verify-plugin.ts`,
`utils/npmFilesToBuild.ts`).

## Current limitations

- Proxy kinds: `transparent`, `uups`, and `beacon` — all supported
  (`deployProxy`/`upgradeProxy`, `deployBeacon`/`deployBeaconProxy`/`upgradeBeacon`).
- Proxy kind is inferred from the implementation's public upgrade-function
  signatures. An explicit `kind` overrides inference and conflicts are rejected.
- Uninitialized proxies are not supported for `transparent` or `uups`: the
  ported `TRC1967Proxy` (which the transparent proxy inherits) rejects empty
  constructor data, so both `initializer: false` and a contract without a
  default initializer fail with a clear error BEFORE any transaction. Beacon
  proxies DO support uninitialized deploys (upstream parity).
- Manifests from plugin versions before the upstream schema are refused with
  a migration error (they recorded contract names — the drift-prone baseline
  this version removes).
- `admin.changeProxyAdmin` is not applicable: v5 transparent proxies use an
  immutable admin. Transfer that ProxyAdmin's ownership with
  `admin.transferProxyAdminOwnership` instead.
- Requires the consumer to compile the ported proxy contracts (see above).

## Upstream parity

This package follows `@openzeppelin/hardhat-upgrades` semantics where they map
to TVM. Differences are explicit:

| Surface | Status on TRON |
|---|---|
| Transparent, UUPS, and beacon deploy/upgrade | Supported |
| One module per operation (upstream file architecture) | Mirrored — see Architecture |
| `deployImplementation`, `prepareUpgrade`, `forceImport` | Supported |
| `validateUpgrade` — a name pair, or a candidate against a deployed proxy / beacon / implementation reference | Supported |
| Chain-first manifests, implementation reuse, constructor arguments | Supported |
| Kind inference and conflict detection | Supported |
| `unsafeAllow`, `unsafeAllowRenames`, `unsafeSkipStorageCheck` | Supported |
| `useDeployedImplementation` (legacy reuse flag) | Supported; conflicts with `redeployImplementation`, as upstream |
| `initialOwner` ProxyAdmin guard + `unsafeSkipProxyAdminCheck` | Supported |
| `upgradeProxy` `call: { fn, args }` | Supported |
| `deployImplementation` / `prepareUpgrade` `getTxResponse` | Supported |
| `txOverrides.value`, `txOverrides.gasLimit` | Supported and translated by the TRON bridge |
| EVM-only transaction fields (`gasPrice`, `nonce`, EIP-1559 fields) | Rejected as unmappable |
| `admin.transferProxyAdminOwnership` | Supported |
| `admin.changeProxyAdmin` | N/A: the ported v5 transparent proxy has an immutable admin |
| Typed `ContractFactory` overloads and typed contract returns | Different by design: this API is artifact-name based |
| Custom `proxyFactory` / `deployFunction` | N/A: deployment is owned by the TronWeb bridge |
| Defender deployment/approval APIs | N/A: no TRON deployment backend |
| `deployContract` helper | N/A: use the bridge's `hre.ethers.deployContract` |
| Etherscan verification integration | N/A; Tronscan verification is future work |

For Nile demo deployments, rebuild a fresh checkout's local manifest with:

```bash
npx hardhat run scripts/reimport-nile.js --network nile
```

Local TRE manifests are intentionally ephemeral. Before mainnet use, keep
public-network manifests in version control or another durable deployment
repository; losing them intentionally stops future upgrades until re-imported.

## Namespaced storage (ERC-7201 and TRC-7201)

Namespaced storage structs are recognized under both annotation prefixes:

- `@custom:storage-location erc7201:<id>` — the ERC-7201 convention used by
  the OpenZeppelin upstream Solidity libraries.
- `@custom:storage-location trc7201:<id>` — the TIP-7201 convention used by
  the TRON contract libraries.

TIP-7201 derives the storage slot with the identical formula as ERC-7201
(`keccak256(abi.encode(uint256(keccak256(bytes(id))) - 1)) & ~0xff`, hashing
the namespace id without the prefix), so a given namespace id resolves to the
same slot under either annotation. Validation is slot-aware for both: struct
member reorders and repacks are rejected, while trailing appends and members
that fill intra-slot padding are accepted. A codebase that mixes `erc7201:`-
and `trc7201:`-annotated contracts is validated correctly, each namespace on
its own annotation.

**Slot-aware validation needs a second compile.** Every build-info compiled
with solc >= 0.8.20 gets an extra "namespaced" recompile that rewrites
namespace struct members into ordinary storage variables so their slot and
offset can be read back — this runs regardless of whether that build-info
actually declares any `@custom:storage-location` struct. It runs once per
build-info (cached on disk and in memory) right after `hardhat compile`, so
later deploy/upgrade/validate calls don't pay for it inline. On an older
solc, or if the recompile itself fails, validation falls back to AST-only
namespace checks: slot/offset are unknown, so advanced-but-safe layout edits
(e.g. a member inserted into intra-slot padding) may now be rejected when
they would have passed under the full check. Edits that are genuinely unsafe
(reorders, repacks) are still rejected — the fallback never accepts more than
the full check does, only less. A fallback warning is only emitted when the
build-info actually has a `@custom:storage-location` struct to lose precision
on.

Configure what a failed namespaced recompile does with:

```js
// hardhat.config.cjs
module.exports = {
  tronUpgrades: {
    namespacedCompileErrors: 'error', // 'error' | 'warn' | 'ignore' (default: 'error')
  },
};
```

- `'error'` (default) fails `hardhat compile`, matching upstream
  `hardhat-upgrades`. The same failure is enforced again at the first
  `upgrades.*` call that needs it for that build-info, so `--no-compile` runs
  and direct API use fail the same way.
- `'warn'` warns once per build-info and falls back to AST-only checks.
- `'ignore'` falls back silently.

Compatibility note: mixing the two annotation prefixes across contracts in one
codebase is supported by this plugin's validation. That is separate from mixing
the underlying Solidity libraries — do not combine the OpenZeppelin upstream
upgradeable libraries and the TRON contract libraries in the same contract, as
their initializers, namespaces, and inheritance are not designed to interoperate.

**Cross-prefix collisions.** `erc7201:` and `trc7201:` hash the namespace id
without the prefix, so the same id under both prefixes resolves to one
storage slot. The plugin rejects that collision, whether both annotations
are on the same contract or one is inherited from a base contract, even
though upgrades-core — which keys namespaces by the full annotation string —
would otherwise miss it. Distinct ids under different prefixes are
unaffected. Annotations are passed to upgrades-core verbatim (the plugin
never rewrites the prefix), so error messages quote the id exactly as the
developer wrote it.

Caveat: flipping a namespace's prefix across an upgrade (`trc7201:x` to
`erc7201:x`, same id) is safe on-chain, but upgrades-core compares namespaces
by the full annotation string, so it no longer finds `trc7201:x` in the new
version and reports a deleted namespace — a false rejection, in the fail-safe
direction. Use `unsafeSkipStorageCheck` if you need to make that specific
upgrade.

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
