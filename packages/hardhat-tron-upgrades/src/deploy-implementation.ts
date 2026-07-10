import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { type DeployImplementationOptions, resolveImplementation } from './utils';

export function makeDeployImplementation(hre: HardhatRuntimeEnvironment) {
  return async function deployImplementation(
    contractName: string,
    opts: DeployImplementationOptions = {},
  ): Promise<string> {
    return (await resolveImplementation(hre, contractName, opts)).address;
  };
}
