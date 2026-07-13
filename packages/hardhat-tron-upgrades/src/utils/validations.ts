import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { core } from './core';
import type { ValidationOptions } from './options';

// -- validation (off-chain, over compiler build-info) ---------------

export async function upgradeableContractFor(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  opts: ValidationOptions = {},
) {
  const { UpgradeableContract } = core();
  const artifact = await hre.artifacts.readArtifact(contractName);
  const fqName = `${artifact.sourceName}:${artifact.contractName}`;
  const buildInfo = await hre.artifacts.getBuildInfo(fqName);
  if (!buildInfo) {
    throw new Error(`No build-info for ${fqName}. Run \`hardhat compile\` first.`);
  }
  // `kind` matters: upgrades-core only surfaces the missing
  // upgradeTo/upgradeToAndCall error when validating as 'uups'.
  const validationOpts = { kind: opts.kind ?? 'transparent' };
  return {
    artifact,
    contract: new UpgradeableContract(
      artifact.contractName,
      buildInfo.input,
      buildInfo.output,
      validationOpts,
      (buildInfo as any).solcVersion,
    ),
  };
}
