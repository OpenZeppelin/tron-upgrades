# Changelog

## Unreleased

- `@openzeppelin/tron-contracts` is required at `^5.6.0`, the final release,
  in place of the `^5.6.0-rc.0` range the first release declared. The range
  already resolved to `5.6.0` for new installs; this moves the declared floor
  and the lockfiles off the release candidate. The proxy sources are
  byte-identical between `5.6.0-rc.1` and `5.6.0`, so no deployed bytecode
  changes.

## 0.1.0 (2026-08-22)

First published release.

- Deploy and upgrade transparent, UUPS and beacon proxies from Hardhat
  scripts and tests on TRON, through the `@openzeppelin/hardhat-tron`
  bridge (peer dependency), with the upgrade-safety validations of
  `@openzeppelin/upgrades-core` and a per-network deployment record under
  `.openzeppelin/`.
- Proxy contracts come from the published `@openzeppelin/tron-contracts`
  package through the bundled `contracts/Proxies.sol`; the plugin
  resolves their artifacts by fully-qualified name from that package.
