# Changelog

## Unreleased

- `@openzeppelin/tron-contracts` is required at `^5.6.0`, the final release,
  in place of the `^5.6.0-rc.1` range the first release declared. The range
  already resolved to `5.6.0` for new installs; this moves the declared floor
  and the lockfile off the release candidate. The proxy sources are
  byte-identical between `5.6.0-rc.1` and `5.6.0`, so no deployed bytecode
  changes.

## 0.1.0 (2026-08-21)

First published release.

- Deploy and upgrade transparent, UUPS and beacon proxies from TronBox
  migrations, with the upgrade-safety validations of
  `@openzeppelin/upgrades-core` and a per-network deployment record under
  `.openzeppelin/`.
- Proxy contracts come from the published
  `@openzeppelin/tron-contracts` package through the bundled
  `contracts/Proxies.sol`.
- Operations started from one migration body run one at a time per
  deployer, in call order; an un-awaited failure is an unhandled rejection
  that fails the migrate run.
- A chain wipe re-arms the chain-instance guard once the deployment record
  holds no entries, and says so in the migrate output.
