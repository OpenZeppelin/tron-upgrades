# OpenZeppelin TronBox Upgrades

**TronBox plugin for deploying and upgrading upgradeable smart contracts on
TRON, with the upgrade-safety checks of
[`@openzeppelin/upgrades-core`](https://github.com/OpenZeppelin/openzeppelin-upgrades).**

Deploy transparent, UUPS and beacon proxies from your TronBox migrations,
upgrade them with storage-layout validation, and keep a network file that
records what is deployed where.

## Installation

```console
npm install --save-dev @openzeppelin/tronbox-upgrades
```

The plugin declares `tronbox` (>= 4.0.0), `tronweb` (>= 6.0.0) and `ethers`
(^6.13.0) as peer dependencies.

### One-time setup: make the proxy contracts compilable

The plugin deploys proxy contracts by artifact name, and TronBox only compiles
what your own sources import. Import the plugin's contract file once, from any
`.sol` file in your `contracts/` directory:

```solidity
import "@openzeppelin/tronbox-upgrades/contracts/Proxies.sol";
```

That single import puts `TransparentUpgradeableProxy`, `ProxyAdmin`,
`TRC1967Proxy`, `UpgradeableBeacon` and `BeaconProxy` into your build output.
Without it, deploy operations refuse with a message naming this file as the
remedy.

## Quickstart

An upgradeable `Box`, deployed behind a proxy and then upgraded in place.

`contracts/Box.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Box {
    uint256 private _value;
    bool private _initialized;

    function initialize(uint256 value_) public {
        require(!_initialized, "already initialized");
        _initialized = true;
        _value = value_;
    }

    function value() public view returns (uint256) {
        return _value;
    }
}
```

`contracts/BoxV2.sol` — same storage, one new function:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BoxV2 {
    uint256 private _value;
    bool private _initialized;

    function initialize(uint256 value_) public {
        require(!_initialized, "already initialized");
        _initialized = true;
        _value = value_;
    }

    function value() public view returns (uint256) {
        return _value;
    }

    function increment() public {
        _value += 1;
    }
}
```

`migrations/1_deploy_and_upgrade.js`:

```js
const {
  deployProxy,
  upgradeProxy,
} = require('@openzeppelin/tronbox-upgrades');

const Box = artifacts.require('Box');
const BoxV2 = artifacts.require('BoxV2');

module.exports = async function (deployer) {
  // The migration sandbox's own handles, passed through: artifacts, tronWrap
  // and waitForTransactionReceipt are file-scope globals TronBox provides.
  const handles = { deployer, artifacts, tronWrap, waitForTransactionReceipt };

  const deployed = await deployProxy(Box, [42], handles);
  console.log('deployProxy address:', deployed.address);
  console.log('deployProxy tx:', deployed.transaction.hash);

  const upgraded = await upgradeProxy(deployed.address, BoxV2, handles);
  console.log('upgradeProxy implementation:', upgraded.implementation);
  console.log('upgradeProxy tx:', upgraded.transaction.hash);

  // The upgraded contract instance rides on the result:
  console.log('value:', (await upgraded.contract.value()).toString());
};
```

Two things to notice:

- **The handles object.** TronBox gives every migration file `deployer` as a
  parameter and `artifacts`, `tronWrap` and `waitForTransactionReceipt` as
  file-scope globals. The plugin's operations take them as their last
  argument — build the object once at the top of the migration and pass it to
  every call.
- **`await`, always.** A plugin operation that is not awaited cannot report
  its failure to your migration: TronBox's queue lets the run continue and
  even end green while the failure is visible only in the operation's own
  output. When you *do* await — the only supported usage — a failure rejects
  your `await` with the real error.

`tronbox-config.js`, here against a local
[TronBox Runtime Environment](https://developers.tron.network/reference/what-is-tronbox)
node (the private key below is the TRE quickstart's well-known development
key — never put a real key in this file; use an environment variable):

```js
module.exports = {
  networks: {
    development: {
      privateKey: 'c8afe0306dbb962a4ce8c09954f050c57facf05eb7ac88497ee1489d741aaff1',
      userFeePercentage: 100,
      feeLimit: 1000 * 1e6,
      fullHost: 'http://127.0.0.1:9090',
      network_id: '9'
    }
  },
  compilers: { solc: { version: '0.8.26' } }
};
```

Run it:

```console
tronbox migrate --network development
```

`deployProxy` validates `Box` for upgrade safety, deploys the implementation
and a proxy pointing at it, calls `initialize(42)` through the proxy, waits
for the transaction to confirm **and** checks the receipt's verdict, then
records the deployment. `upgradeProxy` validates `BoxV2` against the storage
layout recorded for the running implementation, deploys the new
implementation, switches the proxy, and verifies on-chain that the switch
actually happened. After the run, `value()` through the proxy answers `42` —
same address, new code.

The deployment record lands in `.openzeppelin/` at your project root, keyed by
the chain's real identity (not the config's `network_id`). Commit it for the
networks you share; it is what upgrade validation reads.

## API

All operations take the migration `handles` object as their final argument
(for the validate pair, `{ artifacts }` alone is enough, so they also work in
`tronbox test` files and CI).

| Operation | What it does |
|---|---|
| `deployProxy(Contract, args?, opts)` | Validate, deploy implementation + proxy (`kind: 'uups'`/`'transparent'` if given; inferred from the implementation — transparent only when no UUPS entry point is found — if omitted), initialize, record. |
| `upgradeProxy(proxyAddress, Contract, opts)` | Validate against the recorded layout, deploy the new implementation, switch the proxy, verify. |
| `deployBeacon(Contract, opts)` | Deploy an upgradeable beacon pointing at the implementation. |
| `deployBeaconProxy(beaconAddress, Contract, args?, opts)` | Deploy a proxy reading its implementation from the beacon. |
| `upgradeBeacon(beaconAddress, Contract, opts)` | Point an existing beacon at a new, validated implementation. |
| `validateImplementation(Contract, opts)` | Upgrade-safety checks only; touches no chain state. |
| `validateUpgrade(FromContract, ToContract, opts)` | Storage-layout compatibility between two contracts; touches no chain state. |
| `deployImplementation(Contract, opts)` | Deploy (or reuse) the implementation alone; the proxy layer is untouched. |
| `prepareUpgrade(proxyAddress, Contract, opts)` | Validate against the proxy's current implementation and deploy the new one — the switch stays a later governance action. |
| `forceImport(proxyAddress, Contract, opts)` | Adopt an existing proxy (or beacon) into the deployment record, verifying on-chain bytecode against the artifact. |
| `transferProxyAdminOwnership(proxyAddress, newOwner, opts)` | Transfer ownership of a transparent proxy's ProxyAdmin, with a pre-read that turns a repeat into a declared no-op. |

The ERC-1967 and beacon readers below return TRON base58 addresses; convert
explicitly (`TronWeb.utils.address.toHex`) if you need the hex form.
Operation results carry their addresses tool-verbatim — whatever form the
host reported — so compare addresses by identity (canonicalize both sides),
never by spelling.

Two more exports round out the public surface, both cheap — no validation, no record, no spend:

| Export | What it does |
|---|---|
| `erc1967.getImplementationAddress/getAdminAddress/getBeaconAddress(address, opts)` | Read one of the three standard ERC-1967 proxy slots directly from chain, as base58. |
| `beacon.getImplementationAddress(beaconAddress, opts)` | Read a beacon's own `implementation()`, as base58. |
| `silenceWarnings()` | Suppress this plugin's advisory writes for the life of the process. Advisories only: a thrown error is never suppressed, and every reduced-fidelity statement still reaches the result's `notes`. |

Options follow the
[OpenZeppelin Upgrades API](https://docs.openzeppelin.com/upgrades-plugins/api-hardhat-upgrades)
where the concepts coincide: `kind`, `initializer`, `constructorArgs`,
`unsafeAllow`, `redeployImplementation`, `timeout`, `pollingInterval`, and the
rest. An option an operation does not accept is refused by name, never
silently ignored — the beacon operations accept no `kind` (a beacon proxy has
exactly one kind), and there is no `txOverrides` (fee behavior is configured
in `tronbox-config.js`). An allowance expressed through two channels that can
disagree (`unsafeAllow` values alongside their boolean twins, or a truthy
`useDeployedImplementation` alongside `redeployImplementation`) is refused
with `OptionConflictError`, naming which one to drop. `timeout` and
`pollingInterval` bound one wait and only one — the upgrades engine's wait
for an implementation deploy to be mined; on operations that deploy no
implementation (`deployBeaconProxy`, ownership transfer) they resolve without
changing anything, and no operation's own confirmation wait reads them.

Always pass the argument list — an array, or `[]` — before any options
object: `deployProxy(Contract, [42], opts)`, never `deployProxy(Contract,
opts)`; the latter is refused by name before anything spends
(`OptionsInArgsPositionError`). `initializer: false` is likewise refused
(`EmptyInitializerRefusedError`): the ported proxy contracts revert on empty
initialization data, so every proxy kind — beacon included — initializes in
the deploy transaction; give the contract an initializer it answers.

**`upgradeProxy`'s `call` option encodes exactly what you spell out.** A
string starting with `0x` is sent as raw calldata, verbatim. A bare function
name (`call: 'reinitialize'`) encodes that function with **zero arguments**,
and an overloaded name is refused by `ethers` as ambiguous whatever the
arity. To pass arguments, or to disambiguate an overload, use the full
signature in the object form: `call: { fn: 'reinitialize(uint8)', args: [1]
}`. And `upgradeProxy` always dispatches the upgrade transaction — even when
the proxy already runs the target implementation — so a `call` executes on
every invocation: re-running a migration whose `call` targets a one-time
reinitializer reverts on-chain (`TransactionRevertedError`), not as a quiet
skip.

**The types say exactly what each operation accepts.** An operation's options
parameter is its own exported alias intersected with `MigrationHandles` (the
five migration handles), so `deployProxy`'s final argument is
`DeployProxyOptions & MigrationHandles`, and a key that operation does not
accept is a **compile error at the call site** — where it previously
type-checked and only failed at runtime, because the parameter was an open bag
with a string index signature.

That compile error is TypeScript's excess-property check, so it applies to an
object literal written at the call, which is how a migration normally passes
options. Hoist the options into a variable first and the extra key becomes
structurally invisible to the compiler:

```js
const opts = { ...handles, totallyMadeUpKey: 1 };
await deployProxy(Box, [42], opts);   // compiles; refused at runtime
```

Write `satisfies DeployProxyOptions & MigrationHandles` on that variable to get
the check back. Either way the runtime refusal (`UnknownOptionError`) stands —
it is what covers JavaScript callers and anything that reaches an operation
untyped. Each alias's members are checked against its operation's own
accepted-options list in both directions, and each signature against its own
alias including member types (`test/public-option-surface.test.ts`), so a key
added to one side and not the other is a build failure rather than a published
lie.

**The refusals you can cause — and fix — are exported classes**, so a `catch`
can branch on `instanceof` instead of matching a message: each operation
family's own refusals (a bad option value, a missing owner, an unsupported
kind, and their siblings), the option family (`UpgradesOptionError` plus
`UnknownOptionError`, `OptionValueError`, `OptionConflictError`), the
environment family's base (`TronBoxEnvironmentError`),
`ValidationInputRefusedError`, and the pair a caller distinguishes to recover
a deployment record — "this is a different chain" versus "the record's
fingerprint file is unusable" (`ChainInstanceChangedError`,
`RecordFingerprintUnreadableError`).

Everything else that can reach you — a node outage, a malformed reply, an
environment missing one handle, an error raised while a result is built —
carries a stable **`code`** string, and branching on `code` is the documented
path for those. The class surface is deliberately small: an exported class can
never be renamed once published, while adding one later is safe — and for a
migration tool, most errors reach a human reading `tronbox migrate` output,
where the message is the surface that matters. `ResultCapabilityUnavailableError`
(raised from a returned result's own accessor, on a member this plugin cannot
support) stays unexported under the same rule and carries its `code`.

**`constructorArgs` cannot end in a plain object or `null`.** TronBox's own
contract layer treats a trailing non-array object — and `null`, since
`typeof null` is also `"object"` — as its own energy-parameter slot, never as
part of your constructor call: it pops that argument off the list entirely
and mines it for the deploy parameters it recognizes (fee limit, origin
energy limit, and the like), so your constructor never receives it — usually
as a loud arity mismatch, but silently exactly when the real constructor also
expects that many arguments once the struct is gone. A trailing `null` fares
no better: depending on the installed TronBox version it either crashes
before any deploy is attempted, or reaches the ABI encoder, which typically
refuses it too. Every operation that deploys a contract with your
`constructorArgs` (`deployProxy`, `upgradeProxy`, `deployBeacon`,
`upgradeBeacon`, `deployImplementation`, `prepareUpgrade`) refuses either
shape by name before attempting any deploy. If your constructor's last
parameter is genuinely a struct, wrap it so it is not the final argument —
pass it as an array member, or add a trailing dummy argument — or restructure
the constructor. `deployBeacon` also refuses up front if it cannot derive an
owner for the beacon (no `initialOwner` given and no sending account
configured) — pass `initialOwner` or configure a `from` address. `deployProxy`
refuses the same state for a transparent proxy's admin.

## Proxy provenance

Every proxy contract this plugin deploys — `TransparentUpgradeableProxy`, `ProxyAdmin`, `TRC1967Proxy` (the UUPS proxy), `UpgradeableBeacon` and `BeaconProxy` — comes from **one package, `openzeppelin-tron-solidity`**, and reaches your build through **one file**, bundled with this plugin:

```solidity
import "@openzeppelin/tronbox-upgrades/contracts/Proxies.sol";
```

> ⚠️ `openzeppelin-tron-solidity` is not yet published; the version range this
> plugin will declare against it is TBD. The import path and the set of
> contracts it brings in are stable now — only the version constraint is
> pending.

TronBox resolves compiled artifacts by **bare contract name**, with no
directory or package qualification. That means a proxy artifact this plugin
needs is exactly as available as any other contract in your build — and
exactly as exposed to a name collision: if your own project (or another
dependency) also compiles a contract named, say, `ProxyAdmin`, TronBox's index
cannot tell them apart. Deployment does not guess:

- **Missing artifact** (the import above was never added): refused by name
  (`ProxyArtifactMissingError`), naming the one-file remedy.
- **Name collision** (more than one compiled contract answers to the bare
  name): refused by name (`ProxyArtifactCollisionError`), listing every
  colliding source path. Nothing is picked by file-order chance.

Rename or remove the colliding contract, or keep the proxy contracts scoped to
the single import file above and nowhere else in your sources.

## Validation without storage layouts

Upgrade-safety validation reads the build record TronBox already wrote —
the `<hash>.output.json` / `<hash>.json` pair under your build-info directory
— after verifying by content that it describes the compiled artifact. The
plugin never runs a compiler of its own; this is the same model Foundry's
upgrades plugin uses.

TronBox does not ask solc for storage layouts, so the record carries none and
the layout is reconstructed from the record's own AST. That comparison works
by **name, type and declaration order**, without slot positions, and it is
stricter than it may sound:

- **Still detected and refused:** renaming a variable, changing its type,
  reordering variables, and deleting one.
- **Still accepted:** appending new variables at the end, which is the safe
  upgrade shape — appends are structurally exempt from position questions.
- **Cannot be decided, so refused conservatively:** the two shapes that need
  slot arithmetic — shrinking a `__gap` array to absorb a new variable, and
  repacking variables inside a slot's existing padding. Both are *safe when
  done correctly*, but without positions the check cannot verify the
  arithmetic, and by default — absent an explicit unsafe override such as
  `unsafeSkipStorageCheck: true` — this plugin never accepts what it cannot
  verify. If you use either pattern, expect a refusal and restructure the
  change as an append.

When the build record for a contract is **absent** (never compiled here, or a
cleaned build directory) or **stale** (it no longer matches the compiled
artifact), validation refuses and names the remedy:

```console
tronbox compile --all
```

The `--all` flag forces recompilation of unchanged sources, so the remedy
works for any compilable concrete contract — though not for an abstract
contract or interface, since recompilation cannot manufacture deployed
bytecode where none can exist. For anything deployable, a fresh build record
and artifact are written together even when TronBox considers the project up
to date.

When TronBox can emit `storageLayout` into its build records, the same
record read will carry real slot positions and the two undecidable shapes
above become decidable in principle — but this plugin does not pick that up
for free. Its own invariant guard (`ValidationInputInvariantError`) refuses
loudly the day a build record reports anything but the declaration-order-only
fidelity it assumes today, so the benefit lands only once this plugin itself
is updated to read the new fidelity, not merely once TronBox emits it.

## Known limitation: custom storage layouts

Solidity 0.8.29's `layout at` custom storage location is not seen by the
storage-safety validation: the layout comparison upstream drops the base slot,
so a changed `layout at` value would pass validation while relocating every
variable in the contract
([OpenZeppelin/openzeppelin-upgrades#1296](https://github.com/OpenZeppelin/openzeppelin-upgrades/issues/1296)).
In practice TronBox's compiler ceiling (solc 0.8.26 for TVM) predates the
syntax, so affected contracts cannot currently be compiled for TRON at all —
but if you validate artifacts compiled elsewhere, do not rely on the check
catching a `layout at` change.

## License

MIT
