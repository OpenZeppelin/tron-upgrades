// Hardhat plugin entry: attaches `hre.upgrades` when required from a
// hardhat.config. The API surface mirrors @openzeppelin/hardhat-upgrades
// (deployProxy / upgradeProxy / beacons / validation), backed by:
//   - @openzeppelin/upgrades-core for upgrade-safety validation
//   - the consumer's TronWeb-bridged `hre.ethers` (@openzeppelin/hardhat-tron)
//     for all chain interaction

import './type-extensions';
import { extendEnvironment } from 'hardhat/config';
import { makeUpgrades } from './upgrades';

extendEnvironment((hre) => {
  hre.upgrades = makeUpgrades(hre);
});

export { makeUpgrades };
export type { UpgradesAPI, DeployProxyOptions, UpgradeProxyOptions } from './upgrades';
