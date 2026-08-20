/**
 * `deployProxy` — the ordered pipeline over the operation toolkit.
 *
 * The order IS the contract: validation first, every refusal this operation
 * owns before the queue — the reuse-only implementation policy refuses inside
 * the queued step instead, because only the engine's own record lookup can
 * decide it, and it still refuses before that step spends — exactly one
 * queued step, and the
 * result assembled from the write-back and the channel — never from a queue
 * value. `runDeployProxy` is the whole behaviour; `deployProxy` is the
 * production entry that builds the toolkit around it.
 */

import type { ContractAbstraction } from '../environment';
import type { DeployProxyOptions } from '../options/types';
import { canonicalizeAddress } from '../record';
import {
  assertNoCheatcodeCollision,
  assertFreshTransaction,
  assertSignerMatches,
  ConfirmationIndeterminateError,
  TransactionRevertedError,
  refuseUnlessLinkingAllowed,
  linkedLibraryNames,
  serializeOperation,
} from '../deploy';
import { transactionIdentity, operationNotes } from '../results/types';
import { sealUnavailable } from '../results/limitations';
import type { DeployedProxy } from '../results/types';
import { PROXY_CONTRACT_NAMES } from './artifacts';
import {
  EmptyInitializerRefusedError,
  InitialOwnerUnsupportedKindError,
  ProxyAdminAsOwnerError,
  recordingLiveProxy,
  StaleProxyRecordError,
  TransparentInitialOwnerRequiredError,
} from './errors';
import { decideDeployReplay } from './replay';
import {
  assertNoOptionsInArgsPosition,
  createOperationToolkit,
  handlesFrom,
  HANDLE_OPTION_KEYS,
  readPriorDeployedAddress,
  readWriteBack,
  restoreWriteBack,
  restoringWriteBackOnFailure,
  encodeInitializer,
  type OperationContext,
  type MigrationHandles,
} from './toolkit';

/** The option keys this operation accepts; anything else is a named refusal. */
export const DEPLOY_PROXY_ACCEPTED_OPTIONS = [
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
] as const;

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

  // 3b — `initialOwner` names the transparent proxy admin's owner, and a
  //      UUPS proxy has no admin for it to configure: accepting the option
  //      would silently drop the one thing the caller asked for, so it takes
  //      the parity target's own refusal (see the error class) — whether the
  //      kind was explicit or inferred just above, and deterministically:
  //      before the corrupt-record refusal below, so a rerun refuses
  //      identically regardless of what the record decides about a prior
  //      deployment. Beacon was refused by the narrowing already.
  if (kind === 'uups' && resolved.initialOwner !== undefined) {
    throw new InitialOwnerUnsupportedKindError(kind);
  }

  // 4 — only now may the context's missing deployer refuse.
  const deployer = toolkit.requireDeployer();

  // 5 — the corrupt-record refusal, before any spend. `deployProxy` always
  //     deploys a fresh proxy — Hardhat parity; a prior recorded address is
  //     never reused — but if the artifact names a prior address the record
  //     layer cannot vouch for, that refuses rather than letting a new
  //     deploy get recorded beside an already-unaccountable entry.
  const prior = toolkit.priorDeployedAddress(contract);
  const decision = decideDeployReplay(prior, toolkit.replayVerdicts());
  if (decision.kind === 'refuse') {
    // One narrow exception, and only for `unrecorded` (code at the address,
    // no proxy record): the standalone operations write the IMPLEMENTATION
    // address into this same per-network slot through `hostDeploy` and never
    // correct it, so `deployImplementation(Box)` followed by
    // `deployProxy(Box, …)` is an ordinary sequence, not a stale proxy. When
    // the record vouches for the address as an implementation, proceed as a
    // fresh deploy — `fetchOrDeployImplementation` reuses it under its
    // version hash, and this operation's own write-back (step 9b) corrects
    // the slot to the proxy. An address the record knows in NEITHER role
    // keeps refusing, exactly as before: this exception never widens to
    // "not a recorded proxy, so proceed".
    const knownImplementation =
      decision.because === 'unrecorded'
        ? await toolkit.session.getImplRecord(decision.address)
        : undefined;
    if (knownImplementation === undefined) {
      throw new StaleProxyRecordError(decision.address, decision.because);
    }
  }

  // 6 — pre-queue refusals that need no chain.
  assertNoCheatcodeCollision(resolved.constructorArgs);

  // The ported TRC1967Proxy/TransparentUpgradeableProxy reject empty
  // initialization data — safer than upstream's ERC1967Proxy, and a
  // deliberate parity break. An `{ kind: 'none' }` resolution — only an
  // explicit `initializer: false` produces one, now that the omitted case
  // follows the parity target's TRY-FIRST rule — is refused BY NAME here,
  // before any spend, rather than left to revert on-chain against the ported
  // proxy. An OMITTED initializer resolves to `'initialize'` whatever the
  // argument count; whether the contract HAS one is the ABI's decision
  // inside `encodeInitializer`, whose fragment-absent arm is where the
  // empty-data refusal belongs.
  const initializerResolution = resolveInitializer(resolved.initializer, args.length);
  if (initializerResolution.kind === 'none') {
    throw new EmptyInitializerRefusedError(kind, 'initializer-false');
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
    // Before the queue, where the value is computed: a null owner used to
    // sail into the queued step and fail in the host's ABI encoder AFTER the
    // implementation deploy — see the error class for the measurement.
    if (initialOwner === null) {
      throw new TransparentInitialOwnerRequiredError();
    }
    if (
      !resolved.unsafeSkipProxyAdminCheck &&
      (await toolkit.looksLikeProxyAdmin(initialOwner))
    ) {
      throw new ProxyAdminAsOwnerError(initialOwner);
    }
  }

  // 9 — ONE queued step: implementation, proxy, confirmation, verification
  //     (the settlement contract belongs to the queue seam). The step deploys
  //     the implementation through the USER's contract, so any failing exit —
  //     not only a revert — must put the user's write-back BACK, or the
  //     artifact leaves the migration naming the implementation (review
  //     comment on #18). Step 9b below is the success half of the same rule.
  const outcome = await toolkit.queue(deployer, () =>
    restoringWriteBackOnFailure(contract, async () => {
    const implementationAddress = await toolkit.fetchOrDeployImplementation(
      validated,
      resolved,
      () => toolkit.hostDeploy(contract, [...resolved.constructorArgs]),
    );

    // Both write-back fields, not just the hash: the hash is what
    // `assertFreshTransaction` compares, and the pair is what a reverted
    // confirmation has to put back.
    const priorWriteBack = readWriteBack(proxyAbstraction);
    const constructorArgs =
      kind === 'transparent'
        ? [implementationAddress, initialOwner, initData]
        : [implementationAddress, initData];
    const writeBack = await toolkit.hostDeploy(proxyAbstraction, constructorArgs);
    assertFreshTransaction(priorWriteBack.transactionHash, writeBack);

    // The proxy exists on-chain from here on, whatever the verdict says. Every
    // refusal below this line names it, because every one of them fires after
    // the spend and the recovery takes the address as its argument.
    const live = {
      address: canonicalizeAddress(writeBack.address),
      transactionHash: writeBack.transactionHash,
    };

    const verdict = await toolkit.confirm(writeBack.transactionHash);
    if (verdict.kind === 'reverted') {
      // The one exception, and it is not an exception to the rule: a mined
      // revert deployed nothing, so there is no on-chain fact to name — and the
      // write-back `hostDeploy` assigned must not survive into the artifact the
      // host persists after the migration.
      restoreWriteBack(proxyAbstraction, priorWriteBack);
      throw new TransactionRevertedError(verdict);
    }
    if (verdict.kind === 'indeterminate') {
      throw new ConfirmationIndeterminateError(verdict, live);
    }

    // The sender-identity comparison — and when the node omits the sender,
    // the skip is SAID, through the advisory channel, rather than performed
    // silently.
    const signer = await toolkit.signerOf(writeBack.transactionHash);
    if (signer !== null) {
      assertSignerMatches(sender, signer, live);
    } else {
      toolkit.channel.warn(
        'sender comparison skipped',
        [
          'the node did not report the transaction sender, so the ' +
            'effective-sender comparison could not run for this deployment',
        ],
      );
    }

    await recordingLiveProxy(live, () =>
      toolkit.recordProxy(live.address, kind),
    );
    return writeBack;
    }),
  );

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
    contract: sealUnavailable(
      await toolkit.contractAt(contract, outcome.address),
    ),
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
  options: DeployProxyOptions & MigrationHandles = {},
): Promise<DeployedProxy> {
  // Refused before anything else, including the toolkit build: the dropped
  // positional-overloads shape must never reach the record session or the
  // environment resolver.
  assertNoOptionsInArgsPosition('deployProxy', args, DEPLOY_PROXY_ACCEPTED_OPTIONS);
  return serializeOperation('deployProxy', options.deployer, async () => {
    // Read inside the serialization slot, not at call time: a queued
    // predecessor may deploy through this same abstraction, and its
    // write-back must be visible here. The record session reconciles only
    // addresses it is given, so the replay decision's verdict exists exactly
    // when the prior address is named below — a pre-slot capture would seed
    // the session without the predecessor's address, and the decision's own
    // fresh read (step 5) would then refuse a perfectly recorded proxy with
    // 'no-verdict'.
    const prior = readPriorDeployedAddress(contract);
    const context = await createOperationToolkit({
      handles: handlesFrom(options),
      rawOptions: options,
      acceptedOptions: DEPLOY_PROXY_ACCEPTED_OPTIONS,
      addresses: prior === null ? [] : [{ address: prior }],
    });
    return runDeployProxy(context, contract, args);
  });
}
