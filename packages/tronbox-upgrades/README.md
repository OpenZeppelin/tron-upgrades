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
silently ignored. `timeout` and `pollingInterval` bound one wait and only one —
the upgrades engine's wait for an implementation deploy to be mined — so the
divergence-table row below names both the operations they govern and the ones
where they resolve without changing anything.

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

## Divergences from the Hardhat/Truffle plugins

This plugin follows the same model as OpenZeppelin's Hardhat and Truffle
upgrades plugins, but it is not a drop-in port — TRON's own semantics, v5
proxies, and a stricter safety posture change several behaviors on purpose.
Every divergence below is deliberate; each states what changed, why, and how
to adapt a migration written against the other plugins.

### API shape

| What changed | Why | Migration |
|---|---|---|
| **Handles are a mandatory argument.** Every operation but the validate pair takes the migration's `{ deployer, artifacts, tronWrap, waitForTransactionReceipt }` as its final argument — `validateImplementation`/`validateUpgrade` need only `{ artifacts }` (see the API table above). | Hardhat reads a live Hardhat Runtime Environment implicitly; TronBox's migration sandbox has no equivalent to read from, so there is nothing to make this optional. | Build the handles object once per migration and pass it to every call — see the Quickstart above. |
| **Results are envelopes, not bare contract instances.** Every operation returns an envelope — most carry `{ contract, address, transaction, notes, … }` — rather than the deployed/upgraded contract instance itself; `forceImport`'s result has no `transaction`, and ownership transfer's has neither `contract` nor `address`. | Hardhat/Truffle read `.address` and a transaction-hash accessor off the returned contract. TronBox's own accessors don't guarantee those the same way, and some results (`forceImport`) have no transaction at all — naming the fields is what lets the type say which are guaranteed. | Read `result.address` and `result.transaction.hash` (or `.implementation` where the operation reports one) instead of reading off the contract instance. |
| **`txOverrides` does not exist.** | It has no TRON meaning: gas/gasPrice/nonce belong to a different fee model. Passing it to any operation is refused by name (`UnknownOptionError`), never silently dropped. | Configure `feeLimit`, `userFeePercentage`, etc. in `tronbox-config.js` instead. |
| **No `admin.deployProxyAdmin`; no `admin.changeProxyAdmin`.** | A v5 transparent proxy deploys its own **immutable** `ProxyAdmin` as part of `deployProxy` itself, so there is no separate admin to deploy ahead of time, and no admin contract a proxy can be re-pointed at. | Use `transferProxyAdminOwnership(proxyAddress, newOwner, opts)` to hand off upgrade authority — it transfers the *ownership* of the per-proxy admin, scoped to one proxy, with a pre-read that turns a repeat transfer into a declared no-op rather than an on-chain revert. |
| **`validateUpgrade` is name-vs-name only; `prepareUpgrade` is proxy-address only.** | Neither accepts a deployed beacon or bare implementation address as the reference, the way Hardhat's equivalents do. `validateUpgrade(FromContract, ToContract, opts)` compares two artifact names; `prepareUpgrade(proxyAddress, Contract, opts)` reads its reference layout from a live proxy's own 1967 slot — chain-read, never guessed from a name. | If the reference isn't a proxy you can point at, `forceImport` it first, then reference it by address. |
| **None of the three beacon operations accept `kind`, and none accepts an option OUR OWN CODE never reads for it.** `deployBeacon`, `deployBeaconProxy` and `upgradeBeacon` each pass their own accepted-options list (`beacon/index.ts`: `DEPLOY_BEACON_ACCEPTED_OPTIONS`, `DEPLOY_BEACON_PROXY_ACCEPTED_OPTIONS`, `UPGRADE_BEACON_ACCEPTED_OPTIONS`) rather than one list shared across all three, so an option each one accepts is one it either reads directly or forwards, whole and coherent, to the validation engine — `deployBeaconProxy` deploys only the `BeaconProxy` itself and so accepts neither the implementation-deploy nor the validation options the other two need. (The `unsafeAllowRenames`/`unsafeSkipStorageCheck` pair is accepted by both `deployBeacon` and `upgradeBeacon` — see the row below for why accepting it on `deployBeacon` too is correct, not an oversight.) `kind` is refused entirely (`UnknownOptionError`) on all three, and `DeployBeaconOptions`, `DeployBeaconProxyOptions` and `UpgradeBeaconOptions` all omit the field at the type level too. **Verified by execution**: `test/toolkit-seam.test.ts`'s per-operation `kind`-refusal and inert-option-refusal pins (including the ones driven through each operation's PUBLIC entry, proving the wiring rather than only the constant), plus the type-level `@ts-expect-error` pins in `test/surface-request-response-contract.test.ts` and `test/entry-cheap-additions.test.ts`. | A beacon proxy has exactly one kind, so accepting `kind` and then narrowing a wrong value (the old API's behavior) was a signature that could not fail usefully — and the three operations genuinely need different subsets of the option surface, so one shared list necessarily over-accepted for whichever operation needed the least (`deployBeaconProxy`, by nine members). `DeployBeaconOptions`/`UpgradeBeaconOptions` build on the same `StandaloneOptions`/`UpgradeOptions` composition `DeployProxyOptions`/`PrepareUpgradeOptions` also use — both of which genuinely accept `kind` — so the two beacon-only aliases drop it locally (`Omit<_, 'kind'>`) rather than widening the omission to every type built from that shared base. | Drop `kind` from every beacon-operation call entirely — there is nothing to set. Pass only the options each operation's own signature promises; an option our code neither reads nor forwards for that operation is refused by name rather than silently accepted. |
| **`unsafeAllowRenames` and `unsafeSkipStorageCheck` are accepted by every operation that validates, and take effect only where a storage comparison actually runs.** `deployProxy`, `deployBeacon`, `deployImplementation`, `validateImplementation` and `forceImport` all accept the pair — none of them compares a new implementation's layout against a prior one, so the engine call each of them makes (`getErrors`, never `getStorageUpgradeReport`) never reads either field. `upgradeProxy`, `upgradeBeacon`, `prepareUpgrade` and `validateUpgrade` accept the identical pair and it is genuinely load-bearing there: their storage comparison (`assertStorageCompatible` → the engine's `getStorageUpgradeReport`) reads `unsafeSkipStorageCheck` to skip the comparison entirely and `unsafeAllowRenames` to tolerate a bare variable rename. **Verified by execution, both directions**: `test/toolkit-seam.test.ts`'s `"unsafeAllowRenames/unsafeSkipStorageCheck flip a REAL storage-comparison verdict"` suite drives the installed engine's own `getStorageUpgradeReport` directly with two hand-built layouts, showing a bare rename (and, separately, a genuine type change) is refused without either flag and accepted with it; its `"the same pair is genuinely inert for deployBeacon's own validation path"` suite drives the REAL `validateImplementation` over a compiled corpus contract twice, with and without both flags, and shows byte-identical results either way. | Accepting the coherent, upstream-shaped `ValidationOptions` bag on every validating operation — rather than carving two members out for whichever operations happen not to compare storage today — mirrors upstream exactly (Hardhat's own plugin does not narrow this pair per operation either) and avoids a caller-visible asymmetry with no safety benefit: refusing the pair on a fresh deploy would not make that deploy any safer, since neither flag ever reaches a comparison that does not exist. | Pass the pair only on an operation that actually compares storage if you want it to do anything — but passing it anywhere else is accepted, not an error, exactly like upstream. |
| **`deployBeaconProxy` accepts `timeout`/`pollingInterval` where the parity-shaped type would omit them.** `DeployBeaconProxyOptions` composes `DeployOpts` (from `@openzeppelin/upgrades-core`), which the Hardhat plugin's own equivalent type does not include. | Truffle's transaction-timing fields are inert there regardless, so the parity target's omission is harmless upstream; on TRON, confirmation timing is a real thing an operation could need to control, so this plugin's type does not repeat an omission that would be free upstream but costly here. **What the pair reaches, stated precisely rather than promised in general**: both are handed to the upgrades engine as its own `DeployOpts` on the implementation-deploy path (`proxy/toolkit.ts`'s `fetchOrDeployImplementation`), so they bound the engine's wait for an implementation deploy to be mined on `deployProxy`, `upgradeProxy`, `deployBeacon`, `upgradeBeacon`, `deployImplementation` and `prepareUpgrade`. They reach nothing else: operations that deploy no implementation (`deployBeaconProxy` — this row's own subject — and `transferProxyAdminOwnership`) accept and resolve them without any behavior to change, and no operation's own `confirm` step reads them — that step runs against one fixed bound (`HOST_CONFIRMATION_BOUNDS`, 500ms × 240 retries), a separate, pre-existing gap this row does not paper over. | Pass them to tune how long the engine waits for an implementation deploy; on `deployBeaconProxy` (and on ownership transfer) either option type-checks and resolves but changes nothing, and neither option lengthens or shortens the confirmation wait on any operation. |
| **The positional overloads are gone.** `deployProxy(Contract, opts)` and `deployBeaconProxy(beaconAddress, Contract, opts)` — options passed where the argument list belongs — are refused by name with `OptionsInArgsPositionError`, before anything spends. | The old Hardhat/Truffle-shaped API accepted options in that position when the argument list was omitted. Reinterpreting it silently here would either throw an opaque native error a few calls downstream (spreading a plain object throws) or, worse, quietly misencode the call. | Always pass the argument list — an array, or `[]` — before any options object: `deployProxy(Contract, [42], opts)`, never `deployProxy(Contract, opts)`. |
| **`initializer: false` is unsupported.** Refused with `EmptyInitializerRefusedError`, naming the divergence, before any spend. | The ported `TRC1967Proxy` (which `TransparentUpgradeableProxy` also constructs through) reverts on **empty** initialization data for transparent and UUPS proxies — a deliberate parity break, safer than upstream's `ERC1967Proxy`, which allows an uninitialized proxy to exist. `BeaconProxy` itself does not require non-empty data, but this plugin refuses it there too, uniformly: `deployProxy` and `deployBeaconProxy` both encode their initializer through the same function, and it refuses an empty result for every kind rather than letting a beacon proxy's laxer contract carve out an exception. The same refusal covers an *omitted* initializer against a contract with no default `initialize()`, which upstream would otherwise deploy uninitialized. | Initialize in the same transaction — add an `initializer` your contract answers, for every proxy kind including beacon. |
| **`unsafeAllow`'s closed value set comes from the installed engine, 14 members against the parity target's 9.** | `@openzeppelin/upgrades-core@1.46.0` (this plugin's installed dependency) added five members after the Hardhat plugin's own pinned revision. Mirroring the parity target's set literally would reject five values the installed engine actually accepts. | The option's *shape* still mirrors the parity target; only the closed set of accepted strings is newer. Pass any of the 14 the installed engine defines. |
| **Conflicting `unsafeAllow` combinations are refused, not silently resolved.** Two pairs — `unsafeAllowLinkedLibraries: false` alongside `unsafeAllow: ['external-library-linking']`, and `unsafeAllowCustomTypes: false` alongside `unsafeAllow: ['struct-definition', 'enum-definition']` — each express one allowance through two channels that can disagree. | Hardhat/upstream resolves the disagreement silently, always in favor of the array — so a caller who thinks they revoked an allowance through the boolean keeps it anyway. This plugin refuses outright with `OptionConflictError`, naming both options and which one to drop. | Set the allowance through exactly one channel per pair; the error message names both and states which to remove. |
| **`useDeployedImplementation` and `redeployImplementation` conflict only when the deprecated spelling is truthy — verified against the installed Hardhat sibling, not assumed.** `useDeployedImplementation: true` alongside an explicit `redeployImplementation` is refused with `OptionConflictError`. Read directly off `hardhat-tron-upgrades/dist/utils/deploy-impl.js:12` (`if (opts.useDeployedImplementation && opts.redeployImplementation !== undefined) throw ...`): upstream refuses that exact combination too, with a generic `Error` rather than a named class — that class difference is the one real divergence on this row. `useDeployedImplementation: false` alongside an explicit `redeployImplementation` is refused by **neither** plugin: the explicit `redeployImplementation` wins silently (`resolveRedeployMode` reads and returns it before `useDeployedImplementation` is even consulted), matching upstream's own `opts.redeployImplementation ?? (opts.useDeployedImplementation ? 'never' : 'onchange')` precedence exactly. | It is `useDeployedImplementation`'s *truthiness*, not its mere presence, that upstream's own check tests — a presence-only check refuses a combination upstream permits (measured: this plugin's resolver briefly did exactly that, and was corrected). Kept on its own row rather than folded into the pair above: unlike `unsafeAllowLinkedLibraries`/`unsafeAllowCustomTypes`, where upstream *always* resolves the disagreement silently, this pair's silently-resolved-vs-refused split depends on which value the deprecated option holds — verified in both directions by `test/surface-error-semantics.test.ts`'s “refuses two spellings of the redeploy policy in both orderings” case and “useDeployedImplementation: false alongside redeployImplementation is NOT a contradiction” test. | Keep `redeployImplementation` alone once you have decided on a policy, and drop `useDeployedImplementation` entirely — its value no longer changes anything either way. |

### Behavioral divergences worth reading closely

- **A hex `call` value is raw calldata; a bare function name works only when it is unambiguous, and only ever encodes zero arguments.** `upgradeProxy`'s `call` option, when given as a string starting with `0x`, is sent as calldata verbatim — no ABI encoding, no function lookup at all. A plain (non-hex) string is resolved by name through `ethers`' `Interface.encodeFunctionData`, which looks the name up **without consulting the argument count at all** — verified directly against the installed `ethers`: an ABI with two `reinitialize` overloads throws `ethers`' own raw `INVALID_ARGUMENT` "ambiguous function description" error for *any* bare `reinitialize`, one argument or ten. There is no arity-based overload resolution on this path, and the error a caller sees is `ethers`' own, not one of this plugin's named refusals. **The plain-string form also always encodes zero arguments** — `call: 'reinitialize'` sends `reinitialize()`'s selector with no ABI-encoded parameters, whatever the string says syntactically. To pass arguments, or to disambiguate an overload, use the `{ fn, args }` form with the **full signature** as `fn` (e.g. `{ fn: 'reinitialize(uint8)', args: [1] }`) — a bare `fn` on an overloaded name is refused the identical way even inside this form, since `args` does not help resolve it either. Hardhat's own `call` has the same full-signature requirement for an overloaded function; this plugin does not add arity-based leniency anywhere on this path.
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
