/**
 * `deployProxy` — the ordered pipeline over the operation toolkit.
 *
 * The order IS the contract (INV-1, INV-16, INV-18, INV-13): validation first,
 * every pre-spend refusal before the queue, exactly one queued step, and the
 * result assembled from the write-back and the channel — never from a queue
 * value. `runDeployProxy` is the whole behaviour; `deployProxy` is the
 * production entry that builds the toolkit around it.
 */

import type { ContractAbstraction } from '../environment';
import { canonicalizeAddress } from '../record';
import {
  assertNoCheatcodeCollision,
  assertFreshTransaction,
  assertSignerMatches,
  ConfirmationIndeterminateError,
  TransactionRevertedError,
  refuseUnlessLinkingAllowed,
  linkedLibraryNames,
} from '../deploy';
import { transactionIdentity, operationNotes } from '../results/types';
import type { DeployedProxy } from '../results/types';
import { PROXY_CONTRACT_NAMES } from './artifacts';
import { ProxyAdminAsOwnerError, StaleProxyRecordError } from './errors';
import { decideDeployReplay } from './replay';
import {
  createOperationToolkit,
  handlesFrom,
  HANDLE_OPTION_KEYS,
  readPriorDeployedAddress,
  readWriteBackHash,
  encodeInitializer,
  type OperationContext,
  type RawOperationOptions,
} from './toolkit';

/** The option keys this operation accepts; anything else is a named refusal. */
export const DEPLOY_PROXY_ACCEPTED_OPTIONS: readonly string[] = [
  ...HANDLE_OPTION_KEYS,
  'kind',
  'initializer',
  'constructorArgs',
  'unsafeAllow',
  'unsafeAllowRenames',
  'unsafeSkipStorageCheck',
  'unsafeAllowCustomTypes',
  'unsafeAllowLinkedLibraries',
  'unsafeSkipProxyAdminCheck',
  'initialOwner',
  'redeployImplementation',
  'useDeployedImplementation',
  'timeout',
  'pollingInterval',
];

function nameOf(contract: ContractAbstraction): string {
  const name = (contract as { contractName?: unknown }).contractName;
  if (typeof name !== 'string' || name === '') {
    throw new Error(
      'deployProxy needs the contract abstraction from artifacts.require(...)',
    );
  }
  return name;
}

/** The pipeline, over an already-built toolkit. Exported for the ordering tests. */
export async function runDeployProxy(
  context: OperationContext,
  contract: ContractAbstraction,
  args: readonly unknown[],
): Promise<DeployedProxy> {
  const { toolkit, resolved } = context;
  const name = nameOf(contract);

  // 1 — validation, before anything else may refuse or spend (INV-1, INV-18).
  const validated = await toolkit.validateImplementation(name, resolved);

  // 2 — the linked-library gate, on the same artifact validation described.
  const bytecodeSource = contract as {
    unlinked_binary?: string;
    bytecode?: string;
  };
  refuseUnlessLinkingAllowed(
    linkedLibraryNames(bytecodeSource.unlinked_binary ?? bytecodeSource.bytecode ?? ''),
    resolved.unsafeAllowLinkedLibraries,
  );

  // 3 — only now may the context's missing deployer refuse (INV-18's order).
  const deployer = toolkit.requireDeployer();

  // 4 — replay recognition, before any spend (INV-9).
  const prior = toolkit.priorDeployedAddress(contract);
  const decision = decideDeployReplay(prior, toolkit.replayVerdicts());
  if (decision.kind === 'refuse') {
    throw new StaleProxyRecordError(decision.address, decision.because);
  }
  if (decision.kind === 'reuse') {
    // The recorded proxy IS the result. The transaction identity is the prior
    // deployment's, read from the host's own write-back memory — and if the
    // artifact does not carry one, `transactionIdentity` refuses rather than
    // fabricating a field a caller would read as this run's.
    const priorHash = readWriteBackHash(contract);
    return Object.freeze({
      contract: await toolkit.contractAt(contract, decision.address),
      // The artifact's own spelling, not the record's canonical form: the
      // result pins `address` tool-verbatim (INV-47), and a replayed run
      // answering a different spelling than the run it replays would fail
      // any caller comparing the two. `prior` is non-null on this branch —
      // a `reuse` decision exists only for a named prior address.
      address: prior as string,
      transaction: transactionIdentity(priorHash, 'deployProxy (reused)'),
      notes: operationNotes(toolkit.channel.recorded),
    });
  }

  // 5 — pre-queue refusals that need no chain (INV-16, INV-11, INV-5's guard).
  assertNoCheatcodeCollision(resolved.constructorArgs);
  const kind = resolved.kind === 'uups' ? 'uups' : 'transparent';
  const abi = (contract as { abi?: readonly unknown[] }).abi ?? [];
  const initData = encodeInitializer(abi, kind, args, resolved.initializer);

  // 6 — the sender, resolved once, threaded to preflight and comparison (INV-12).
  const sender = toolkit.resolveSender();

  // 7 — the proxy artifact (INV-8) and, for transparent, the initialOwner
  //     probe (revert means "not a ProxyAdmin"; transport raises — INV-12).
  const proxyName =
    kind === 'transparent'
      ? PROXY_CONTRACT_NAMES.transparent
      : PROXY_CONTRACT_NAMES.trc1967;
  const proxyAbstraction = toolkit.proxyArtifact(proxyName);
  let initialOwner: string | null = null;
  if (kind === 'transparent') {
    initialOwner =
      resolved.initialOwner !== undefined
        ? canonicalizeAddress(resolved.initialOwner)
        : sender.kind === 'resolved'
          ? canonicalizeAddress(sender.address)
          : null;
    if (
      initialOwner !== null &&
      !resolved.unsafeSkipProxyAdminCheck &&
      (await toolkit.looksLikeProxyAdmin(initialOwner))
    ) {
      throw new ProxyAdminAsOwnerError(initialOwner);
    }
  }

  // 8 — ONE queued step: implementation, proxy, confirmation, verification
  //     (INV-13; INV-3's settlement contract belongs to the queue seam).
  const outcome = await toolkit.queue(deployer, async () => {
    const implementationAddress = await toolkit.fetchOrDeployImplementation(
      validated,
      resolved,
      () => toolkit.hostDeploy(contract, [...resolved.constructorArgs]),
    );

    const priorProxyHash = readWriteBackHash(proxyAbstraction);
    const constructorArgs =
      kind === 'transparent'
        ? [implementationAddress, initialOwner, initData]
        : [implementationAddress, initData];
    const writeBack = await toolkit.hostDeploy(proxyAbstraction, constructorArgs);
    assertFreshTransaction(priorProxyHash, writeBack);

    const verdict = await toolkit.confirm(writeBack.transactionHash);
    if (verdict.kind === 'reverted') {
      throw new TransactionRevertedError(verdict);
    }
    if (verdict.kind === 'indeterminate') {
      throw new ConfirmationIndeterminateError(verdict);
    }

    // INV-13's comparison — and when the node omits the sender, the skip is
    // SAID, through the advisory channel, rather than performed silently.
    const signer = await toolkit.signerOf(writeBack.transactionHash);
    if (signer !== null) {
      assertSignerMatches(sender, signer);
    } else {
      toolkit.channel.warn(
        'sender comparison skipped',
        [
          'the node did not report the transaction sender, so the ' +
            'effective-sender comparison could not run for this deployment',
        ],
      );
    }

    await toolkit.recordProxy(canonicalizeAddress(writeBack.address), kind);
    return writeBack;
  });

  // 8b — the recognition key, completed. The replay module documents the key
  //     as the artifact's per-network write-back, but the queue's OWN
  //     write-backs left the logical contract naming the implementation it
  //     deployed along the way — a replayed migration reading that entry
  //     refuses as unrecorded, and a consumer's `.deployed()` answers the
  //     implementation instead of the proxy. The entry must name the proxy,
  //     address and transaction hash both, mirroring the host action's shape.
  const replayMemory = contract as {
    address?: unknown;
    transactionHash?: unknown;
  };
  replayMemory.address = outcome.address;
  replayMemory.transactionHash = outcome.transactionHash;

  // 9 — the wildcard statement (INV-17): a required effect of the wildcard
  //     path, stated where the user reads output.
  if (toolkit.network.configuredId.syntax === 'wildcard') {
    toolkit.channel.note(
      'wildcard network id',
      [
        `network_id is '*'; this deployment is recorded under the chain's ` +
          `real identity (chain id ${toolkit.session.identity.chainId})`,
      ],
    );
  }

  return Object.freeze({
    contract: await toolkit.contractAt(contract, outcome.address),
    // Tool-verbatim, deliberately not canonicalized (INV-47 of the result
    // contract): the record got the canonical form above.
    address: outcome.address,
    transaction: transactionIdentity(outcome.transactionHash, 'deployProxy'),
    notes: operationNotes(toolkit.channel.recorded),
  });
}

/** The production entry: builds the toolkit, then runs the pipeline. */
export async function deployProxy(
  contract: ContractAbstraction,
  args: readonly unknown[] = [],
  options: RawOperationOptions = {},
): Promise<DeployedProxy> {
  // The record session reconciles only addresses it is given, so the replay
  // decision's verdict exists exactly when the prior address is named here.
  const prior = readPriorDeployedAddress(contract);
  const context = await createOperationToolkit({
    handles: handlesFrom(options),
    rawOptions: options,
    acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
    addresses: prior === null ? [] : [{ address: prior }],
  });
  return runDeployProxy(context, contract, args);
}
