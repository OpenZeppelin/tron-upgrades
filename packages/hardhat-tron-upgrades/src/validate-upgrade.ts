import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { type ValidationOptions, validateUpgrade } from './utils';

export function makeValidateUpgrade(hre: HardhatRuntimeEnvironment) {
  return function (
    fromContractName: string,
    toContractName: string,
    opts: ValidationOptions = {},
  ): Promise<void> {
    return validateUpgrade(hre, fromContractName, toContractName, opts);
  };
}
