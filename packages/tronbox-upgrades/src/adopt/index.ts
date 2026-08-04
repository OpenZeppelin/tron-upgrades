/**
 * `forceImport` — adopts proxies, beacons and implementations deployed outside
 * the plugin into the deployment record, so they become upgradeable and
 * validatable through it. The operation that writes the layout every
 * subsequent upgrade validates against — which is why nothing here records
 * without the on-chain comparison passing (INV-1): a plausible-looking wrong
 * baseline is a silent false negative in every later safety check.
 *
 * Adoption sends nothing (INV-5): no queue, no deploy, no transaction — reads
 * and record writes only.
 */

import type { ContractAbstraction } from '../environment';
import { canonicalizeAddress } from '../record';
import { zeroChainAddress } from '../chain';
import { operationNotes } from '../results/types';
import type { AdoptionOutcome } from '../results/types';
import {
  createOperationToolkit,
  type OperationContext,
  type RawOperationOptions,
} from '../proxy/toolkit';
import {
  AdoptionKindMismatchError,
  AdoptionVerificationFailedError,
  NothingToAdoptError,
} from './errors';

export const FORCE_IMPORT_ACCEPTED_OPTIONS: readonly string[] = [
  'deployer',
  'kind',
  'constructorArgs',
  'unsafeAllow',
  'unsafeAllowRenames',
  'unsafeSkipStorageCheck',
  'unsafeAllowCustomTypes',
  'unsafeAllowLinkedLibraries',
];

export type AdoptedKind = 'transparent' | 'uups' | 'beacon' | 'implementation';

function nameOf(contract: ContractAbstraction, operation: string): string {
  const name = (contract as { contractName?: unknown }).contractName;
  if (typeof name !== 'string' || name === '') {
    throw new Error(
      `${operation} needs the contract abstraction from artifacts.require(...)`,
    );
  }
  return name;
}

/** The pipeline over an already-built toolkit. Exported for the tests. */
export async function runForceImport(
  context: OperationContext,
  addressInput: string,
  contract: ContractAbstraction,
): Promise<AdoptionOutcome> {
  const { toolkit, resolved } = context;
  const address = canonicalizeAddress(addressInput);
  const readers = toolkit.chain.read;

  // INV-3 — the code check FIRST, and by name: a TVM node rejects slot reads
  // for a no-code address instead of answering an empty word, so every
  // classification read below presumes this passed.
  if (!(await readers.hasCode(address))) {
    throw new NothingToAdoptError(address);
  }

  // Classification, from chain state alone (INV-2's premise).
  const implementationSlot = await readers.readImplementationAddress(address);
  const beaconSlot = await readers.readBeaconAddress(address);
  const beaconRead =
    implementationSlot === zeroChainAddress && beaconSlot === zeroChainAddress
      ? await readers.readBeaconImplementation(address)
      : undefined;

  let found: AdoptedKind;
  let implementationAddress: string;
  if (beaconSlot !== zeroChainAddress) {
    // A beacon PROXY: its implementation lives on the beacon, and the record
    // kind is beacon (scenario 5's "never as a transparent or UUPS proxy").
    found = 'beacon';
    const viaBeacon = await readers.readBeaconImplementation(beaconSlot);
    if (viaBeacon.kind !== 'implementation') {
      throw new NothingToAdoptError(
        address,
        'a beacon proxy whose beacon does not answer implementation()',
      );
    }
    implementationAddress = viaBeacon.address;
  } else if (implementationSlot !== zeroChainAddress) {
    const adminSlot = await readers.readAdminAddress(address);
    found = adminSlot === zeroChainAddress ? 'uups' : 'transparent';
    implementationAddress = implementationSlot;
  } else if (beaconRead !== undefined && beaconRead.kind === 'implementation') {
    found = 'beacon';
    implementationAddress = beaconRead.address;
  } else {
    found = 'implementation';
    implementationAddress = address;
  }

  // INV-2 — the kind gate, before anything validates or writes.
  if (resolved.kind !== undefined && resolved.kind !== found) {
    throw new AdoptionKindMismatchError(address, found, resolved.kind);
  }

  const validated = await toolkit.validateImplementation(
    nameOf(contract, 'forceImport'),
    { ...resolved, kind: found === 'implementation' ? resolved.kind : found === 'beacon' ? 'beacon' : found },
  );

  // INV-1 — the verification. Empty expected bytecode refuses rather than
  // matching everything (the vacuity arm).
  const expected = (contract as { deployedBytecode?: unknown }).deployedBytecode;
  if (typeof expected !== 'string' || expected.replace(/^0x/, '') === '') {
    throw new AdoptionVerificationFailedError(
      address,
      'the compiled artifact carries no deployedBytecode to verify against',
    );
  }
  const onChain = (await toolkit.chain.provider.send('eth_getCode', [
    implementationAddress,
    'latest',
  ])) as string;
  if (
    toolkit.hashWithoutMetadata(expected) !==
    toolkit.hashWithoutMetadata(onChain)
  ) {
    throw new AdoptionVerificationFailedError(
      address,
      `the code at ${implementationAddress} is not ${nameOf(contract, 'forceImport')} — ` +
        `recording it would make every later upgrade validate against the wrong baseline`,
    );
  }

  // INV-4 — replay and conflicts, against the existing record.
  const proxyKinds: ReadonlyArray<AdoptedKind> = ['transparent', 'uups', 'beacon'];
  if (proxyKinds.includes(found) && found !== 'beacon') {
    const existing = await toolkit.session.getProxyRecord(address);
    if (existing !== undefined && existing.kind !== found) {
      throw new AdoptionKindMismatchError(address, found, existing.kind as AdoptedKind);
    }
    if (existing === undefined) {
      await toolkit.recordProxy(address, found as 'transparent' | 'uups');
    }
  }

  const versionKey = (validated.version as { linkedWithoutMetadata?: unknown })
    .linkedWithoutMetadata;
  if (typeof versionKey !== 'string' || versionKey === '') {
    throw new Error(
      'internal error: the validated contract carries no version key — ' +
        'this is a bug in @openzeppelin/tronbox-upgrades, please report it',
    );
  }
  await toolkit.session.addImplRecord({
    versionKey,
    address: canonicalizeAddress(implementationAddress),
    layout: validated.layout,
  });

  return Object.freeze({
    kind: found,
    address,
    implementation: implementationAddress,
    contract: await toolkit.contractAt(contract, address),
    notes: operationNotes(toolkit.channel.recorded),
  }) as unknown as AdoptionOutcome;
}

export async function forceImport(
  address: string,
  contract: ContractAbstraction,
  options: RawOperationOptions = {},
): Promise<AdoptionOutcome> {
  const context = await createOperationToolkit({
    handles: { deployer: options.deployer },
    rawOptions: options,
    acceptedOptions: FORCE_IMPORT_ACCEPTED_OPTIONS,
  });
  return runForceImport(context, address, contract);
}
