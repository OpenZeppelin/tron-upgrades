import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type AddressLike,
  type PrepareUpgradeOptions,
  type ValidationKind,
  core,
  getManifest,
  isBeaconContract,
  layoutForAddress,
  providerOf,
  proxyRecordOf,
  resolveAddress,
  resolveImplementation,
  validateImplementation,
} from './utils';

export function makePrepareUpgrade(hre: HardhatRuntimeEnvironment) {
  return async function prepareUpgrade(
    reference: AddressLike,
    newContractName: string,
    opts: PrepareUpgradeOptions = {},
  ): Promise<string> {
    const provider = providerOf(hre);
    const manifest = await getManifest(hre);
    const referenceAddress = await resolveAddress(reference);
    const {
      assertStorageUpgradeSafe,
      getBeaconAddress,
      getImplementationAddress,
      getImplementationAddressFromBeacon,
    } = core();

    let kind: ValidationKind;
    let currentImplAddress: string;
    if (await core().isBeaconProxy(provider, referenceAddress)) {
      kind = 'beacon';
      currentImplAddress = await getImplementationAddressFromBeacon(
        provider,
        await getBeaconAddress(provider, referenceAddress),
      );
    } else if (await isBeaconContract(hre, referenceAddress)) {
      kind = 'beacon';
      currentImplAddress = await getImplementationAddressFromBeacon(provider, referenceAddress);
    } else {
      const record = await proxyRecordOf(manifest, referenceAddress);
      if (record && opts.kind && record.kind !== opts.kind) {
        throw new Error(
          `Proxy ${referenceAddress} is recorded as "${record.kind}" but opts.kind says "${opts.kind}"`,
        );
      }
      kind = (record?.kind ?? opts.kind ?? 'transparent') as ValidationKind;
      currentImplAddress = await getImplementationAddress(provider, referenceAddress);
    }

    const currentLayout = await layoutForAddress(manifest, currentImplAddress);
    const contract = await validateImplementation(hre, newContractName, { ...opts, kind });
    assertStorageUpgradeSafe(currentLayout, contract.layout, false);
    return (await resolveImplementation(hre, newContractName, opts, contract)).address;
  };
}
