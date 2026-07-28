import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type AddressLike,
  type ValidationOptions,
  looksLikeAddress,
  validateUpgrade,
  validateUpgradeReference,
} from './utils';

// validateUpgrade has two shapes, mirroring upstream:
//   (referenceAddressOrContract, newImplName, opts) — validate a candidate
//      against the layout of the implementation currently deployed at a proxy,
//      beacon, beacon proxy, or bare implementation address, WITHOUT deploying.
//   (fromContractName, toContractName, opts) — standalone name-vs-name layout
//      check with no on-chain reference.
// The first argument is routed by shape: an address (any TVM encoding) or an
// address-bearing contract instance takes the deployed-reference path; a bare
// contract-artifact name takes the standalone path.
export function makeValidateUpgrade(hre: HardhatRuntimeEnvironment) {
  function validateUpgradeFn(
    reference: AddressLike,
    newContractName: string,
    opts?: ValidationOptions,
  ): Promise<void>;
  function validateUpgradeFn(
    fromContractName: string,
    toContractName: string,
    opts?: ValidationOptions,
  ): Promise<void>;
  function validateUpgradeFn(
    referenceOrFrom: AddressLike,
    newOrTo: string,
    opts: ValidationOptions = {},
  ): Promise<void> {
    if (looksLikeAddress(hre, referenceOrFrom)) {
      return validateUpgradeReference(hre, referenceOrFrom, newOrTo, opts);
    }
    return validateUpgrade(hre, referenceOrFrom as string, newOrTo, opts);
  }
  return validateUpgradeFn;
}
