import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { core } from './core';
import type { ValidationOptions } from './options';

// -- validation (off-chain, over compiler build-info) ---------------

export async function upgradeableContractFor(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  opts: ValidationOptions & { constructorArgs?: unknown[] } = {},
) {
  const {
    UpgradeableContract,
    getStorageLayout,
    getUnlinkedBytecode,
    getVersion,
    solcInputOutputDecoder,
    validate,
  } = core();
  const artifact = await hre.artifacts.readArtifact(contractName);
  const fqName = `${artifact.sourceName}:${artifact.contractName}`;
  const buildInfo = await hre.artifacts.getBuildInfo(fqName);
  if (!buildInfo) {
    throw new Error(`No build-info for ${fqName}. Run \`hardhat compile\` first.`);
  }
  const decodeSrc = solcInputOutputDecoder(buildInfo.input, buildInfo.output);
  const validations = validate(
    buildInfo.output,
    decodeSrc,
    (buildInfo as any).solcVersion,
    buildInfo.input,
  );
  const unlinkedBytecode = getUnlinkedBytecode(validations, artifact.bytecode);
  const { Interface } = require('ethers');
  const encodedArgs = new Interface(artifact.abi).encodeDeploy(opts.constructorArgs ?? []);
  const version = getVersion(unlinkedBytecode, artifact.bytecode, encodedArgs);

  // `kind` matters: upgrades-core only surfaces the missing
  // upgradeTo/upgradeToAndCall error when validating as 'uups'.
  const validationOpts = {
    kind: opts.kind ?? 'transparent',
    unsafeAllow: opts.unsafeAllow,
    unsafeAllowRenames: opts.unsafeAllowRenames,
    unsafeSkipStorageCheck: opts.unsafeSkipStorageCheck,
  };
  return {
    artifact,
    validations,
    version,
    layout: getStorageLayout(validations, version),
    contract: new UpgradeableContract(
      artifact.contractName,
      buildInfo.input,
      buildInfo.output,
      validationOpts,
      (buildInfo as any).solcVersion,
    ),
  };
}
