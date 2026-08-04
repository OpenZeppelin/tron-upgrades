/**
 * `upgradeProxy` — the ordered pipeline over the operation toolkit, with the
 * orderings the sibling adaptation measured and this sub-feature's invariants
 * pin: the beacon check before kind processing (INV-4), the current layout
 * keyed by chain-read address (INV-7), the already-current no-op recognized
 * canonically (INV-10), the authority resolved and the dispatch planned BEFORE
 * the new implementation deploys (INV-2), one queued step (INV-13), and the
 * trust-but-verify slot re-read after the upgrade call (INV-3).
 */

import { Interface } from 'ethers';
import type { ContractAbstraction } from '../environment';
import { canonicalizeAddress } from '../record';
import {
  ConfirmationIndeterminateError,
  TransactionRevertedError,
  refuseUnlessLinkingAllowed,
  linkedLibraryNames,
} from '../deploy';
import { NothingToAdoptError } from '../adopt/errors';
import { transactionIdentity, operationNotes } from '../results/types';
import type { UpgradedProxy } from '../results/types';
import { planUpgradeDispatch } from './dispatch';
import {
  BeaconProxyRefusedError,
  NotTransparentProxyError,
  UpgradeVerificationFailedError,
} from './errors';
import { isAlreadyCurrent } from './replay';
import {
  createOperationToolkit,
  handlesFrom,
  HANDLE_OPTION_KEYS,
  readWriteBackHash,
  encodeInitializer,
  type OperationContext,
  type RawOperationOptions,
} from './toolkit';

export const UPGRADE_PROXY_ACCEPTED_OPTIONS: readonly string[] = [
  ...HANDLE_OPTION_KEYS,
  'kind',
  'call',
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

function nameOf(contract: ContractAbstraction): string {
  const name = (contract as { contractName?: unknown }).contractName;
  if (typeof name !== 'string' || name === '') {
    throw new Error(
      'upgradeProxy needs the new implementation abstraction from artifacts.require(...)',
    );
  }
  return name;
}

function encodeCall(
  abi: readonly unknown[],
  call: OperationContext['resolved']['call'],
): string {
  if (call === undefined) {
    return '0x';
  }
  if (typeof call === 'string' && call.startsWith('0x')) {
    return call;
  }
  const iface = new Interface(abi as never);
  return typeof call === 'string'
    ? iface.encodeFunctionData(call, [])
    : iface.encodeFunctionData(call.fn, [...(call.args ?? [])] as never);
}

/** The pipeline, over an already-built toolkit. Exported for the ordering tests. */
export async function runUpgradeProxy(
  context: OperationContext,
  proxy: string,
  contract: ContractAbstraction,
): Promise<UpgradedProxy> {
  const { toolkit, resolved } = context;
  const name = nameOf(contract);
  const proxyAddress = canonicalizeAddress(proxy);

  // 1 — validation first (INV-1, INV-18), and the linked-library gate with it.
  const validated = await toolkit.validateImplementation(name, resolved);
  const bytecodeSource = contract as {
    unlinked_binary?: string;
    bytecode?: string;
  };
  refuseUnlessLinkingAllowed(
    linkedLibraryNames(bytecodeSource.unlinked_binary ?? bytecodeSource.bytecode ?? ''),
    resolved.unsafeAllowLinkedLibraries,
  );

  // 2 — only now may the missing deployer refuse (INV-18).
  const deployer = toolkit.requireDeployer();

  // 3 — the slots, in ONE non-raising read (the per-slot readers raise on an
  //     empty slot — measured live). The beacon check comes BEFORE kind
  //     processing (INV-4): upstream's kind machinery defaults a record-less
  //     proxy to 'transparent', so a beacon proxy that reaches it gets a
  //     transparent-path upgrade attempt.
  const readers = toolkit.chain.read;
  const slots = await toolkit.proxySlots(proxyAddress);
  if (slots.kind === 'no-code') {
    throw new NothingToAdoptError(proxyAddress);
  }
  if (slots.beacon !== null) {
    throw new BeaconProxyRefusedError(proxyAddress, slots.beacon);
  }
  if (slots.implementation === null) {
    throw new NothingToAdoptError(
      proxyAddress,
      'code with an empty 1967 implementation slot — not a proxy this plugin can upgrade',
    );
  }

  // 4 — the kind, from the engine's own machinery with the record cross-check.
  const kind = await toolkit.processProxyKind(proxyAddress, validated, resolved);

  // 5 — chain first for current state (INV-7): the 1967 slot is the only truth
  //     about what runs now; the manifest supplies the layout FOR that address.
  const currentImplementation = slots.implementation;

  // 6 — the already-current no-op, recognized canonically (INV-10).
  const targetByRecord = toolkit.priorDeployedAddress(contract);
  if (
    targetByRecord !== null &&
    isAlreadyCurrent(currentImplementation, targetByRecord)
  ) {
    return Object.freeze({
      contract: await toolkit.contractAt(contract, proxyAddress),
      address: proxyAddress,
      transaction: transactionIdentity(
        readWriteBackHash(contract),
        'upgradeProxy (already current)',
      ),
      implementation: currentImplementation as string,
      notes: operationNotes(toolkit.channel.recorded),
    });
  }

  // 7 — storage compatibility against the stored layout for the LIVE
  //     implementation (INV-7), before any spend (INV-1's spirit, scenario 2).
  const currentLayout = await toolkit.storedLayoutFor(currentImplementation);
  await toolkit.assertStorageCompatible(currentLayout, validated, resolved);

  // 8 — authority and dispatch BEFORE the new implementation deploys (INV-2):
  //     a mis-routed proxy fails without leaving an orphan implementation.
  const abi = (contract as { abi?: readonly unknown[] }).abi ?? [];
  const callData = encodeCall(abi, resolved.call);
  let adminAddress: string | null = null;
  let probeSubject: string = proxyAddress;
  if (kind === 'transparent') {
    if (slots.admin === null) {
      throw new NotTransparentProxyError(proxyAddress);
    }
    adminAddress = slots.admin;
    probeSubject = slots.admin;
  }
  const interfaceVersion = await readers.readUpgradeInterfaceVersion(probeSubject);
  const plan = planUpgradeDispatch({
    kind,
    interfaceVersion,
    hasCallData: callData !== '0x',
  });

  // 9 — ONE queued step: deploy the implementation, send the dispatched call,
  //     confirm, and re-read the slot (INV-13, INV-3).
  const outcome = await toolkit.queue(deployer, async () => {
    const implementationAddress = await toolkit.fetchOrDeployImplementation(
      validated,
      resolved,
      () => toolkit.hostDeploy(contract, [...resolved.constructorArgs]),
    );

    const writeBack = await toolkit.sendUpgradeCall({
      route: plan.route,
      call: plan.call,
      proxyAddress,
      adminAddress,
      implementationAddress,
      data: plan.carriesData ? callData : '0x',
    });

    const verdict = await toolkit.confirm(writeBack.transactionHash);
    if (verdict.kind === 'reverted') {
      throw new TransactionRevertedError(verdict);
    }
    if (verdict.kind === 'indeterminate') {
      throw new ConfirmationIndeterminateError(verdict);
    }

    // Trust, but verify (INV-3): the slot must now hold the new address —
    // compared canonically, never by spelling.
    const observed = await readers.readImplementationAddress(proxyAddress);
    if (!isAlreadyCurrent(observed, implementationAddress)) {
      throw new UpgradeVerificationFailedError(
        proxyAddress,
        implementationAddress,
        observed,
      );
    }

    return { writeBack, implementationAddress };
  });

  // 10 — record only when no record existed (INV-15).
  const existing = await toolkit.session.getProxyRecord(proxyAddress);
  if (existing === undefined) {
    await toolkit.recordProxy(proxyAddress, kind);
  }

  if (toolkit.network.configuredId.syntax === 'wildcard') {
    toolkit.channel.note(
      'wildcard network id',
      [
        `network_id is '*'; this upgrade is recorded under the chain's real ` +
          `identity (chain id ${toolkit.session.identity.chainId})`,
      ],
    );
  }

  return Object.freeze({
    contract: await toolkit.contractAt(contract, proxyAddress),
    address: proxyAddress,
    transaction: transactionIdentity(
      outcome.writeBack.transactionHash,
      'upgradeProxy',
    ),
    implementation: outcome.implementationAddress,
    notes: operationNotes(toolkit.channel.recorded),
  });
}

/** The production entry: builds the toolkit, then runs the pipeline. */
export async function upgradeProxy(
  proxy: string,
  contract: ContractAbstraction,
  options: RawOperationOptions = {},
): Promise<UpgradedProxy> {
  const context = await createOperationToolkit({
    handles: handlesFrom(options),
    rawOptions: options,
    acceptedOptions: UPGRADE_PROXY_ACCEPTED_OPTIONS,
  });
  return runUpgradeProxy(context, proxy, contract);
}
