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

// A proxy facade with the stable UUPS upgrade entry points (v4 upgradeTo +
// v5 upgradeToAndCall). The interface ships in contracts/Proxies.sol, so its
// fully-qualified name differs between this package and consumer projects —
// resolve it from the compiled artifacts.
async function uupsProxyFacade(hre: HardhatRuntimeEnvironment, proxyAddress: string): Promise<any> {
  const names = await hre.artifacts.getAllFullyQualifiedNames();
  const fqn = names.find((n: string) => n.endsWith(':ITronUpgradesUUPS'));
  if (!fqn) {
    throw new Error(
      `ITronUpgradesUUPS artifact not found — import the plugin's contracts/Proxies.sol ` +
        `from your project (see README) and run \`hardhat compile\`.`,
    );
  }
  return ethersOf(hre).getContractAt(fqn, proxyAddress);
}

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
    let upgrade: (newImplAddress: string) => Promise<unknown>;
    if (kind === 'transparent') {
      const adminAddress = slotToAddress(await getSlot(hre, proxyAddress, ADMIN_SLOT));
      if (adminAddress === ZERO_ADDRESS) {
        throw new Error(
          `Proxy ${proxyAddress} has no admin in the 1967 admin slot — not a transparent proxy? For UUPS proxies pass opts.kind: "uups".`,
        );
      }
      const admin = withOwner(await ethers.getContractAt(FQN.proxyAdmin, ethers.getAddress(adminAddress)));
      upgrade = (newImplAddress) => admin.upgradeAndCall(proxyAddress, newImplAddress, opts.call ?? '0x');
    } else {
      // The upgrade entry point lives in the CURRENT implementation and is
      // reached through the proxy (delegatecall). Dispatch on the proxy's
      // reported UPGRADE_INTERFACE_VERSION over a stable interface, exactly
      // like upstream: v5 exposes upgradeToAndCall, v4-style implementations
      // expose only upgradeTo — never assume the new implementation's ABI.
      const { getUpgradeInterfaceVersion } = core();
      let uiv: string | undefined;
      try {
        uiv = await getUpgradeInterfaceVersion(providerOf(hre), proxyAddress, () => {});
      } catch (e: any) {
        // A current implementation without UPGRADE_INTERFACE_VERSION reverts
        // the optional call. TRE reports that as "REVERT opcode executed" —
        // upper case, which upstream's (lower-case) revert matcher rethrows.
        // Match their list case-insensitively; real transport errors still throw.
        if (!/revert|invalid opcode|execution error|function selector was not recognized/i.test(e?.message ?? '')) {
          throw e;
        }
        uiv = undefined;
      }
      const proxyAsUups = withOwner(await uupsProxyFacade(hre, proxyAddress));
      upgrade = (newImplAddress) =>
        uiv === '5.0.0'
          ? proxyAsUups.upgradeToAndCall(newImplAddress, opts.call ?? '0x')
          : opts.call
            ? proxyAsUups.upgradeToAndCall(newImplAddress, opts.call)
            : proxyAsUups.upgradeTo(newImplAddress);
    }

    const newImpl = await ethers.deployContract(newContractName);
    const newImplAddress = await newImpl.getAddress();
    // Register BEFORE pressing the button: if the process dies between the
    // upgrade transaction and a later write, the chain would point at an
    // implementation the manifest never saw — self-inflicted drift.
    await recordImpl(manifest, newContract, newImplAddress, txHashOf(newImpl));

    await upgrade(newImplAddress);

    // trust, but verify: the implementation slot must now hold the new address
    const current = slotToAddress(await getSlot(hre, proxyAddress, IMPL_SLOT)).toLowerCase();
    if (current !== newImplAddress.toLowerCase()) {
      throw new Error(
        `Upgrade transaction succeeded but the implementation slot holds ${current}, expected ${newImplAddress}`,
      );
    }

    if (!record) {
      await core().addProxyToManifest(kind, proxyAddress, manifest);
    }

    return ethers.getContractAt(newContractName, proxyAddress);
  };
}
