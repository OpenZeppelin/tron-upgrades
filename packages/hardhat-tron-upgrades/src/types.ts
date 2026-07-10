import type { AddressLike } from './utils/ethers';
import type {
  DeployBeaconOptions,
  DeployBeaconProxyOptions,
  DeployImplementationOptions,
  DeployProxyOptions,
  PrepareUpgradeOptions,
  UpgradeBeaconOptions,
  UpgradeProxyOptions,
  ValidationOptions,
} from './utils/options';

export interface UpgradesAPI {
  deployProxy(name: string, args?: unknown[], opts?: DeployProxyOptions): Promise<any>;
  upgradeProxy(proxy: AddressLike, name: string, opts?: UpgradeProxyOptions): Promise<any>;
  deployBeacon(name: string, opts?: DeployBeaconOptions): Promise<any>;
  deployBeaconProxy(
    beacon: AddressLike,
    name: string,
    args?: unknown[],
    opts?: DeployBeaconProxyOptions,
  ): Promise<any>;
  upgradeBeacon(beacon: AddressLike, name: string, opts?: UpgradeBeaconOptions): Promise<any>;
  forceImport(address: AddressLike, name: string, opts?: ValidationOptions): Promise<any>;
  deployImplementation(name: string, opts?: DeployImplementationOptions): Promise<string>;
  prepareUpgrade(
    reference: AddressLike,
    name: string,
    opts?: PrepareUpgradeOptions,
  ): Promise<string>;
  validateImplementation(name: string, opts?: ValidationOptions): Promise<void>;
  validateUpgrade(from: string, to: string, opts?: ValidationOptions): Promise<void>;
  erc1967: {
    getImplementationAddress(proxy: AddressLike): Promise<string>;
    getAdminAddress(proxy: AddressLike): Promise<string>;
    getBeaconAddress(proxy: AddressLike): Promise<string>;
  };
  beacon: {
    getImplementationAddress(beacon: AddressLike): Promise<string>;
  };
  trc1967: { IMPL_SLOT: string; ADMIN_SLOT: string; BEACON_SLOT: string };
}
