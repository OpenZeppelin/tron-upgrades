'use strict';

// Hardhat plugin entry: attaches `hre.upgrades` when required from a
// hardhat.config. The API surface mirrors @openzeppelin/hardhat-upgrades
// (deployProxy / upgradeProxy / validateUpgrade), backed by:
//   - @openzeppelin/upgrades-core for upgrade-safety validation
//   - the consumer's TronWeb-bridged `hre.ethers` (@openzeppelin/hardhat-tron)
//     for all chain interaction

const { extendEnvironment } = require('hardhat/config');
const { makeUpgrades } = require('./upgrades');

extendEnvironment((hre) => {
  hre.upgrades = makeUpgrades(hre);
});

module.exports = { makeUpgrades };
