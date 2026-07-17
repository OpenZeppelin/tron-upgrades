import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  type AddressLike,
  type PrepareUpgradeOptions,
  assertStorageCompatible,
  getManifest,
  layoutForAddress,
  resolveAddress,
  resolveImplementation,
  resolveReferenceImpl,
  validateImplementation,
} from './utils';

export function makePrepareUpgrade(hre: HardhatRuntimeEnvironment) {
  return async function prepareUpgrade(
    reference: AddressLike,
    newContractName: string,
    opts: PrepareUpgradeOptions = {},
  ): Promise<any> {
    const manifest = await getManifest(hre);
    const referenceAddress = await resolveAddress(hre, reference);
    const { kind, currentImplAddress } = await resolveReferenceImpl(
      hre,
      referenceAddress,
      newContractName,
      opts,
      () =>
        new Error(
          `Cannot determine the proxy kind of ${referenceAddress} — it is not a proxy or ` +
            `beacon this plugin recognizes. To prepare an upgrade against a bare ` +
            `implementation address, pass opts.kind ('transparent' | 'uups' | 'beacon').`,
        ),
    );

    const currentLayout = await layoutForAddress(manifest, currentImplAddress);
    const contract = await validateImplementation(hre, newContractName, { ...opts, kind });
    assertStorageCompatible(currentLayout, contract.layout, opts);
    const deployment = await resolveImplementation(hre, newContractName, opts, contract);
    return opts.getTxResponse && deployment.txResponse ? deployment.txResponse : deployment.address;
  };
}
