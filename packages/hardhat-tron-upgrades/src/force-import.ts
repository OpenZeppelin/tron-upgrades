import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  ADMIN_SLOT,
  type AddressLike,
  FQN,
  type ValidationOptions,
  ZERO_ADDRESS,
  core,
  ethersOf,
  getManifest,
  getSlot,
  isBeaconContract,
  providerOf,
  recordImpl,
  resolveAddress,
  slotToAddress,
  upgradeableContractFor,
  validateImplementation,
} from './utils';

export function makeForceImport(hre: HardhatRuntimeEnvironment) {
  return async function forceImport(
    addressOrInstance: AddressLike,
    contractName: string,
    opts: ValidationOptions = {},
  ): Promise<any> {
    const ethers = ethersOf(hre);
    const provider = providerOf(hre);
    const manifest = await getManifest(hre);
    const address = await resolveAddress(hre, addressOrInstance);
    const {
      NoContractImportError,
      addProxyToManifest,
      getImplementationAddressFromBeacon,
      getImplementationAddressFromProxy,
      hasCode,
      inferProxyKind,
      isBeaconProxy,
    } = core();

    // TVM rejects storage reads for no-code addresses instead of returning an
    // empty slot like an EVM node. Preserve upstream's NoContractImportError by
    // checking code before the proxy-detection sequence.
    if (!(await hasCode(provider, address))) {
      throw new NoContractImportError(address);
    }

    const implAddress = await getImplementationAddressFromProxy(provider, address);
    if (implAddress !== undefined) {
      const draft = await upgradeableContractFor(hre, contractName, opts);
      const kind =
        opts.kind ??
        ((await isBeaconProxy(provider, address))
          ? 'beacon'
          : inferProxyKind(draft.validations, draft.version));
      if (kind === 'transparent') {
        const adminAddress = slotToAddress(await getSlot(hre, address, ADMIN_SLOT));
        if (adminAddress === ZERO_ADDRESS) {
          throw new Error(
            `Proxy at ${address} doesn't look like a transparent proxy because its admin address slot is empty`,
          );
        }
      }
      const contract = await validateImplementation(hre, contractName, { ...opts, kind });
      await recordImpl(manifest, contract, implAddress, undefined);
      await addProxyToManifest(kind, address, manifest);
      return ethers.getContractAt(contractName, address);
    }

    const addressIsBeacon = await isBeaconContract(hre, address);
    if (addressIsBeacon) {
      const beaconImplAddress = await getImplementationAddressFromBeacon(provider, address);
      const contract = await validateImplementation(hre, contractName, { ...opts, kind: 'beacon' });
      await recordImpl(manifest, contract, beaconImplAddress, undefined);
      return ethers.getContractAt(FQN.beacon, address);
    }

    const contract = await validateImplementation(hre, contractName, opts);
    await recordImpl(manifest, contract, address, undefined);
    return ethers.getContractAt(contractName, address);
  };
}
