import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type DeployBeaconOptions,
  FQN,
  deployContractWithOptions,
  deployerAddress,
  ethersOf,
  getManifest,
  resolveImplementation,
  txOverridesOf,
  validateImplementation,
} from './utils';

export function makeDeployBeacon(hre: HardhatRuntimeEnvironment) {
  return async function deployBeacon(
    contractName: string,
    opts: DeployBeaconOptions = {},
  ): Promise<any> {
    const ethers = ethersOf(hre);
    txOverridesOf(opts);
    const manifest = await getManifest(hre);
    const contract = await validateImplementation(hre, contractName, { ...opts, kind: 'beacon' });
    const implAddress = (
      await resolveImplementation(hre, contractName, opts, contract)
    ).address;

    const owner = opts.initialOwner ?? deployerAddress(hre);
    const beacon = await deployContractWithOptions(hre, FQN.beacon, [implAddress, owner], opts);

    return beacon;
  };
}
