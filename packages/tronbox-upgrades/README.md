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
