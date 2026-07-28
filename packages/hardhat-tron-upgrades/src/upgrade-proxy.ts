import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  ADMIN_SLOT,
  type AddressLike,
  BEACON_SLOT,
  FQN,
  IMPL_SLOT,
  type ProxyKind,
  type UpgradeProxyOptions,
  ZERO_ADDRESS,
  assertStorageCompatible,
  checkKind,
  core,
  ethersOf,
  getManifest,
  getSlot,
  isOptionalCallRevert,
  layoutForAddress,
  providerOf,
  proxyRecordOf,
  resolveAddress,
  resolveImplementation,
  slotToAddress,
  txOverridesOf,
  upgradeableContractFor,
  validateImplementation,
} from './utils';

function encodeUpgradeCall(contract: any, call: UpgradeProxyOptions['call']): string {
  if (!call) return '0x';
  if (typeof call === 'string' && call.startsWith('0x')) return call;
  const { Interface } = require('ethers');
  const iface = new Interface(contract.artifact.abi);
  return typeof call === 'string'
    ? iface.encodeFunctionData(call, [])
    : iface.encodeFunctionData(call.fn, call.args ?? []);
}

// Attaches a plugin-shipped interface (from contracts/Proxies.sol) at an
// address. The interface's fully-qualified name differs between this package
// and consumer projects, so resolve it from the compiled artifacts by name.
async function pluginInterfaceAt(
  hre: HardhatRuntimeEnvironment,
  interfaceName: string,
  address: string,
): Promise<any> {
  const names = await hre.artifacts.getAllFullyQualifiedNames();
  const expected = new Set([
    `contracts/Proxies.sol:${interfaceName}`,
    `@openzeppelin/hardhat-tron-upgrades/contracts/Proxies.sol:${interfaceName}`,
  ]);
  const matches = names.filter((name: string) => expected.has(name));
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `${interfaceName} artifact not found — import the plugin's contracts/Proxies.sol ` +
            `from your project (see README) and run \`hardhat compile\`.`
        : `Multiple plugin ${interfaceName} artifacts found: ${matches.join(', ')}`,
    );
  }
  return ethersOf(hre).getContractAt(matches[0], address);
}

// A proxy facade with the stable UUPS upgrade entry points (v4 upgradeTo +
// v5 upgradeToAndCall).
function uupsProxyFacade(hre: HardhatRuntimeEnvironment, proxyAddress: string): Promise<any> {
  return pluginInterfaceAt(hre, 'ITronUpgradesUUPS', proxyAddress);
}

// Reads a contract's UPGRADE_INTERFACE_VERSION, treating a revert (the getter
// is absent) as undefined. TRE reports the revert as "REVERT opcode executed"
// (upper case), which upgrades-core's lower-case matcher inside
// getUpgradeInterfaceVersion rethrows — catch it here the same way the UUPS
// path does, and rethrow only genuine transport errors.
async function upgradeInterfaceVersionOf(
  hre: HardhatRuntimeEnvironment,
  address: string,
): Promise<string | undefined> {
  const { getUpgradeInterfaceVersion } = core();
  try {
    return await getUpgradeInterfaceVersion(providerOf(hre), address, () => {});
  } catch (e: any) {
    if (!isOptionalCallRevert(e)) throw e;
    return undefined;
  }
}

export function makeUpgradeProxy(hre: HardhatRuntimeEnvironment) {
  return async function upgradeProxy(
    proxy: AddressLike,
    newContractName: string,
    opts: UpgradeProxyOptions = {},
  ): Promise<any> {
    const ethers = ethersOf(hre);
    const proxyAddress = await resolveAddress(hre, proxy);
    const manifest = await getManifest(hre);

    const record = await proxyRecordOf(manifest, proxyAddress);
    const beaconAddress = slotToAddress(await getSlot(hre, proxyAddress, BEACON_SLOT));
    if (beaconAddress !== ZERO_ADDRESS) {
      throw new Error(
        `Proxy ${proxyAddress} is a beacon proxy — its implementation lives on the beacon. ` +
          `Call upgradeBeacon("${beaconAddress}", ...) instead.`,
      );
    }
    const draft = await upgradeableContractFor(hre, newContractName, opts);
    const kindOpts: any = { ...opts };
    await core().processProxyKind(
      providerOf(hre),
      proxyAddress,
      kindOpts,
      draft.validations,
      draft.version,
    );
    const kind = kindOpts.kind as ProxyKind;
    checkKind(kind);

    // Chain first: the proxy's 1967 implementation slot is the only truth
    // about what runs now. The manifest supplies the stored layout FOR that
    // address — never a name-based guess, which drifts the moment the proxy
    // is upgraded outside this plugin.
    const { getImplementationAddress } = core();
    const currentImplAddress = await getImplementationAddress(providerOf(hre), proxyAddress);
    const currentLayout = await layoutForAddress(manifest, currentImplAddress);

    const newContract = await validateImplementation(hre, newContractName, { ...opts, kind });
    assertStorageCompatible(currentLayout, newContract.layout, opts);
    const callData = encodeUpgradeCall(newContract, opts.call);
    const txOverrides = txOverridesOf(opts);

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
      const adminAddr = ethers.getAddress(adminAddress);

      // Dispatch on the ProxyAdmin's reported UPGRADE_INTERFACE_VERSION, exactly
      // like upstream: a v5 ProxyAdmin returns "5.0.0" and exposes only
      // upgradeAndCall; a v4 ProxyAdmin has no such getter (the probe reverts)
      // and exposes upgrade + upgradeAndCall — where upgrade must be used for a
      // plain upgrade, since v4's upgradeAndCall force-calls the implementation.
      const adminUiv = await upgradeInterfaceVersionOf(hre, adminAddr);
      if (adminUiv === '5.0.0') {
        const admin = withOwner(await ethers.getContractAt(FQN.proxyAdmin, adminAddr));
        upgrade = (newImplAddress) =>
          txOverrides
            ? admin.upgradeAndCall(proxyAddress, newImplAddress, callData, txOverrides)
            : admin.upgradeAndCall(proxyAddress, newImplAddress, callData);
      } else {
        const admin = withOwner(await pluginInterfaceAt(hre, 'ITronUpgradesProxyAdminV4', adminAddr));
        upgrade = (newImplAddress) =>
          callData === '0x'
            ? txOverrides
              ? admin.upgrade(proxyAddress, newImplAddress, txOverrides)
              : admin.upgrade(proxyAddress, newImplAddress)
            : txOverrides
              ? admin.upgradeAndCall(proxyAddress, newImplAddress, callData, txOverrides)
              : admin.upgradeAndCall(proxyAddress, newImplAddress, callData);
      }
    } else {
      // The upgrade entry point lives in the CURRENT implementation and is
      // reached through the proxy (delegatecall). Dispatch on the proxy's
      // reported UPGRADE_INTERFACE_VERSION over a stable interface, exactly
      // like upstream: v5 exposes upgradeToAndCall, v4-style implementations
      // expose only upgradeTo — never assume the new implementation's ABI.
      const uiv = await upgradeInterfaceVersionOf(hre, proxyAddress);
      const proxyAsUups = withOwner(await uupsProxyFacade(hre, proxyAddress));
      upgrade = (newImplAddress) =>
        uiv === '5.0.0'
          ? txOverrides
            ? proxyAsUups.upgradeToAndCall(newImplAddress, callData, txOverrides)
            : proxyAsUups.upgradeToAndCall(newImplAddress, callData)
          : callData !== '0x'
            ? txOverrides
              ? proxyAsUups.upgradeToAndCall(newImplAddress, callData, txOverrides)
              : proxyAsUups.upgradeToAndCall(newImplAddress, callData)
            : txOverrides
              ? proxyAsUups.upgradeTo(newImplAddress, txOverrides)
              : proxyAsUups.upgradeTo(newImplAddress);
    }

    const newImplAddress = (
      await resolveImplementation(hre, newContractName, opts, newContract)
    ).address;

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
