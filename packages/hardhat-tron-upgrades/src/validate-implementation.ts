import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { type ValidationOptions, validateImplementation } from './utils';

export function makeValidateImplementation(hre: HardhatRuntimeEnvironment) {
  return function (contractName: string, opts: ValidationOptions = {}): Promise<void> {
    return validateImplementation(hre, contractName, opts);
  };
}
