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
