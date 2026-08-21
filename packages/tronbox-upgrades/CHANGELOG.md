# Changelog

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
