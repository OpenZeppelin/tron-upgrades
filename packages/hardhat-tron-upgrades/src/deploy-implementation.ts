import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type DeployImplementationOptions,
  ethersOf,
  getManifest,
  recordImpl,
  txHashOf,
  validateImplementation,
} from './utils';

export function makeDeployImplementation(hre: HardhatRuntimeEnvironment) {
  return async function deployImplementation(
    contractName: string,
    opts: DeployImplementationOptions = {},
  ): Promise<string> {
    const manifest = await getManifest(hre);
    const contract = await validateImplementation(hre, contractName, opts);
    const impl = await ethersOf(hre).deployContract(contractName);
    const address = await impl.getAddress();
    await recordImpl(manifest, contract, address, txHashOf(impl));
    return address;
  };
}
