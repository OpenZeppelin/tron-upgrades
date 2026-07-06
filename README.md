# TRON Upgrades Plugins

OpenZeppelin Upgrades Plugins for the TRON Virtual Machine (TVM).

> **Status: early scaffold — under active development. Not audited, not published.**

| Package | What it is |
|---|---|
| [`@openzeppelin/hardhat-tron-upgrades`](packages/hardhat-tron-upgrades) | `deployProxy` / `upgradeProxy` / upgrade-safety validation for Hardhat on TRON, on top of [`@openzeppelin/hardhat-tron`](https://github.com/OpenZeppelin/hardhat-tron) |
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

`sandbox/` is a standalone Hardhat fixture project (not a workspace) used as the
local dev loop and E2E rig. It consumes `@openzeppelin/hardhat-tron` via a
vendored tarball (`sandbox/vendor/`) while that package is unpublished.

```bash
cd sandbox
npm install
npx hardhat compile   # first run downloads tron-solc (SHA-256 verified)
npx hardhat test      # first run pulls tronbox/tre:dev and boots a TRON node in Docker
```

Requirements: Node.js ≥ 20, Docker running.

## License

[MIT](LICENSE)
