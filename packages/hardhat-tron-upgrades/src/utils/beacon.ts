import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { core } from './core';
import { isOptionalCallRevert } from './errors';
import { providerOf } from './ethers';

// Bare implementations revert the optional implementation() probe. TRE's
// uppercase REVERT wording is not recognized by upgrades-core@1.46.0.
export async function isBeaconContract(
  hre: HardhatRuntimeEnvironment,
  address: string,
): Promise<boolean> {
  try {
    return await core().isBeacon(providerOf(hre), address);
  } catch (error) {
    if (!isOptionalCallRevert(error)) throw error;
    return false;
  }
}

// Preflight guard for operations that take a beacon address: reject a target
// that is not an upgradeable beacon with a precise error naming the address and
// the expected interface, before any deploy or record. Mirrors upstream's
// isBeacon rejection in deployBeaconProxy / upgradeBeacon.
export async function assertIsBeacon(
  hre: HardhatRuntimeEnvironment,
  address: string,
): Promise<void> {
  if (!(await isBeaconContract(hre, address))) {
    throw new Error(
      `Contract at ${address} is not an upgradeable beacon: its implementation() getter did ` +
        `not return an address. Deploy a beacon with upgrades.deployBeacon(...) and pass that ` +
        `beacon's address.`,
    );
  }
}
