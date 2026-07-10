import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { type DeployImplementationOptions, resolveImplementation } from './utils';

export function makeDeployImplementation(hre: HardhatRuntimeEnvironment) {
  return async function deployImplementation(
    contractName: string,
    opts: DeployImplementationOptions = {},
  ): Promise<any> {
    const deployment = await resolveImplementation(hre, contractName, opts);
    return opts.getTxResponse && deployment.txResponse ? deployment.txResponse : deployment.address;
  };
}
