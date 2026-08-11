/**
 * `deployProxy` — the ordered pipeline over the operation toolkit.
 *
 * The order IS the contract: validation first,
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
import {
  InitializerDataRequiredError,
  ProxyAdminAsOwnerError,
  StaleProxyRecordError,
} from './errors';
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

  // 1 — validation, before anything else may refuse or spend.
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

  // 3 — the kind, resolved right after validation because inference READS
  //     the validated implementation: an explicit kind is narrowed (never
  //     silently downgraded), an omitted kind is INFERRED — the parity
  //     target resolves an omitted kind through `inferProxyKind` before
  //     anything selects an artifact (`upgrades-core@1.46
  //     dist/proxy-kind.js:34-41`, reached ahead of the implementation
  //     validation), so `deployProxy(BoxUUPS, ...)` with no `kind` deploys a
  //     UUPS proxy, never a silently-transparent one. `toolkit.inferKind` is
  //     the same engine machinery `validateImplementation` just used for its
  //     own error check, so the two resolutions cannot disagree.
  //
  // The two option-resolution helpers load ONLY here, behind a dynamic
  // import of the SAME specifier `toolkit.ts` already uses: `../options/
  // resolve` holds the package's one static engine value-import, so
  // `test/entry-point-closure.test.ts` forbids it from this module's own
  // static closure, and `test/record-structure.test.ts` pins the entry's
  // whole deferred-edge set by exact specifier — a second, differently-
  // spelled dynamic import of the same file (e.g. the `../options` face)
  // would add a distinct edge and fail that pin for no behavioural reason.
  // `resolved` already carries the caller's raw `kind`/`initializer` (Task
  // 1-2's B1 fix) — this call interprets them, it does not re-resolve them.
  const { requireProxyKind, resolveInitializer } = await import(
    '../options/resolve'
  );
  const kind = resolved.kind ?? (await toolkit.inferKind(validated));
  // Never silently downgraded: a caller who names a kind this operation does
  // not support gets a named refusal, not a transparent proxy contradicting
  // what they asked for. The narrowing runs on BOTH paths — an inferred
  // `'beacon'` cannot arrive from the installed engine (`inferProxyKind`
  // answers only 'uups' | 'transparent'; `dist/validate/query.js:174-183`),
  // but the member's type says it could, so it takes the same refusal an
  // explicit one does rather than silently selecting an artifact for it.
  requireProxyKind(kind, ['transparent', 'uups'], 'deployProxy');
  if (kind === 'beacon') {
    // `requireProxyKind` threw above; this is TypeScript's proof of it.
    throw new Error(
      'unreachable: requireProxyKind admits only transparent | uups here',
    );
  }

  // 4 — only now may the context's missing deployer refuse.
  const deployer = toolkit.requireDeployer();

  // 5 — replay recognition, before any spend.
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
      // result pins `address` tool-verbatim, and a replayed run
      // answering a different spelling than the run it replays would fail
      // any caller comparing the two. `prior` is non-null on this branch —
      // a `reuse` decision exists only for a named prior address.
      address: prior as string,
      transaction: transactionIdentity(priorHash, 'deployProxy (reused)'),
      notes: operationNotes(toolkit.channel.recorded),
    });
  }

  // 6 — pre-queue refusals that need no chain.
  assertNoCheatcodeCollision(resolved.constructorArgs);

  // The ported TRC1967Proxy/TransparentUpgradeableProxy reject empty
  // initialization data — safer than upstream's ERC1967Proxy, and a
  // deliberate parity break. An `{ kind: 'none' }` resolution — `initializer:
  // false`, or no arguments and no `initializer` name — is refused BY NAME
  // here, before any spend, rather than left to revert on-chain against the
  // ported proxy.
  const initializerResolution = resolveInitializer(resolved.initializer, args.length);
  if (initializerResolution.kind === 'none') {
    throw new InitializerDataRequiredError(
      name,
      resolved.initializer === false ? 'initializer-false' : 'no-arguments',
    );
  }
  const abi = (contract as { abi?: readonly unknown[] }).abi ?? [];
  // The RESOLUTION's own function name is what gets encoded — never a second,
  // independent derivation of "what initializer name applies here" that
  // could drift from the one `resolveInitializer` just computed.
  const initData = encodeInitializer(abi, kind, args, initializerResolution.fn);

  // 7 — the sender, resolved once, threaded to preflight and comparison.
  const sender = toolkit.resolveSender();

  // 8 — the proxy artifact and, for transparent, the initialOwner
  //     probe (revert means "not a ProxyAdmin"; transport raises).
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

  // 9 — ONE queued step: implementation, proxy, confirmation, verification
  //     (the settlement contract belongs to the queue seam).
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

    // The sender-identity comparison — and when the node omits the sender,
    // the skip is SAID, through the advisory channel, rather than performed
    // silently.
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

  // 9b — the recognition key, completed. The replay module documents the key
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

  // 10 — the wildcard statement: a required effect of the wildcard
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
    // Tool-verbatim, deliberately not canonicalized — a rule of the result
    // contract: the record got the canonical form above.
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
