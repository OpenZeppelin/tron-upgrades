import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type AddressLike,
  type PrepareUpgradeOptions,
  type ValidationKind,
  assertStorageCompatible,
  core,
  getManifest,
  isBeaconContract,
  layoutForAddress,
  providerOf,
  upgradeableContractFor,
  resolveAddress,
  resolveImplementation,
  validateImplementation,
} from './utils';

export function makePrepareUpgrade(hre: HardhatRuntimeEnvironment) {
  return async function prepareUpgrade(
    reference: AddressLike,
    newContractName: string,
    opts: PrepareUpgradeOptions = {},
  ): Promise<any> {
    const provider = providerOf(hre);
    const manifest = await getManifest(hre);
    const referenceAddress = await resolveAddress(reference);
    const { getBeaconAddress, getImplementationAddress, getImplementationAddressFromBeacon } =
      core();

    // Upstream detection order: a 1967 proxy wins first — classification
    // must come from the proxy's slots, never from whether a delegated
    // implementation() call happens to succeed — then beacon proxies, then
    // bare beacons, and finally a bare implementation, which requires an
    // explicit kind.
    let kind: ValidationKind;
    let currentImplAddress: string;
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
      kind = kindOpts.kind;
      currentImplAddress = await getImplementationAddress(provider, referenceAddress);
    } else if (await core().isBeaconProxy(provider, referenceAddress)) {
      kind = 'beacon';
      currentImplAddress = await getImplementationAddressFromBeacon(
        provider,
        await getBeaconAddress(provider, referenceAddress),
      );
    } else if (await isBeaconContract(hre, referenceAddress)) {
      kind = 'beacon';
      currentImplAddress = await getImplementationAddressFromBeacon(provider, referenceAddress);
    } else {
      if (opts.kind === undefined) {
        throw new Error(
          `Cannot determine the proxy kind of ${referenceAddress} — it is not a proxy or ` +
            `beacon this plugin recognizes. To prepare an upgrade against a bare ` +
            `implementation address, pass opts.kind ('transparent' | 'uups' | 'beacon').`,
        );
      }
      kind = opts.kind;
      currentImplAddress = referenceAddress;
    }

    const currentLayout = await layoutForAddress(manifest, currentImplAddress);
    const contract = await validateImplementation(hre, newContractName, { ...opts, kind });
    assertStorageCompatible(currentLayout, contract.layout, opts);
    const deployment = await resolveImplementation(hre, newContractName, opts, contract);
    return opts.getTxResponse && deployment.txResponse ? deployment.txResponse : deployment.address;
  };
}
