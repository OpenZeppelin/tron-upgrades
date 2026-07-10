import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type DeployBeaconOptions,
  FQN,
  deployerAddress,
  ethersOf,
  getManifest,
  recordImpl,
  txHashOf,
  validateImplementation,
} from './utils';

export function makeDeployBeacon(hre: HardhatRuntimeEnvironment) {
  return async function deployBeacon(
    contractName: string,
    opts: DeployBeaconOptions = {},
  ): Promise<any> {
    const ethers = ethersOf(hre);
    const manifest = await getManifest(hre);
    const contract = await validateImplementation(hre, contractName, { kind: 'beacon' });

    const impl = await ethers.deployContract(contractName);
    const implAddress = await impl.getAddress();

    const owner = opts.initialOwner ?? deployerAddress(hre);
    const beacon = await ethers.deployContract(FQN.beacon, [implAddress, owner]);

    // Only the implementation is recorded (with its layout) — beacons need no
    // manifest section: upgradeBeacon reads beacon.implementation() from the
    // chain and finds the layout here by address.
    await recordImpl(manifest, contract, implAddress, txHashOf(impl));

    return beacon;
  };
}
