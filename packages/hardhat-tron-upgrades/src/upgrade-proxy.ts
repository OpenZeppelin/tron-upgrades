import type { HardhatRuntimeEnvironment } from 'hardhat/types';
import {
  ADMIN_SLOT,
  type AddressLike,
  FQN,
  IMPL_SLOT,
  type UpgradeProxyOptions,
  ZERO_ADDRESS,
  checkKind,
  ethersOf,
  getSlot,
  readManifest,
  resolveAddress,
  slotToAddress,
  validateUpgrade,
  writeManifest,
} from './utils';

export function makeUpgradeProxy(hre: HardhatRuntimeEnvironment) {
  return async function upgradeProxy(
    proxy: AddressLike,
    newContractName: string,
    opts: UpgradeProxyOptions = {},
  ): Promise<any> {
    const ethers = ethersOf(hre);
    const proxyAddress = await resolveAddress(proxy);

    const manifest = readManifest(hre);
    const record = manifest.proxies[proxyAddress.toLowerCase()];
    if (record && opts.kind && record.kind !== opts.kind) {
      throw new Error(
        `Proxy ${proxyAddress} is recorded as "${record.kind}" but opts.kind says "${opts.kind}"`,
      );
    }
    const kind = record?.kind ?? opts.kind ?? 'transparent';
    if (kind === 'beacon') {
      throw new Error(
        `Proxy ${proxyAddress} is a beacon proxy — its implementation lives on the beacon. ` +
          `Call upgradeBeacon(${record?.beacon ?? '<beaconAddress>'}, ...) instead.`,
      );
    }
    checkKind(kind);

    const fromContractName = opts.from ?? record?.contract;
    if (!fromContractName) {
      throw new Error(
        `No deployment record for proxy ${proxyAddress} on network "${hre.network.name}" — pass opts.from with the current implementation's contract name (and opts.kind for non-transparent proxies).`,
      );
    }

    await validateUpgrade(hre, fromContractName, newContractName, { kind });

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
      // own 1967 slot.
      const proxyAsImpl = await ethers.getContractAt(fromContractName, proxyAddress);
      await withOwner(proxyAsImpl).upgradeToAndCall(newImplAddress, opts.call ?? '0x');
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

    manifest.proxies[proxyAddress.toLowerCase()] = {
      kind,
      contract: newContractName,
      implementation: newImplAddress,
    };
    writeManifest(hre, manifest);

    return ethers.getContractAt(newContractName, proxyAddress);
  };
}
