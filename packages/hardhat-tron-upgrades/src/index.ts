// Hardhat plugin entry: attaches `hre.upgrades` when required from a
// hardhat.config. The API surface mirrors @openzeppelin/hardhat-upgrades
// (deployProxy / upgradeProxy / beacons / validation), backed by:
//   - @openzeppelin/upgrades-core for upgrade-safety validation
//   - the consumer's TronWeb-bridged `hre.ethers` (@openzeppelin/hardhat-tron)
//     for all chain interaction
//
// One module per operation, mirroring upstream plugin-hardhat v3.x — the
// composition below lives here for the same reason upstream's does.

import './type-extensions';
import { extendEnvironment } from 'hardhat/config';
import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { makeDeployBeacon } from './deploy-beacon';
import { makeDeployBeaconProxy } from './deploy-beacon-proxy';
import { makeDeployProxy } from './deploy-proxy';
import { makeForceImport } from './force-import';
import type { UpgradesAPI } from './types';
import { makeUpgradeBeacon } from './upgrade-beacon';
import { makeUpgradeProxy } from './upgrade-proxy';
import {
  ADMIN_SLOT,
  type AddressLike,
  BEACON_SLOT,
  FQN,
  IMPL_SLOT,
  ethersOf,
  getSlot,
  resolveAddress,
  slotToAddress,
} from './utils';
import { makeValidateImplementation } from './validate-implementation';
import { makeValidateUpgrade } from './validate-upgrade';

export function makeUpgrades(hre: HardhatRuntimeEnvironment): UpgradesAPI {
  const slotAddress = async (target: AddressLike, slot: string) =>
    ethersOf(hre).getAddress(slotToAddress(await getSlot(hre, await resolveAddress(target), slot)));
  return {
    deployProxy: makeDeployProxy(hre),
    upgradeProxy: makeUpgradeProxy(hre),
    deployBeacon: makeDeployBeacon(hre),
    deployBeaconProxy: makeDeployBeaconProxy(hre),
    upgradeBeacon: makeUpgradeBeacon(hre),
    forceImport: makeForceImport(hre),
    validateImplementation: makeValidateImplementation(hre),
    validateUpgrade: makeValidateUpgrade(hre),
    erc1967: {
      getImplementationAddress: (proxy) => slotAddress(proxy, IMPL_SLOT),
      getAdminAddress: (proxy) => slotAddress(proxy, ADMIN_SLOT),
      getBeaconAddress: (proxy) => slotAddress(proxy, BEACON_SLOT),
    },
    beacon: {
      getImplementationAddress: async (beacon) => {
        const b = await ethersOf(hre).getContractAt(FQN.beacon, await resolveAddress(beacon));
        return b.implementation();
      },
    },
    trc1967: { IMPL_SLOT, ADMIN_SLOT, BEACON_SLOT },
  };
}

extendEnvironment((hre) => {
  hre.upgrades = makeUpgrades(hre);
});

export type { UpgradesAPI } from './types';
export type { DeployProxyOptions, UpgradeProxyOptions } from './utils/options';
