import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { core } from './core';
import type { ValidationOptions } from './options';
import { upgradeableContractFor } from './validations';

// Returns the validated UpgradeableContract: callers need its `version`
// (manifest key) and `layout` (the stored validation baseline).
export async function validateImplementation(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  opts: ValidationOptions & { constructorArgs?: unknown[] } = {},
): Promise<any> {
  const data = await upgradeableContractFor(hre, contractName, opts);
  const { contract } = data;
  const report = contract.getErrorReport();
  if (!report.ok) {
    throw new Error(`${contractName} is not upgrade-safe:\n${report.explain()}`);
  }
  return data;
}

// Standalone comparison of two LOCAL contracts. Deliberately name-based:
// it claims nothing about any deployed proxy (useful for CI layout checks).
// Deployed-proxy upgrades never go through here — they validate against the
// layout of the implementation currently installed on-chain.
export async function validateUpgrade(
  hre: HardhatRuntimeEnvironment,
  fromContractName: string,
  toContractName: string,
  opts: ValidationOptions = {},
): Promise<void> {
  const from = await upgradeableContractFor(hre, fromContractName, opts);
  // When `kind` is omitted, infer it from the REFERENCE contract, never the
  // candidate. A candidate that dropped its upgrade function self-infers
  // 'transparent', which makes upgrades-core suppress the missing-upgradeTo
  // error and would let a UUPS proxy be upgraded to a bricking implementation.
  const { inferProxyKind } = core();
  const kind = opts.kind ?? inferProxyKind(from.validations, from.version);
  const to = await upgradeableContractFor(hre, toContractName, { ...opts, kind });
  const errors = to.contract.getErrorReport();
  if (!errors.ok) {
    throw new Error(`${toContractName} is not upgrade-safe:\n${errors.explain()}`);
  }
  if (opts.unsafeSkipStorageCheck) return;
  const layout = from.contract.getStorageUpgradeReport(to.contract, opts);
  if (!layout.ok) {
    throw new Error(
      `Storage layout of ${toContractName} is incompatible with ${fromContractName}:\n${layout.explain()}`,
    );
  }
}

// Layout of the implementation at `implAddress`, found BY ADDRESS. Unknown
// address → upgrades-core error directing to forceImport. The layouts we
// store are always current-schema, so the validation-data parameter (used
// only to upgrade legacy layout records) can be empty.
export async function layoutForAddress(manifest: any, implAddress: string): Promise<any> {
  const { getStorageLayoutForAddress } = core();
  return getStorageLayoutForAddress(manifest, [], implAddress);
}

export function assertStorageCompatible(
  currentLayout: any,
  newLayout: any,
  opts: ValidationOptions,
): void {
  if (opts.unsafeSkipStorageCheck) return;
  const { assertStorageUpgradeSafe, withValidationDefaults } = core();
  assertStorageUpgradeSafe(currentLayout, newLayout, withValidationDefaults(opts));
}
