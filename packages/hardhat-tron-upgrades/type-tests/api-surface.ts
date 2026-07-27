// Compile-only fixture: importing every public export from the package entry
// point makes a dropped or renamed export a BUILD failure, not a silent
// regression. Runtime tests cannot catch this (they import nothing from the
// root), so this file is wired into `npm test` via `check:types`.

import type {
  DeployBeaconOptions,
  DeployBeaconProxyOptions,
  DeployImplementationOptions,
  DeployProxyOptions,
  ImplementationOptions,
  PrepareUpgradeOptions,
  ProxyKind,
  TransferProxyAdminOwnershipOptions,
  TxOverrides,
  UpgradeBeaconOptions,
  UpgradeProxyOptions,
  UpgradesAPI,
  ValidationKind,
  ValidationOptions,
} from '../src/index';
import { makeUpgrades } from '../src/index';
import type { TronUpgradesUserConfig } from '../src/config';

// The expected hre.upgrades surface, spelled out member by member — removing
// or retyping any member fails compilation here.
declare const upgrades: UpgradesAPI;

async function surface(): Promise<void> {
  const deployOpts: DeployProxyOptions = {
    kind: 'uups' satisfies ProxyKind,
    initializer: 'initialize',
    constructorArgs: [1n],
    redeployImplementation: 'onchange',
    txOverrides: { value: 0, gasLimit: 1_000_000 } satisfies TxOverrides,
  };
  const upgradeOpts: UpgradeProxyOptions = { call: { fn: 'increment', args: [] } };
  const validationOpts: ValidationOptions = {
    kind: 'beacon' satisfies ValidationKind,
    unsafeAllow: ['constructor'],
    unsafeAllowRenames: true,
    unsafeSkipStorageCheck: true,
  };
  const implOpts: ImplementationOptions = { pollingInterval: 100, timeout: 1_000 };
  const prepareOpts: PrepareUpgradeOptions = { getTxResponse: true };
  const deployImplOpts: DeployImplementationOptions = { getTxResponse: false };
  const beaconOpts: DeployBeaconOptions = { initialOwner: '0x' };
  const beaconProxyOpts: DeployBeaconProxyOptions = { initializer: false };
  const upgradeBeaconOpts: UpgradeBeaconOptions = { owner: {} };
  const adminOpts: TransferProxyAdminOwnershipOptions = { owner: {}, txOverrides: {} };

  await upgrades.deployProxy('Box', [], deployOpts);
  await upgrades.upgradeProxy('0x', 'Box', upgradeOpts);
  await upgrades.deployBeacon('Box', beaconOpts);
  await upgrades.deployBeaconProxy('0x', 'Box', [], beaconProxyOpts);
  await upgrades.upgradeBeacon('0x', 'Box', upgradeBeaconOpts);
  await upgrades.forceImport('0x', 'Box', validationOpts);
  await upgrades.deployImplementation('Box', deployImplOpts);
  await upgrades.prepareUpgrade('0x', 'Box', prepareOpts);
  upgrades.silenceWarnings();
  await upgrades.validateImplementation('Box', validationOpts);
  await upgrades.validateUpgrade('BoxV1', 'BoxV2', validationOpts);
  await upgrades.erc1967.getImplementationAddress('0x');
  await upgrades.erc1967.getAdminAddress('0x');
  await upgrades.erc1967.getBeaconAddress('0x');
  await upgrades.beacon.getImplementationAddress('0x');
  await upgrades.admin.transferProxyAdminOwnership('0x', '0x', adminOpts);
  const slots: { IMPL_SLOT: string; ADMIN_SLOT: string; BEACON_SLOT: string } = upgrades.trc1967;
  void slots;

  const made: UpgradesAPI = makeUpgrades(undefined as any);
  void made;
  void implOpts;

  const tronUpgradesConfig: TronUpgradesUserConfig = { namespacedCompileErrors: 'warn' };
  void tronUpgradesConfig;
  // @ts-expect-error booleans are no longer a valid namespacedCompileErrors value
  const badTronUpgradesConfig: TronUpgradesUserConfig = { namespacedCompileErrors: true };
  void badTronUpgradesConfig;
}

void surface;
