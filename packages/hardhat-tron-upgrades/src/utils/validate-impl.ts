import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import type { ValidationOptions } from './options';
import { upgradeableContractFor } from './validations';

export async function validateImplementation(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  opts: ValidationOptions = {},
): Promise<void> {
  const { contract } = await upgradeableContractFor(hre, contractName, opts);
  const report = contract.getErrorReport();
  if (!report.ok) {
    throw new Error(`${contractName} is not upgrade-safe:\n${report.explain()}`);
  }
}

export async function validateUpgrade(
  hre: HardhatRuntimeEnvironment,
  fromContractName: string,
  toContractName: string,
  opts: ValidationOptions = {},
): Promise<void> {
  const from = await upgradeableContractFor(hre, fromContractName, opts);
  const to = await upgradeableContractFor(hre, toContractName, opts);
  const errors = to.contract.getErrorReport();
  if (!errors.ok) {
    throw new Error(`${toContractName} is not upgrade-safe:\n${errors.explain()}`);
  }
  const layout = from.contract.getStorageUpgradeReport(to.contract);
  if (!layout.ok) {
    throw new Error(
      `Storage layout of ${toContractName} is incompatible with ${fromContractName}:\n${layout.explain()}`,
    );
  }
}
