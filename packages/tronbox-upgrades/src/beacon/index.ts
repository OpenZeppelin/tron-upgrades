/**
 * Beacon workflows: deploy a beacon, deploy a proxy pointing at one, upgrade
 * a beacon so every proxy pointing at it follows. The mechanics reuse the
 * operation toolkit end to end; what is beacon-specific is the assertion that
 * the target actually answers `implementation()` (a non-beacon refuses by
 * name, never by raw revert) and the post-upgrade verification on the beacon
 * itself — every proxy follows precisely because the beacon now answers the
 * new address.
 */

import type { ContractAbstraction } from '../environment';
import { canonicalizeAddress } from '../record';
import {
  ConfirmationIndeterminateError,
  TransactionRevertedError,
} from '../deploy';
import { transactionIdentity, operationNotes } from '../results/types';
import type { DeployedBeacon, DeployedProxy, UpgradedProxy } from '../results/types';
import {
  createOperationToolkit,
  handlesFrom,
  HANDLE_OPTION_KEYS,
  encodeInitializer,
  type OperationContext,
  type RawOperationOptions,
} from '../proxy/toolkit';
import { NothingToAdoptError } from '../adopt/errors';
import {
  BeaconInitialOwnerRequiredError,
  UpgradeVerificationFailedError,
} from '../proxy/errors';
import { isAlreadyCurrent } from '../proxy/replay';

export const BEACON_ACCEPTED_OPTIONS: readonly string[] = [
  ...HANDLE_OPTION_KEYS,
  'initializer',
  'constructorArgs',
  'initialOwner',
  'unsafeAllow',
  'unsafeAllowRenames',
  'unsafeSkipStorageCheck',
  'unsafeAllowCustomTypes',
  'unsafeAllowLinkedLibraries',
  'redeployImplementation',
  'useDeployedImplementation',
  'timeout',
  'pollingInterval',
];

function nameOf(contract: ContractAbstraction, operation: string): string {
  const name = (contract as { contractName?: unknown }).contractName;
  if (typeof name !== 'string' || name === '') {
    throw new Error(
      `${operation} needs the contract abstraction from artifacts.require(...)`,
    );
  }
  return name;
}

async function requireBeacon(
  context: OperationContext,
  beaconAddress: string,
): Promise<string> {
  const read = await context.toolkit.chain.read.readBeaconImplementation(
    beaconAddress,
  );
  if (read.kind !== 'implementation') {
    throw new NothingToAdoptError(
      beaconAddress,
      'an address that does not answer implementation() — not a beacon',
    );
  }
  return read.address;
}

async function confirmOrRefuse(
  context: OperationContext,
  transactionHash: string,
): Promise<void> {
  const verdict = await context.toolkit.confirm(transactionHash);
  if (verdict.kind === 'reverted') {
    throw new TransactionRevertedError(verdict);
  }
  if (verdict.kind === 'indeterminate') {
    throw new ConfirmationIndeterminateError(verdict);
  }
}

/** Deploys an UpgradeableBeacon pointing at the (fetched-or-deployed) implementation. */
export async function runDeployBeacon(
  context: OperationContext,
  contract: ContractAbstraction,
): Promise<DeployedBeacon> {
  const { toolkit, resolved } = context;
  const validated = await toolkit.validateImplementation(
    nameOf(contract, 'deployBeacon'),
    { ...resolved, kind: 'beacon' },
  );
  const deployer = toolkit.requireDeployer();
  const sender = toolkit.resolveSender();
  const owner =
    resolved.initialOwner !== undefined
      ? canonicalizeAddress(resolved.initialOwner)
      : sender.kind === 'resolved'
        ? canonicalizeAddress(sender.address)
        : null;
  // Refused HERE, before any spend: a `null` owner reaching the host is
  // never a usable deploy on either installed TronBox minor (one crashes
  // internally, the other fails ABI-encoding the constructor's `address`
  // argument — see `BeaconInitialOwnerRequiredError`'s doc comment), so this
  // names the real cause and its remedy instead of letting the host's own
  // failure stand in for it.
  if (owner === null) {
    throw new BeaconInitialOwnerRequiredError();
  }
  const beaconAbstraction = toolkit.proxyArtifact('UpgradeableBeacon');

  const outcome = await toolkit.queue(deployer, async () => {
    const implementationAddress = await toolkit.fetchOrDeployImplementation(
      validated,
      resolved,
      () => toolkit.hostDeploy(contract, [...resolved.constructorArgs]),
    );
    const deployed = await toolkit.hostDeploy(beaconAbstraction, [
      implementationAddress,
      owner,
    ]);
    await confirmOrRefuse(context, deployed.transactionHash);
    return { deployed, implementationAddress };
  });

  // The declared result promises every field it names: `contract` is the
  // beacon's own handle (implementation()/upgradeTo/owner ABI), and
  // `implementation` is what the beacon was deployed pointing at.
  return Object.freeze({
    contract: await toolkit.contractAt(beaconAbstraction, outcome.deployed.address),
    address: outcome.deployed.address,
    transaction: transactionIdentity(
      outcome.deployed.transactionHash,
      'deployBeacon',
    ),
    implementation: outcome.implementationAddress,
    notes: operationNotes(toolkit.channel.recorded),
  }) as unknown as DeployedBeacon;
}

export async function deployBeacon(
  contract: ContractAbstraction,
  options: RawOperationOptions = {},
): Promise<DeployedBeacon> {
  const context = await createOperationToolkit({
    handles: handlesFrom(options),
    rawOptions: options,
    acceptedOptions: BEACON_ACCEPTED_OPTIONS,
  });
  return runDeployBeacon(context, contract);
}

/** Deploys a BeaconProxy pointing at an existing beacon. */
export async function runDeployBeaconProxy(
  context: OperationContext,
  beaconAddress: string,
  contract: ContractAbstraction,
  args: readonly unknown[],
): Promise<DeployedProxy> {
  const { toolkit, resolved } = context;
  const beacon = canonicalizeAddress(beaconAddress);

  // The beacon must answer before anything else happens.
  await requireBeacon(context, beacon);

  const abi = (contract as { abi?: readonly unknown[] }).abi ?? [];
  const initData = encodeInitializer(abi, 'beacon', args, resolved.initializer);
  const deployer = toolkit.requireDeployer();
  const proxyAbstraction = toolkit.proxyArtifact('BeaconProxy');

  const writeBack = await toolkit.queue(deployer, async () => {
    const deployed = await toolkit.hostDeploy(proxyAbstraction, [beacon, initData]);
    await confirmOrRefuse(context, deployed.transactionHash);
    // Recorded under the beacon kind, never transparent/uups.
    await toolkit.recordProxy(canonicalizeAddress(deployed.address), 'beacon');
    return deployed;
  });

  return Object.freeze({
    contract: await toolkit.contractAt(contract, writeBack.address),
    address: writeBack.address,
    transaction: transactionIdentity(writeBack.transactionHash, 'deployBeaconProxy'),
    notes: operationNotes(toolkit.channel.recorded),
  }) as unknown as DeployedProxy;
}

export async function deployBeaconProxy(
  beaconAddress: string,
  contract: ContractAbstraction,
  args: readonly unknown[] = [],
  options: RawOperationOptions = {},
): Promise<DeployedProxy> {
  const context = await createOperationToolkit({
    handles: handlesFrom(options),
    rawOptions: options,
    acceptedOptions: BEACON_ACCEPTED_OPTIONS,
  });
  return runDeployBeaconProxy(context, beaconAddress, contract, args);
}

/** Upgrades a beacon; every proxy pointing at it follows. */
export async function runUpgradeBeacon(
  context: OperationContext,
  beaconAddress: string,
  contract: ContractAbstraction,
): Promise<UpgradedProxy> {
  const { toolkit, resolved } = context;
  const beacon = canonicalizeAddress(beaconAddress);

  // The beacon must answer first; then chain-first current state: the layout
  // baseline is keyed by the beacon's own answer, never a contract name.
  const currentImplementation = await requireBeacon(context, beacon);
  const validated = await toolkit.validateImplementation(
    nameOf(contract, 'upgradeBeacon'),
    { ...resolved, kind: 'beacon' },
  );
  const currentLayout = await toolkit.storedLayoutFor(currentImplementation);
  // Rejected before any transaction is sent (scenario 2).
  await toolkit.assertStorageCompatible(currentLayout, validated, resolved);

  const deployer = toolkit.requireDeployer();

  const outcome = await toolkit.queue(deployer, async () => {
    const implementationAddress = await toolkit.fetchOrDeployImplementation(
      validated,
      resolved,
      () => toolkit.hostDeploy(contract, [...resolved.constructorArgs]),
    );
    const writeBack = await toolkit.callThroughFacade({
      facadeName: 'UpgradeableBeacon',
      at: beacon,
      method: 'upgradeTo',
      args: [implementationAddress],
    });
    await confirmOrRefuse(context, writeBack.transactionHash);

    // The beacon itself must now answer the new implementation.
    const observed = await requireBeacon(context, beacon);
    if (!isAlreadyCurrent(observed, implementationAddress)) {
      throw new UpgradeVerificationFailedError(
        beacon,
        implementationAddress,
        observed,
      );
    }
    return { writeBack, implementationAddress };
  });

  return Object.freeze({
    contract: await toolkit.contractAt(contract, beacon),
    address: beacon,
    transaction: transactionIdentity(
      outcome.writeBack.transactionHash,
      'upgradeBeacon',
    ),
    implementation: outcome.implementationAddress,
    notes: operationNotes(toolkit.channel.recorded),
  }) as unknown as UpgradedProxy;
}

export async function upgradeBeacon(
  beaconAddress: string,
  contract: ContractAbstraction,
  options: RawOperationOptions = {},
): Promise<UpgradedProxy> {
  const context = await createOperationToolkit({
    handles: handlesFrom(options),
    rawOptions: options,
    acceptedOptions: BEACON_ACCEPTED_OPTIONS,
  });
  return runUpgradeBeacon(context, beaconAddress, contract);
}
