import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  ADMIN_SLOT,
  type AddressLike,
  BEACON_SLOT,
  FQN,
  IMPL_SLOT,
  type UpgradeProxyOptions,
  ZERO_ADDRESS,
  checkKind,
  core,
  ethersOf,
  getManifest,
  getSlot,
  layoutForAddress,
  providerOf,
  proxyRecordOf,
  recordImpl,
  resolveAddress,
  slotToAddress,
  txHashOf,
  validateImplementation,
} from './utils';

export function makeUpgradeProxy(hre: HardhatRuntimeEnvironment) {
  return async function upgradeProxy(
    proxy: AddressLike,
    newContractName: string,
    opts: UpgradeProxyOptions = {},
  ): Promise<any> {
    const ethers = ethersOf(hre);
    const proxyAddress = await resolveAddress(proxy);
    const manifest = await getManifest(hre);

    const record = await proxyRecordOf(manifest, proxyAddress);
    if (record && opts.kind && record.kind !== opts.kind) {
      throw new Error(
        `Proxy ${proxyAddress} is recorded as "${record.kind}" but opts.kind says "${opts.kind}"`,
      );
    }
    const kind = record?.kind ?? opts.kind ?? 'transparent';
    if (kind === 'beacon') {
      const beaconAddress = slotToAddress(await getSlot(hre, proxyAddress, BEACON_SLOT));
      throw new Error(
        `Proxy ${proxyAddress} is a beacon proxy — its implementation lives on the beacon. ` +
          `Call upgradeBeacon("${beaconAddress}", ...) instead.`,
      );
    }
    checkKind(kind);

    // Chain first: the proxy's 1967 implementation slot is the only truth
    // about what runs now. The manifest supplies the stored layout FOR that
    // address — never a name-based guess, which drifts the moment the proxy
    // is upgraded outside this plugin.
    const { getImplementationAddress, assertStorageUpgradeSafe } = core();
    const currentImplAddress = await getImplementationAddress(providerOf(hre), proxyAddress);
    const currentLayout = await layoutForAddress(manifest, currentImplAddress);

    const newContract = await validateImplementation(hre, newContractName, { kind });
    assertStorageUpgradeSafe(currentLayout, newContract.layout, false);

    // Resolve the upgrade authority BEFORE deploying the new implementation,
    // so a mis-routed proxy (e.g. a UUPS proxy taken down the transparent
    // path) fails without leaving an orphan implementation on the chain.
    // Without opts.owner, calls are signed by the deployer key.
    const withOwner = (contract: any) => (opts.owner ? contract.connect(opts.owner) : contract);
    let admin: any = null;
    if (kind === 'transparent') {
      const adminAddress = slotToAddress(await getSlot(hre, proxyAddress, ADMIN_SLOT));
      if (adminAddress === ZERO_ADDRESS) {
        throw new Error(
          `Proxy ${proxyAddress} has no admin in the 1967 admin slot — not a transparent proxy? For UUPS proxies pass opts.kind: "uups".`,
        );
      }
      admin = await ethers.getContractAt(FQN.proxyAdmin, ethers.getAddress(adminAddress));
    }

    const newImpl = await ethers.deployContract(newContractName);
    const newImplAddress = await newImpl.getAddress();

    if (kind === 'uups') {
      // The upgrade function lives in the CURRENT implementation and is
      // reached through the proxy (delegatecall), so it mutates the proxy's
      // own 1967 slot. The new implementation was validated as uups, so its
      // ABI necessarily carries upgradeToAndCall — attach that ABI.
      const proxyAsUups = await ethers.getContractAt(newContractName, proxyAddress);
      await withOwner(proxyAsUups).upgradeToAndCall(newImplAddress, opts.call ?? '0x');
    } else {
      await withOwner(admin).upgradeAndCall(proxyAddress, newImplAddress, opts.call ?? '0x');
    }

    // trust, but verify: the implementation slot must now hold the new address
    const current = slotToAddress(await getSlot(hre, proxyAddress, IMPL_SLOT)).toLowerCase();
    if (current !== newImplAddress.toLowerCase()) {
      throw new Error(
        `Upgrade transaction succeeded but the implementation slot holds ${current}, expected ${newImplAddress}`,
      );
    }

    await recordImpl(manifest, newContract, newImplAddress, txHashOf(newImpl));
    if (!record) {
      await core().addProxyToManifest(kind, proxyAddress, manifest);
    }

    return ethers.getContractAt(newContractName, proxyAddress);
  };
}
