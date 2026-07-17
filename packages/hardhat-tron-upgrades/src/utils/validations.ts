import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { core } from './core';
import { getNamespacedOutput } from './namespaced';
import type { ValidationOptions } from './options';

// -- validation (off-chain, over compiler build-info) ---------------

export async function upgradeableContractFor(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  opts: ValidationOptions & { constructorArgs?: unknown[] } = {},
) {
  const {
    getErrors,
    getStorageLayout,
    getUnlinkedBytecode,
    getVersion,
    solcInputOutputDecoder,
    validate,
    withValidationDefaults,
    UpgradeableContractErrorReport,
  } = core();
  const artifact = await hre.artifacts.readArtifact(contractName);
  const fqName = `${artifact.sourceName}:${artifact.contractName}`;
  const buildInfo = await hre.artifacts.getBuildInfo(fqName);
  if (!buildInfo) {
    throw new Error(`No build-info for ${fqName}. Run \`hardhat compile\` first.`);
  }

  // ERC-7201 namespace members have no slot/offset in the primary build-info;
  // the namespaced recompile supplies them so packing-sensitive namespace
  // edits validate correctly. `undefined` falls back to AST-only checks.
  const namespacedOutput = await getNamespacedOutput(hre, buildInfo);

  const decodeSrc = solcInputOutputDecoder(buildInfo.input, buildInfo.output);
  const validations = validate(
    buildInfo.output,
    decodeSrc,
    (buildInfo as any).solcVersion,
    buildInfo.input,
    namespacedOutput,
  );
  const unlinkedBytecode = getUnlinkedBytecode(validations, artifact.bytecode);
  const { Interface } = require('ethers');
  const encodedArgs = new Interface(artifact.abi).encodeDeploy(opts.constructorArgs ?? []);
  const version = getVersion(unlinkedBytecode, artifact.bytecode, encodedArgs);

  // `kind` matters: upgrades-core only surfaces the missing
  // upgradeTo/upgradeToAndCall error when validating as 'uups'.
  const validationOpts = withValidationDefaults({
    kind: opts.kind ?? 'transparent',
    unsafeAllow: opts.unsafeAllow,
    unsafeAllowRenames: opts.unsafeAllowRenames,
    unsafeSkipStorageCheck: opts.unsafeSkipStorageCheck,
  });
  const errors = getErrors(validations, version, validationOpts);
  return {
    artifact,
    validations,
    version,
    layout: getStorageLayout(validations, version),
    errorReport: new UpgradeableContractErrorReport(errors),
  };
}
