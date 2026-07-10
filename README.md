# TRON Upgrades Plugins

OpenZeppelin Upgrades Plugins for the TRON Virtual Machine (TVM).

> **Status: early scaffold — under active development. Not audited, not published.**

| Package | What it is |
|---|---|
| [`@openzeppelin/hardhat-tron-upgrades`](packages/hardhat-tron-upgrades) | Transparent, UUPS, and beacon deployment/upgrades, preparation, import, reuse, and upgrade-safety validation for Hardhat on TRON |
| [`@openzeppelin/tronbox-upgrades`](packages/tronbox-upgrades) | Upgrades plugin for [TronBox](https://tronbox.io) |

Both packages reuse [`@openzeppelin/upgrades-core`](https://github.com/OpenZeppelin/openzeppelin-upgrades/tree/master/packages/core)
for upgrade-safety validation (storage-layout compatibility, initializer rules,
unsafe-operation detection) rather than forking it. The TRON-specific work lives
in the deployment layer: TronWeb-backed deploys, `0x41`-prefixed CREATE2 address
prediction (TIP-26), and network manifests keyed by TRON chain-ids.

The Foundry integration lives in its own repository — Foundry libraries are
installed from a repo root via `forge install`, so it cannot be an npm workspace
here.

## Development

Each plugin package is self-contained (TypeScript sources, fixtures, tests)
following the upstream `openzeppelin-upgrades` layout:

```bash
cd packages/hardhat-tron-upgrades
npm install
npm test             # builds, boots a Dockerized TRON node, runs the suite
npm run test:examples  # consumer E2E: installs the packed tarballs like an npm user
```

`packages/hardhat-tron-upgrades/examples/BoxUpgrades` mirrors upstream's
examples: a standalone consumer project (own package.json) that installs the
plugins from packed tarballs (`vendor/` — the pre-publish stand-in for the npm
registry) and hosts the public-testnet scripts.

The unpublished TRON-specific dependencies (the bridge, the contracts library,
this plugin) install from `vendor/` tarballs — everything else comes from the
npm registry. A clean clone needs no sibling checkouts. To refresh the vendored contracts library:
`cd ../tron-contracts && npm pack --ignore-scripts --pack-destination ../tron-upgrades/vendor`
(tarball installs never run the library's husky `prepare` hook).

Requirements: Node.js ≥ 20, Docker running.

Current test coverage includes transparent/UUPS/beacon lifecycles, chain-first
drift recovery, implementation reuse and preparation, kind inference, admin
ownership transfer, expert validation/transaction options, deterministic clone
address prediction, and tron-solc build-info validation.

## License

[MIT](LICENSE)
