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
import { sealUnavailable } from '../results/limitations';
import type { DeployedBeacon, DeployedProxy, UpgradedProxy } from '../results/types';
import {
  assertNoOptionsInArgsPosition,
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

/**
 * `deployBeacon` deploys (or reuses, per `redeployImplementation`) the
 * implementation and the `UpgradeableBeacon` pointing at it — no proxy, no
 * prior layout. So it accepts the implementation-deploy and validation
 * options, plus `initialOwner` (the beacon's owner is set exactly once,
 * here), but never `initializer` (nothing is initialized: a beacon has no
 * proxy storage of its own).
 *
 * `unsafeAllowRenames`/`unsafeSkipStorageCheck` ARE accepted here, on
 * a corrected understanding from an earlier pass at this list, which had
 * refused them: OUR code never reads them for `deployBeacon` — they reach
 * only `getStorageUpgradeReport` (`assertStorageCompatible`, `toolkit.ts`),
 * which `runDeployBeacon` never calls — but that is the engine ignoring an
 * option for THIS operation, not this operation refusing it. `deployProxy`,
 * `deployImplementation`, `validateImplementation` and `forceImport` all
 * accept the same pair for the identical reason (none of them compares
 * storage either) and none refuses it; singling `deployBeacon` out would
 * diverge from upstream, and from this plugin's own siblings, for no safety
 * gain. Accepting and forwarding the whole coherent `ValidationOptions` bag
 * — refusing only what OUR code itself never looks at — is the rule; see
 * `README.md`'s divergences table for the one row covering this whole group
 * of engine-inert-here options, and `test/toolkit-seam.test.ts` for the
 * execution proof that the pair is genuinely inert for a fresh deploy and
 * genuinely load-bearing for an upgrade's storage comparison.
 */
export const DEPLOY_BEACON_ACCEPTED_OPTIONS: readonly string[] = [
  ...HANDLE_OPTION_KEYS,
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

/**
 * `upgradeBeacon` deploys (or reuses) the new implementation, compares its
 * layout against the beacon's CURRENT one, then dispatches `upgradeTo` — so,
 * unlike `deployBeacon`, it genuinely CONSUMES the
 * `unsafeAllowRenames`/`unsafeSkipStorageCheck` pair `assertStorageCompatible`
 * reads (both operations accept it; only this one's storage comparison
 * actually looks at it). It never accepts `initializer` (an upgrade sends no
 * proxy init call) or `initialOwner` (the beacon's owner is set once, at
 * `deployBeacon`; an upgrade never touches it) — those two ARE genuinely
 * unreachable by OUR code here, unlike the storage-check pair.
 */
export const UPGRADE_BEACON_ACCEPTED_OPTIONS: readonly string[] = [
  ...HANDLE_OPTION_KEYS,
  'constructorArgs',
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

/**
 * `deployBeaconProxy` deploys only the `BeaconProxy` itself, pointing at an
 * ALREADY-deployed beacon — no implementation deploy, no validation, no
 * storage comparison. So it accepts `initializer` (the proxy's own init
 * call) plus the confirmation pair, and none of the implementation-deploy or
 * validation options `deployBeacon`/`upgradeBeacon` need: not
 * `constructorArgs` (no contract deploys here), not `initialOwner` (the
 * proxy has no owner concept of its own), none of the five `unsafeAllow*`
 * validation options (nothing here is ever validated — the beacon was
 * validated when IT was deployed), and not
 * `redeployImplementation`/`useDeployedImplementation` (no implementation
 * fetch-or-deploy decision to make).
 */
export const DEPLOY_BEACON_PROXY_ACCEPTED_OPTIONS: readonly string[] = [
  ...HANDLE_OPTION_KEYS,
  'initializer',
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
    contract: sealUnavailable(
      await toolkit.contractAt(beaconAbstraction, outcome.deployed.address),
    ),
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
    acceptedOptions: DEPLOY_BEACON_ACCEPTED_OPTIONS,
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
    contract: sealUnavailable(
      await toolkit.contractAt(contract, writeBack.address),
    ),
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
  // Refused before anything else — see `deployProxy`'s own guard for why.
  assertNoOptionsInArgsPosition(
    'deployBeaconProxy',
    args,
    DEPLOY_BEACON_PROXY_ACCEPTED_OPTIONS,
  );
  const context = await createOperationToolkit({
    handles: handlesFrom(options),
    rawOptions: options,
    acceptedOptions: DEPLOY_BEACON_PROXY_ACCEPTED_OPTIONS,
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
    contract: sealUnavailable(await toolkit.contractAt(contract, beacon)),
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
    acceptedOptions: UPGRADE_BEACON_ACCEPTED_OPTIONS,
  });
  return runUpgradeBeacon(context, beaconAddress, contract);
}
