import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type AddressLike,
  FQN,
  type UpgradeBeaconOptions,
  assertStorageCompatible,
  core,
  ethersOf,
  getManifest,
  layoutForAddress,
  providerOf,
  resolveAddress,
  resolveImplementation,
  txOverridesOf,
  validateImplementation,
} from './utils';

export function makeUpgradeBeacon(hre: HardhatRuntimeEnvironment) {
  return async function upgradeBeacon(
    beacon: AddressLike,
    newContractName: string,
    opts: UpgradeBeaconOptions = {},
  ): Promise<any> {
    const ethers = ethersOf(hre);
    const beaconAddress = await resolveAddress(beacon);
    const manifest = await getManifest(hre);

    // Chain first: ask the beacon what it points at now, then look that
    // address up in the manifest for the layout baseline.
    const { getImplementationAddressFromBeacon } = core();
    const currentImplAddress = await getImplementationAddressFromBeacon(
      providerOf(hre),
      beaconAddress,
    );
    const currentLayout = await layoutForAddress(manifest, currentImplAddress);

    const newContract = await validateImplementation(hre, newContractName, {
      ...opts,
      kind: 'beacon',
    });
    assertStorageCompatible(currentLayout, newContract.layout, opts);

    const beaconContract = await ethers.getContractAt(FQN.beacon, beaconAddress);
    const newImplAddress = (
      await resolveImplementation(hre, newContractName, opts, newContract)
    ).address;

    const withOwner = (c: any) => (opts.owner ? c.connect(opts.owner) : c);
    const txOverrides = txOverridesOf(opts);
    await (txOverrides
      ? withOwner(beaconContract).upgradeTo(newImplAddress, txOverrides)
      : withOwner(beaconContract).upgradeTo(newImplAddress));

    // trust, but verify: the beacon must now point at the new implementation
    const current = (await beaconContract.implementation()).toLowerCase();
    if (current !== newImplAddress.toLowerCase()) {
      throw new Error(
        `Beacon upgrade transaction succeeded but the beacon points at ${current}, expected ${newImplAddress}`,
      );
    }

    return beaconContract;
  };
}
