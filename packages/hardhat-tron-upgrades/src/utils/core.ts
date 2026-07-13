// Lazy-require keeps `hardhat compile`-time loads cheap: upgrades-core is
// only paid for when an upgrades API is actually invoked.
export function core(): any {
  return require('@openzeppelin/upgrades-core');
}
