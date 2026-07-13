import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type AddressLike,
  FQN,
  type UpgradeBeaconOptions,
  ethersOf,
  readManifest,
  resolveAddress,
  validateUpgrade,
  writeManifest,
} from './utils';

export function makeUpgradeBeacon(hre: HardhatRuntimeEnvironment) {
  return async function upgradeBeacon(
    beacon: AddressLike,
    newContractName: string,
    opts: UpgradeBeaconOptions = {},
  ): Promise<any> {
    const ethers = ethersOf(hre);
    const beaconAddress = await resolveAddress(beacon);

    const manifest = readManifest(hre);
    const record = manifest.beacons[beaconAddress.toLowerCase()];
    const fromContractName = opts.from ?? record?.contract;
    if (!fromContractName) {
      throw new Error(
        `No deployment record for beacon ${beaconAddress} on network "${hre.network.name}" — pass opts.from with the current implementation's contract name.`,
      );
    }

    await validateUpgrade(hre, fromContractName, newContractName, { kind: 'beacon' });

    const beaconContract = await ethers.getContractAt(FQN.beacon, beaconAddress);
    const newImpl = await ethers.deployContract(newContractName);
    const newImplAddress = await newImpl.getAddress();

    const withOwner = (c: any) => (opts.owner ? c.connect(opts.owner) : c);
    await withOwner(beaconContract).upgradeTo(newImplAddress);

    // trust, but verify: the beacon must now point at the new implementation
    const current = (await beaconContract.implementation()).toLowerCase();
    if (current !== newImplAddress.toLowerCase()) {
      throw new Error(
        `Beacon upgrade transaction succeeded but the beacon points at ${current}, expected ${newImplAddress}`,
      );
    }

    manifest.beacons[beaconAddress.toLowerCase()] = {
      contract: newContractName,
      implementation: newImplAddress,
    };
    writeManifest(hre, manifest);

    return beaconContract;
  };
}
