/**
 * `forceImport` — adopts proxies, beacons and implementations deployed outside
 * the plugin into the deployment record, so they become upgradeable and
 * validatable through it. The operation that writes the layout every
 * subsequent upgrade validates against — which is why nothing here records
 * without the on-chain comparison passing: a plausible-looking wrong
 * baseline is a silent false negative in every later safety check.
 *
 * Adoption sends nothing: no queue, no deploy, no transaction — reads
 * and record writes only.
 */

import type { ContractAbstraction } from '../environment';
import { canonicalizeAddress } from '../record';
import { operationNotes } from '../results/types';
import { sealUnavailable } from '../results/limitations';
import type { AdoptionOutcome } from '../results/types';
import {
  createOperationToolkit,
  handlesFrom,
  HANDLE_OPTION_KEYS,
  readWriteBackHash,
  type OperationContext,
  type RawOperationOptions,
} from '../proxy/toolkit';
import {
  AdoptionKindMismatchError,
  AdoptionVerificationFailedError,
  NothingToAdoptError,
} from './errors';

export const FORCE_IMPORT_ACCEPTED_OPTIONS: readonly string[] = [
  ...HANDLE_OPTION_KEYS,
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

  // The batched slot read discriminates no-code as its own fact (a
  // TVM node rejects per-slot reads for a no-code address, and the per-slot
  // readers raise on empty slots — both measured), so classification uses the
  // one non-raising instrument.
  const slots = await toolkit.proxySlots(address);
  if (slots.kind === 'no-code') {
    throw new NothingToAdoptError(address);
  }

  let found: AdoptedKind;
  let implementationAddress: string;
  if (slots.beacon !== null) {
    // A beacon PROXY: its implementation lives on the beacon, and the record
    // kind is beacon (scenario 5's "never as a transparent or UUPS proxy").
    found = 'beacon';
    const viaBeacon = await readers.readBeaconImplementation(slots.beacon);
    if (viaBeacon.kind !== 'implementation') {
      throw new NothingToAdoptError(
        address,
        'a beacon proxy whose beacon does not answer implementation()',
      );
    }
    implementationAddress = viaBeacon.address;
  } else if (slots.implementation !== null) {
    found = slots.admin === null ? 'uups' : 'transparent';
    implementationAddress = slots.implementation;
  } else {
    const beaconRead = await readers.readBeaconImplementation(address);
    if (beaconRead.kind === 'implementation') {
      found = 'beacon';
      implementationAddress = beaconRead.address;
    } else {
      found = 'implementation';
      implementationAddress = address;
    }
  }

  // The kind gate, before anything validates or writes.
  if (resolved.kind !== undefined && resolved.kind !== found) {
    throw new AdoptionKindMismatchError(address, found, resolved.kind);
  }

  const validated = await toolkit.validateImplementation(
    nameOf(contract, 'forceImport'),
    { ...resolved, kind: found === 'implementation' ? resolved.kind : found === 'beacon' ? 'beacon' : found },
  );

  // The verification. Empty expected bytecode refuses rather than
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

  // Replay and conflicts, against the existing record.
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
  const implementation = canonicalizeAddress(implementationAddress);

  // This route inherits three engine corner semantics. An invalid stored entry
  // (missing code or an unfindable transaction) is removed, then the wrapper's
  // retry replaces it wholesale with this adoption. An address already primary
  // under a different version key is MERGED by the engine's own address-union
  // (`mergeAddresses`) rather than refused — both entries answer the same
  // address and layout, which is what makes a re-import with corrected
  // `constructorArgs` an ordinary path instead of a clash (the check that used
  // to refuse it runs only with merge off; see the call below). Finally, merge
  // mode starts validation of the stored deployment without awaiting it, so a
  // narrowly stale entry can surface that validation failure as a delayed
  // rejection.
  const simulatedDeploy = async () => ({
    address: implementation,
    // An externally deployed contract may have no host write-back hash. The
    // engine accepts that shape and validates the already-live bytecode.
    transactionHash: readWriteBackHash(contract) ?? undefined,
  });

  // ONE engine call, merge on — Hardhat's own forceImport semantics. Merge
  // off is the only mode that reaches the engine's checkForAddressClash, and
  // on TRON (never a dev-EVM network to the engine's probe) that check turns
  // the harmless re-import of one address under a second version key — e.g.
  // a corrected `constructorArgs` — into a raw, remedy-less clash error.
  // `redeployImplementation: 'always'` is safe HERE and only here because
  // `simulatedDeploy` returns the address already on chain instead of
  // deploying; on a real deploy path the same setting means "deploy fresh
  // every time". Scoped to adoption on purpose — do not generalize.
  await toolkit.fetchOrDeployImplementation(
    validated,
    { ...resolved, redeployImplementation: 'always' },
    simulatedDeploy,
  );

  return Object.freeze({
    kind: found,
    address,
    implementation: implementationAddress,
    contract: sealUnavailable(await toolkit.contractAt(contract, address)),
    notes: operationNotes(toolkit.channel.recorded),
  }) as unknown as AdoptionOutcome;
}

export async function forceImport(
  address: string,
  contract: ContractAbstraction,
  options: RawOperationOptions = {},
): Promise<AdoptionOutcome> {
  const context = await createOperationToolkit({
    handles: handlesFrom(options),
    rawOptions: options,
    acceptedOptions: FORCE_IMPORT_ACCEPTED_OPTIONS,
  });
  return runForceImport(context, address, contract);
}
