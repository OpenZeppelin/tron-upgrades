# Changelog

## 0.1.1 (2026-09-11)

- Require `@openzeppelin/tron-contracts` `^5.6.0` instead of the
  release-candidate range.

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
