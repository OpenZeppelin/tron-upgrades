# OpenZeppelin TronBox Upgrades

**TronBox plugin for deploying and upgrading upgradeable smart contracts on
TRON, with the upgrade-safety checks of
[`@openzeppelin/upgrades-core`](https://github.com/OpenZeppelin/openzeppelin-upgrades).**

Deploy transparent, UUPS and beacon proxies from your TronBox migrations,
upgrade them with storage-layout validation, and keep a network file that
records what is deployed where — the same model as OpenZeppelin's Hardhat and
Truffle upgrades plugins, adapted to TRON and TronBox.

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
| `deployProxy(Contract, args?, opts)` | Validate, deploy implementation + proxy (transparent by default, `kind: 'uups'` for UUPS), initialize, record. |
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

Two more exports round out the public surface, both cheap — no validation, no record, no spend:

| Export | What it does |
|---|---|
| `erc1967.getImplementationAddress/getAdminAddress/getBeaconAddress(address, opts)` | Read one of the three standard ERC-1967 proxy slots directly from chain, as base58. |
| `beacon.getImplementationAddress(beaconAddress, opts)` | Read a beacon's own `implementation()`, as base58. |
| `silenceWarnings()` | Suppress this plugin's advisory writes for the life of the process — see the divergence below for how this differs from upstream's own control. |

Options follow the
[OpenZeppelin Upgrades API](https://docs.openzeppelin.com/upgrades-plugins/api-hardhat-upgrades)
where the concepts coincide: `kind`, `initializer`, `constructorArgs`,
`unsafeAllow`, `redeployImplementation`, `timeout`, `pollingInterval`, and the
rest. An option an operation does not accept is refused by name, never
silently ignored.

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
configured) — pass `initialOwner` or configure a `from` address.

Longer-form documentation ships in the repository's `docs/` directory:
proxy operations and their refusals, deployment and transaction semantics
(including the `await` rule above), adopting existing deployments, and what
the validations do and do not cover.

## Divergences from the Hardhat/Truffle plugins

This plugin follows the same model as OpenZeppelin's Hardhat and Truffle
upgrades plugins, but it is not a drop-in port — TRON's own semantics, v5
proxies, and a stricter safety posture change several behaviors on purpose.
Every divergence below is deliberate; each states what changed, why, and how
to adapt a migration written against the other plugins.

### API shape

| What changed | Why | Migration |
|---|---|---|
| **Handles are a mandatory argument.** Every operation takes the migration's `{ deployer, artifacts, tronWrap, waitForTransactionReceipt }` as its final argument. | Hardhat reads a live Hardhat Runtime Environment implicitly; TronBox's migration sandbox has no equivalent to read from, so there is nothing to make this optional. | Build the handles object once per migration and pass it to every call — see the Quickstart above. |
| **Results are envelopes, not bare contract instances.** Every operation returns `{ contract, address, transaction, notes, … }` rather than the deployed/upgraded contract instance itself. | Hardhat/Truffle read `.address` and a transaction-hash accessor off the returned contract. TronBox's own accessors don't guarantee those the same way, and some results (`forceImport`) have no transaction at all — naming the fields is what lets the type say which are guaranteed. | Read `result.address` and `result.transaction.hash` (or `.implementation` where the operation reports one) instead of reading off the contract instance. |
| **`txOverrides` does not exist.** | It has no TRON meaning: gas/gasPrice/nonce belong to a different fee model. Passing it to any operation is refused by name (`UnknownOptionError`), never silently dropped. | Configure `feeLimit`, `userFeePercentage`, etc. in `tronbox-config.js` instead. |
| **No `admin.deployProxyAdmin`; no `admin.changeProxyAdmin`.** | A v5 transparent proxy deploys its own **immutable** `ProxyAdmin` as part of `deployProxy` itself, so there is no separate admin to deploy ahead of time, and no admin contract a proxy can be re-pointed at. | Use `transferProxyAdminOwnership(proxyAddress, newOwner, opts)` to hand off upgrade authority — it transfers the *ownership* of the per-proxy admin, scoped to one proxy, with a pre-read that turns a repeat transfer into a declared no-op rather than an on-chain revert. |
| **`validateUpgrade` is name-vs-name only; `prepareUpgrade` is proxy-address only.** | Neither accepts a deployed beacon or bare implementation address as the reference, the way Hardhat's equivalents do. `validateUpgrade(FromContract, ToContract, opts)` compares two artifact names; `prepareUpgrade(proxyAddress, Contract, opts)` reads its reference layout from a live proxy's own 1967 slot — chain-read, never guessed from a name. | If the reference isn't a proxy you can point at, `forceImport` it first, then reference it by address. |
| **`deployBeaconProxy` no longer accepts `kind`.** A beacon proxy has exactly one kind, so the option is refused entirely (`UnknownOptionError`), and the `DeployBeaconProxyOptions` type does not declare the field. | The old API accepted `kind` and refused only a *wrong* value; a beacon proxy's kind was never actually a choice, so accepting-then-narrowing was a signature that could not fail usefully. | Drop `kind` from `deployBeaconProxy` calls entirely — there is nothing to set. |
| **The positional overloads are gone.** `deployProxy(Contract, opts)` and `deployBeaconProxy(beaconAddress, Contract, opts)` — options passed where the argument list belongs — are refused by name with `OptionsInArgsPositionError`, before anything spends. | The old Hardhat/Truffle-shaped API accepted options in that position when the argument list was omitted. Reinterpreting it silently here would either throw an opaque native error a few calls downstream (spreading a plain object throws) or, worse, quietly misencode the call. | Always pass the argument list — an array, or `[]` — before any options object: `deployProxy(Contract, [42], opts)`, never `deployProxy(Contract, opts)`. |
| **`initializer: false` is unsupported.** Refused with `EmptyInitializerRefusedError`, naming the divergence, before any spend. | The ported `TRC1967Proxy` (which `TransparentUpgradeableProxy` also constructs through) reverts on **empty** initialization data for transparent and UUPS proxies — a deliberate parity break, safer than upstream's `ERC1967Proxy`, which allows an uninitialized proxy to exist. `BeaconProxy` itself does not require non-empty data, but this plugin refuses it there too, uniformly: `deployProxy` and `deployBeaconProxy` both encode their initializer through the same function, and it refuses an empty result for every kind rather than letting a beacon proxy's laxer contract carve out an exception. The same refusal covers an *omitted* initializer against a contract with no default `initialize()`, which upstream would otherwise deploy uninitialized. | Initialize in the same transaction — add an `initializer` your contract answers, for every proxy kind including beacon. |
| **`unsafeAllow`'s closed value set comes from the installed engine, 14 members against the parity target's 9.** | `@openzeppelin/upgrades-core@1.46.0` (this plugin's installed dependency) added five members after the Hardhat plugin's own pinned revision. Mirroring the parity target's set literally would reject five values the installed engine actually accepts. | The option's *shape* still mirrors the parity target; only the closed set of accepted strings is newer. Pass any of the 14 the installed engine defines. |
| **Conflicting `unsafeAllow` combinations are refused, not silently resolved.** Three pairs — `unsafeAllowLinkedLibraries: false` alongside `unsafeAllow: ['external-library-linking']`; `unsafeAllowCustomTypes: false` alongside `unsafeAllow: ['struct-definition', 'enum-definition']`; and `useDeployedImplementation` alongside `redeployImplementation` — each express one allowance through two channels that can disagree. | Hardhat/upstream resolves the disagreement silently, always in favor of one channel (the array, or the newer option) — so a caller who thinks they revoked an allowance through one channel keeps it anyway. This plugin refuses outright with `OptionConflictError`, naming both options and which one to drop. | Set the allowance through exactly one channel per pair; the error message names both and states which to remove. |

### Behavioral divergences worth reading closely

- **A hex `call` value is raw calldata; an overloaded function name is resolved by argument count, not by exact signature.** `upgradeProxy`'s `call` option, when given as a string starting with `0x`, is sent as calldata verbatim — no ABI encoding, no function lookup at all. A plain function name goes through `ethers`' own `Interface.getFunction`, which — for a name with more than one overload — resolves to whichever overload matches the argument count, and throws if more than one shares it. Hardhat's own `call` requires the exact signature string (e.g. `reinitialize(uint8)`) for an overloaded function; this plugin's arity-based resolution is looser for a non-overloaded name and stricter (a refusal, not a silent pick) when two overloads share an argument count. Pass the full signature if your target has ambiguous overloads.
- **`upgradeProxy` always dispatches — Hardhat parity, and it includes the `call`.** The upgrade transaction is sent even when the proxy already runs the target implementation, matching Hardhat's own behavior. The consequence worth naming explicitly: a supplied `call` executes on **every** invocation, not only the first. Re-running a migration whose `call` targets a reinitializer that already ran will **revert on-chain** — the reinitializer's own one-time guard rejects the repeat, and the failure surfaces as `TransactionRevertedError`, not as a quiet skip. This is the same "always dispatch" contract that lets a `call`-less `upgradeProxy` be re-run safely when nothing changed; a `call` that targets a reinitializer is the one shape where re-running is not free.
- **The public 1967 readers return TRON base58, never EVM hex.** `erc1967.getImplementationAddress` / `getAdminAddress` / `getBeaconAddress` and `beacon.getImplementationAddress` mirror Hardhat's own namespaces in name and in shape — but every address they answer with is base58, matching every other address this plugin's operations return, never the checksummed-hex form Hardhat's equivalents use. Convert explicitly (`tronweb`'s own `TronWeb.utils.address.toHex`) if your migration needs the hex form.
- **`silenceWarnings()` is this plugin's own control, not a call-through to upstream's.** It mirrors upstream's exported function in name and in scope, but is backed by a local, resettable flag rather than by calling upstream's — upstream's own flag is a private module-level binding with no reset, its farewell notice bypasses TronBox's `--quiet` (it writes straight to `console.error`), and with engine-warning capture already in place upstream never writes to the terminal in the first place. Silencing here gates the plugin's own advisory emission only: it never suppresses a thrown error and never suppresses a `notes` entry on the result — every reduced-fidelity statement still reaches the caller who reads the return value, silenced or not.

### Proxy provenance

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
  arithmetic, and this plugin never accepts what it cannot verify. If you use
  either pattern, expect a refusal and restructure the change as an append.

When the build record for a contract is **absent** (never compiled here, or a
cleaned build directory) or **stale** (it no longer matches the compiled
artifact), validation refuses and names the remedy:

```console
tronbox compile --all
```

The `--all` flag forces recompilation of unchanged sources, so the remedy
always works — a fresh build record and artifact are written together even
when TronBox considers the project up to date.

When TronBox can emit `storageLayout` into its build records, the same
record read will carry real slot positions and the two undecidable shapes
above become decidable — no change to your project is needed to benefit.

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
