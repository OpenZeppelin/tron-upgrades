import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type DeployBeaconOptions,
  FQN,
  deployerAddress,
  ethersOf,
  readManifest,
  validateImplementation,
  writeManifest,
} from './utils';

export function makeDeployBeacon(hre: HardhatRuntimeEnvironment) {
  return async function deployBeacon(
    contractName: string,
    opts: DeployBeaconOptions = {},
  ): Promise<any> {
    const ethers = ethersOf(hre);
    await validateImplementation(hre, contractName, { kind: 'beacon' });

    const impl = await ethers.deployContract(contractName);
    const implAddress = await impl.getAddress();

    const owner = opts.initialOwner ?? deployerAddress(hre);
    const beacon = await ethers.deployContract(FQN.beacon, [implAddress, owner]);
    const beaconAddress = await beacon.getAddress();

    const manifest = readManifest(hre);
    manifest.beacons[beaconAddress.toLowerCase()] = {
      contract: contractName,
      implementation: implAddress,
    };
    writeManifest(hre, manifest);

    return beacon;
  };
}
