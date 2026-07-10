import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { type ValidationOptions, validateImplementation } from './utils';

export function makeValidateImplementation(hre: HardhatRuntimeEnvironment) {
  return async function (contractName: string, opts: ValidationOptions = {}): Promise<void> {
    await validateImplementation(hre, contractName, opts);
  };
}
