import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import { isBeaconContract } from './beacon';
import { core } from './core';
import { type AddressLike, providerOf, resolveAddress } from './ethers';
import { getManifest } from './manifest';
import type { ValidationKind, ValidationOptions } from './options';
import { upgradeableContractFor } from './validations';

// Returns the validated UpgradeableContract: callers need its `version`
// (manifest key) and `layout` (the stored validation baseline).
export async function validateImplementation(
  hre: HardhatRuntimeEnvironment,
  contractName: string,
  opts: ValidationOptions & { constructorArgs?: unknown[] } = {},
): Promise<any> {
  const data = await upgradeableContractFor(hre, contractName, opts);
  if (!data.errorReport.ok) {
    throw new Error(`${contractName} is not upgrade-safe:\n${data.errorReport.explain()}`);
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
  const { inferProxyKind, getStorageUpgradeReport, withValidationDefaults } = core();
  const kind = opts.kind ?? inferProxyKind(from.validations, from.version);
  const to = await upgradeableContractFor(hre, toContractName, { ...opts, kind });
  if (!to.errorReport.ok) {
    throw new Error(`${toContractName} is not upgrade-safe:\n${to.errorReport.explain()}`);
  }
  if (opts.unsafeSkipStorageCheck) return;
  const layout = getStorageUpgradeReport(from.layout, to.layout, withValidationDefaults(opts));
  if (!layout.ok) {
    throw new Error(
      `Storage layout of ${toContractName} is incompatible with ${fromContractName}:\n${layout.explain()}`,
    );
  }
}

// Resolve a DEPLOYED reference to the proxy kind and the address of the
// implementation currently installed at it, WITHOUT deploying anything. The
// detection order is upstream's: a 1967 proxy wins first — classification must
// come from the proxy's slots, never from whether a delegated implementation()
// call happens to succeed — then beacon proxies, then bare beacons, and finally
// a bare implementation, which requires an explicit kind. `onMissingKind`
// supplies the caller-specific requires-kind error for that last case. Shared
// by prepareUpgrade (which then deploys) and the deployed-reference
// validateUpgrade (which does not).
export async function resolveReferenceImpl(
  hre: HardhatRuntimeEnvironment,
  referenceAddress: string,
  newContractName: string,
  opts: ValidationOptions,
  onMissingKind: () => Error,
): Promise<{ kind: ValidationKind; currentImplAddress: string }> {
  const provider = providerOf(hre);
  const { getBeaconAddress, getImplementationAddress, getImplementationAddressFromBeacon } = core();

  if (await core().isTransparentOrUUPSProxy(provider, referenceAddress)) {
    const draft = await upgradeableContractFor(hre, newContractName, opts);
    const kindOpts: any = { ...opts };
    await core().processProxyKind(
      provider,
      referenceAddress,
      kindOpts,
      draft.validations,
      draft.version,
    );
    return {
      kind: kindOpts.kind,
      currentImplAddress: await getImplementationAddress(provider, referenceAddress),
    };
  }
  if (await core().isBeaconProxy(provider, referenceAddress)) {
    return {
      kind: 'beacon',
      currentImplAddress: await getImplementationAddressFromBeacon(
        provider,
        await getBeaconAddress(provider, referenceAddress),
      ),
    };
  }
  if (await isBeaconContract(hre, referenceAddress)) {
    return {
      kind: 'beacon',
      currentImplAddress: await getImplementationAddressFromBeacon(provider, referenceAddress),
    };
  }
  if (opts.kind === undefined) throw onMissingKind();
  return { kind: opts.kind, currentImplAddress: referenceAddress };
}

// Deployed-reference validateUpgrade: validate `newContractName` against the
// manifest-stored layout of the implementation installed at `reference` (a
// proxy, beacon, beacon proxy, or bare implementation address) WITHOUT
// deploying. An unregistered reference layout raises the upstream
// forceImport-directing error via layoutForAddress.
export async function validateUpgradeReference(
  hre: HardhatRuntimeEnvironment,
  reference: AddressLike,
  newContractName: string,
  opts: ValidationOptions = {},
): Promise<void> {
  const manifest = await getManifest(hre);
  const referenceAddress = await resolveAddress(hre, reference);
  const { kind, currentImplAddress } = await resolveReferenceImpl(
    hre,
    referenceAddress,
    newContractName,
    opts,
    () => new (core().ValidateUpdateRequiresKindError)(),
  );
  const currentLayout = await layoutForAddress(manifest, currentImplAddress);
  const contract = await validateImplementation(hre, newContractName, { ...opts, kind });
  assertStorageCompatible(currentLayout, contract.layout, opts);
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
