/**
 * The operation toolkit: every capability the two proxy operations consume,
 * behind one injectable seam.
 *
 * Two reasons it exists, both structural:
 *
 * 1. **The ordering invariants are properties of call sequences**, so the
 *    tests that pin them need a fake whose log IS the assertion. A toolkit
 *    interface makes the fake one object literal instead of a module-mocking
 *    exercise.
 * 2. **The engine may not load at import time.** The production factory does
 *    the three dynamic imports the closure rule requires (`../options/resolve`
 *    and `../validation-input` each hold a static engine value-import; the
 *    engine itself is the third) — and it does them *after*
 *    `configureRecordLocation` has run inside `openRecord`, which is the
 *    whole point of deferring.
 *
 * Everything else the operations touch is statically engine-free and imported
 * through its face: the environment seam, the chain seam, the record face, the
 * validation pipeline, and the deployment seam.
 */

import {
  resolveEnvironment,
  type ArtifactAccess,
  type ContractAbstraction,
  type NetworkEnvironment,
  type RawMigrationHandles,
  type SlotShapes,
} from '../environment';
import { createOutputChannel } from '../output/channel';
import type { OutputChannel } from '../output/types';
import type { ContractHandle } from '../results/types';
import { createChainAccess, type ChainAccess } from '../chain';
import {
  configureRecordLocation,
  openRecord,
  canonicalizeAddress,
} from '../record';
import type { ProxyRecordVerdict, RecordSession } from '../record';
import type { ValidationInput } from '../validation-input';
import {
  assertFullyLinked,
  assertNoCheatcodeCollision,
  confirmTransaction,
  resolveEffectiveSender,
  runThroughQueue,
  DeployerAbsentError,
  type BoundWait,
  type ConfirmationVerdict,
  type EffectiveSender,
  type QueueHost,
  type WriteBack,
} from '../deploy';
import { Interface } from 'ethers';
import { requireProxyArtifact } from './artifacts';
import {
  EmptyInitializerRefusedError,
  ImplementationNotPreviouslyDeployedError,
  OptionsInArgsPositionError,
} from './errors';
import type { UpgradeOptions } from '../options/types';
import { captureEngineWarnings } from '../output/engine';

/** The subset of a resolved options object the operations read here. */
export interface ResolvedForProxyOps {
  readonly kind: 'transparent' | 'uups' | 'beacon' | undefined;
  readonly initializer: string | false | undefined;
  readonly constructorArgs: readonly unknown[];
  readonly redeployImplementation: 'always' | 'never' | 'onchange';
  readonly unsafeAllowLinkedLibraries: boolean;
  readonly unsafeSkipProxyAdminCheck: boolean;
  readonly initialOwner: string | undefined;
  readonly call:
    | string
    | { readonly fn: string; readonly args?: readonly unknown[] }
    | undefined;
  /** Handed to the engine verbatim through its own defaults machinery. */
  readonly engineOptions: Record<string, unknown>;
}

/** A validated implementation: what the engine needs later, plus provenance. */
export interface ValidatedImplementation {
  readonly name: string;
  readonly input: ValidationInput;
  /** Engine values, opaque here: `validate()`'s run data and `getVersion`'s result. */
  readonly validations: unknown;
  readonly version: unknown;
  readonly layout: unknown;
  readonly encodedArgs: string;
}

/**
 * What the operations consume. Production wiring in
 * {@link createOperationToolkit}; the ordering tests inject a recording fake.
 */
export interface OperationToolkit {
  readonly network: NetworkEnvironment;
  readonly artifacts: ArtifactAccess;
  /** The operation's channel: notes recorded here ride the result. */
  readonly channel: OutputChannel;
  readonly session: RecordSession;
  readonly chain: ChainAccess;

  /** Contract-call access at an address, over the host's public `.at` surface. */
  contractAt(
    abstraction: ContractAbstraction,
    address: string,
  ): Promise<ContractHandle>;

  /** The validation step: runs first, refuses on an unsafe implementation. */
  validateImplementation(
    contractName: string,
    resolved: ResolvedForProxyOps,
  ): Promise<ValidatedImplementation>;

  /** The deployer gate: consulted only AFTER validation; throws `DeployerAbsentError`. */
  requireDeployer(): QueueHost;

  /** The operation's single queued step. */
  queue<T>(host: QueueHost, step: () => Promise<T> | T): Promise<T>;

  /** The artifact write-back, read from the host's public surface (never internals). */
  priorDeployedAddress(contract: ContractAbstraction): string | null;
  replayVerdicts(): readonly ProxyRecordVerdict[];

  resolveSender(): EffectiveSender;
  /** `eth_getTransactionByHash().from`, canonicalized; `null` when the node omits it. */
  signerOf(transactionHash: string): Promise<string | null>;

  proxyArtifact(name: string): ContractAbstraction;
  looksLikeProxyAdmin(address: string): Promise<boolean>;

  /**
   * The implementation deploy on the upgrade path: routed
   * through the engine's `fetchOrDeployGetDeployment` so replay reuse is
   * upstream's own. `deploy` runs only when the record has no live entry —
   * unless `redeployImplementation: 'always'` is in effect, which forces it
   * regardless of what is already recorded.
   */
  fetchOrDeployImplementation(
    validated: ValidatedImplementation,
    resolved: ResolvedForProxyOps,
    deploy: () => Promise<{
      readonly address: string;
      readonly transactionHash: string | undefined;
    }>,
  ): Promise<string>;

  /** `contract.new(...)` on the host abstraction, returning the write-back. */
  hostDeploy(
    abstraction: ContractAbstraction,
    args: readonly unknown[],
  ): Promise<WriteBack>;

  confirm(transactionHash: string): Promise<ConfirmationVerdict>;

  /** Engine `hashBytecodeWithoutMetadata` — the adoption verification's hash. */
  hashWithoutMetadata(bytecode: string): string;

  /** Engine `inferProxyKind` over a validated implementation (reference side). */
  inferKind(
    validated: ValidatedImplementation,
  ): Promise<'transparent' | 'uups' | 'beacon'>;

  /** Engine `processProxyKind` over the deployed proxy (upgrade path). */
  processProxyKind(
    proxyAddress: string,
    validated: ValidatedImplementation,
    resolved: ResolvedForProxyOps,
  ): Promise<'transparent' | 'uups'>;

  /** The stored layout FOR an address (never a name), or a named refusal. */
  storedLayoutFor(implementationAddress: string): Promise<unknown>;

  /** Engine storage report between two layouts; throws a refusal on incompatibility. */
  assertStorageCompatible(
    currentLayout: unknown,
    validated: ValidatedImplementation,
    resolved: ResolvedForProxyOps,
  ): Promise<void>;

  /**
   * A state-changing call through a plugin-shipped facade attached at an
   * address, returning the write-back. The one txid-extraction site.
   */
  callThroughFacade(request: {
    readonly facadeName: string;
    readonly at: string;
    readonly method: string;
    readonly args: readonly unknown[];
  }): Promise<WriteBack>;

  /** `owner()` via the optional-call reader; `null` when nothing answers. */
  ownerOf(address: string): Promise<string | null>;

  /**
   * The three 1967 slots in one non-raising read: `null` means a zero word,
   * `no-code` is its own fact. The per-slot readers RAISE on an empty slot —
   * measured on the first live upgrade — so classification always goes
   * through this.
   */
  proxySlots(address: string): Promise<
    | { readonly kind: 'no-code' }
    | {
        readonly kind: 'code';
        readonly implementation: string | null;
        readonly admin: string | null;
        readonly beacon: string | null;
      }
  >;

  /** The dispatched upgrade call, sent through the host (upgrade path). */
  sendUpgradeCall(request: {
    readonly route: 'admin-v5' | 'admin-v4' | 'uups-v5' | 'uups-pre5';
    readonly call: string;
    readonly proxyAddress: string;
    readonly adminAddress: string | null;
    readonly implementationAddress: string;
    readonly data: string;
  }): Promise<WriteBack>;

  recordProxy(
    address: string,
    kind: 'transparent' | 'uups' | 'beacon',
  ): Promise<void>;
}

/** What an operation entry point receives beyond the user's own arguments. */
export interface OperationContext {
  readonly toolkit: OperationToolkit;
  readonly resolved: ResolvedForProxyOps;
}

/** Options every operation accepts at minimum; the per-operation lists extend it. */
export interface RawOperationOptions {
  readonly deployer?: unknown;
  readonly artifacts?: unknown;
  readonly tronWrap?: unknown;
  readonly tronWeb?: unknown;
  readonly waitForTransactionReceipt?: unknown;
  readonly [key: string]: unknown;
}

/**
 * The migration-scope handles, lifted off the options object. TronBox's
 * migration sandbox provides exactly these as file-scope globals — the host's
 * Migrate component builds the context `{ tronWrap, tronWeb,
 * waitForTransactionReceipt }` on top of Require's `artifacts` — and
 * `RawMigrationHandles` mirrors that sandbox by design, so a migration passes
 * what it already holds:
 *
 *   const handles = { deployer, artifacts, tronWrap, waitForTransactionReceipt };
 *   await deployProxy(Box, [42], handles);
 */
export function handlesFrom(options: RawOperationOptions): RawMigrationHandles {
  return {
    deployer: options.deployer,
    artifacts: options.artifacts,
    tronWrap: options.tronWrap,
    tronWeb: options.tronWeb,
    waitForTransactionReceipt: options.waitForTransactionReceipt,
  };
}

/** The five handle keys, accepted by every operation's option list. */
export const HANDLE_OPTION_KEYS: readonly string[] = [
  'deployer',
  'artifacts',
  'tronWrap',
  'tronWeb',
  'waitForTransactionReceipt',
];

/**
 * Refuses the dropped positional-overloads shape: `args` must be an array.
 * The old Hardhat/Truffle-shaped API also accepted an options object in this
 * position (`deployProxy(Contract, opts)`), and silently reinterpreting one
 * as the argument list is worse than a compile error would have been — it is
 * either a confusing native `TypeError` a few calls downstream, or a value
 * that quietly encodes wrong. Called BEFORE anything else, in every operation
 * that takes a positional `args`, so the refusal is the very first thing a
 * caller who fell into the old habit sees.
 *
 * `acceptedOptions` is used only to make the message MORE specific when it
 * can — whether `args` happens to carry a key the operation would have
 * accepted as an option — never to change whether this throws: a non-array
 * `args` is refused unconditionally.
 */
export function assertNoOptionsInArgsPosition(
  operation: string,
  args: unknown,
  acceptedOptions: readonly string[],
): void {
  if (Array.isArray(args)) {
    return;
  }
  const looksLikeOptions =
    typeof args === 'object' &&
    args !== null &&
    acceptedOptions.some(key => key in (args as Record<string, unknown>));
  throw new OptionsInArgsPositionError(operation, typeof args, looksLikeOptions);
}

/**
 * Encodes initializer data over the abstraction's public `abi`. `'0x'` is a
 * refusal, not a value: the ported TRC1967Proxy rejects empty
 * initialization data for both kinds.
 */
export function encodeInitializer(
  abi: readonly unknown[],
  kind: string,
  args: readonly unknown[],
  initializer: string | false | undefined,
): string {
  if (initializer === false) {
    throw new EmptyInitializerRefusedError(kind, 'initializer-false');
  }
  // A static import, deliberately: ethers is already a static runtime import
  // of the record layer, and a constructed `require` here would widen the one
  // site the import-boundary scan's instrument permits.
  const iface = new Interface(abi as never);
  const name = initializer ?? 'initialize';
  const fragment = iface.getFunction(name, [...args] as never);
  if (fragment === null) {
    throw new EmptyInitializerRefusedError(kind, 'no-default-initializer');
  }
  const data = iface.encodeFunctionData(fragment, [...args] as never);
  if (data === '0x') {
    throw new EmptyInitializerRefusedError(kind, 'no-default-initializer');
  }
  return data;
}

/**
 * A guarded read of a class abstraction's write-back fields: the host's
 * getters route through `this.network`, which THROWS for a contract with no
 * per-network entry yet — measured on the first live run. Absence is a value
 * here, never an exception.
 */
export function readWriteBackHash(contract: ContractAbstraction): string | null {
  try {
    const hash = (contract as { transactionHash?: unknown }).transactionHash;
    return typeof hash === 'string' && hash !== '' ? hash : null;
  } catch {
    return null;
  }
}

/** The abstraction's public deployed-address surface, guarded. */
export function readPriorDeployedAddress(
  contract: ContractAbstraction,
): string | null {
  const candidate = contract as {
    isDeployed?: () => boolean;
    address?: unknown;
  };
  if (typeof candidate.isDeployed !== 'function') {
    return null;
  }
  let deployed = false;
  try {
    deployed = candidate.isDeployed() === true;
  } catch {
    return null;
  }
  if (!deployed) {
    return null;
  }
  return typeof candidate.address === 'string' ? candidate.address : null;
}

const VALIDATE_ONLY_SLOTS = [
  'paths',
  'network',
  'artifacts',
  'output',
  'compiler',
] as const;

const REQUIRED_SLOTS = [
  'paths',
  'network',
  'artifacts',
  'chain',
  'receipts',
  'output',
  'compiler',
] as const;

type OperationEnvironment = Pick<
  SlotShapes,
  (typeof VALIDATE_ONLY_SLOTS)[number]
> & {
  readonly chain?: SlotShapes['chain'];
  readonly receipts?: SlotShapes['receipts'];
  readonly scheduling?: SlotShapes['scheduling'];
};

/**
 * The production toolkit. The engine and the option resolver load *inside*
 * this call — after `openRecord` has configured the record location — which is
 * the deferred-import pattern the entry-closure guard enforces.
 */
export async function createOperationToolkit(request: {
  readonly handles: RawMigrationHandles;
  readonly rawOptions: RawOperationOptions;
  readonly acceptedOptions: readonly string[];
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * `'validate-only'` resolves no chain, no receipts, no scheduling and opens
   * no record — an operation that changes nothing creates nothing, and the CI
   * context this mode exists for must not be refused for lacking what
   * validation never uses. The record LOCATION is still configured before the
   * engine loads, in both modes: the engine reads it once at module scope, so
   * a validate-only call that skipped it would silently poison every later
   * state-changing call in the same process.
   */
  readonly mode?: 'state-changing' | 'validate-only';
  /**
   * The addresses this operation is about to act on, passed through to the
   * record session verbatim: the session produces a reconciliation verdict
   * only for addresses named here (it cannot enumerate proxies it has no
   * record of), so an operation whose replay decision reads
   * `replayVerdicts()` must name its prior address or the decision sees an
   * empty report and refuses a perfectly recorded proxy.
   */
  readonly addresses?: readonly { address: string }[];
}): Promise<OperationContext> {
  const mode = request.mode ?? 'state-changing';
  const processEnv = request.processEnv ?? process.env;

  const env = resolveEnvironment(request.handles, {
    require:
      mode === 'validate-only' ? VALIDATE_ONLY_SLOTS : REQUIRED_SLOTS,
    optional:
      mode === 'validate-only'
        ? ([] as const)
        : (['scheduling'] as const),
  }) as unknown as OperationEnvironment;

  const channel = createOutputChannel(env.output);

  const notInThisMode = (member: string) => (): never => {
    throw new Error(
      `internal error: ${member} was reached from a validate-only operation — ` +
        `this is a bug in @openzeppelin/tronbox-upgrades, please report it`,
    );
  };

  configureRecordLocation(env.paths.root, processEnv);

  const chain =
    mode === 'validate-only'
      ? undefined
      : await createChainAccess(env.chain as never, { env: processEnv });
  const session =
    mode === 'validate-only' || chain === undefined
      ? undefined
      : await openRecord({
          root: env.paths.root,
          env: processEnv,
          chain,
          addresses: request.addresses ?? [],
        });

  // The deferred loads, in one place — every module whose static closure
  // reaches the engine: `options/resolve` and `validation-input/identity`
  // both hold engine value-imports (the entry-closure guard found the second
  // one the day the operations were wired), plus the engine itself.
  const optionsModule = await import('../options/resolve');
  const validationInput = await import('../validation-input');
  const engine = await import('@openzeppelin/upgrades-core');

  const resolvedOptions = optionsModule.resolveUpgradeOptions(
    // The one assertion on this seam, documented here: `rawOptions` is the
    // migration's own object, typed as an index-signature bag because a
    // JavaScript caller can pass any key with any value, so it cannot satisfy
    // the resolver's typed parameter structurally. The resolver validates
    // every accepted key and value at runtime before anything reads them —
    // the assertion claims nothing the next call does not immediately check —
    // and the parameter stays `UpgradeOptions` so typed API callers keep
    // their compile-time refusals (`{ kind: 'diamond' }` does not compile).
    request.rawOptions as UpgradeOptions,
    request.acceptedOptions,
  );
  const resolved: ResolvedForProxyOps = {
    kind: resolvedOptions.kind,
    initializer: resolvedOptions.initializer,
    constructorArgs: resolvedOptions.constructorArgs,
    redeployImplementation: resolvedOptions.redeployImplementation,
    // One level DOWN from the rest, deliberately: the flag lives on the
    // upstream-shaped validation object, where `withValidationDefaults`
    // derives it from an `unsafeAllow` grant. Reading it at the top level is
    // exactly the mistake the old cast-based mapping made (B1).
    unsafeAllowLinkedLibraries:
      resolvedOptions.validation.unsafeAllowLinkedLibraries,
    unsafeSkipProxyAdminCheck: resolvedOptions.unsafeSkipProxyAdminCheck,
    initialOwner: resolvedOptions.initialOwner,
    call: resolvedOptions.call,
    engineOptions: optionsModule.engineValidationOptions(resolvedOptions),
  };

  const requireChain = (): ChainAccess => {
    if (chain === undefined) {
      notInThisMode('chain access')();
    }
    return chain as ChainAccess;
  };
  const requireSession = (): RecordSession => {
    if (session === undefined) {
      notInThisMode('the record session')();
    }
    return session as RecordSession;
  };
  const stub = <T,>(name: string): T =>
    new Proxy(
      {},
      { get: (_target, property) => notInThisMode(`${name}.${String(property)}`)() },
    ) as T;

  const wait: BoundWait = (hash, intervalMs, maxRetries) => {
    if (env.receipts === undefined) {
      return Promise.reject(
        new Error(notInThisMode('the confirmation wait').name),
      );
    }
    return Promise.resolve(
      (env.receipts.waitForTransactionReceipt as (...args: unknown[]) => unknown)(
        hash,
        intervalMs,
        maxRetries,
      ),
    );
  };

  const toolkit: OperationToolkit = {
    network: env.network,
    artifacts: env.artifacts,
    channel,
    session: session ?? stub<RecordSession>('session'),
    chain: chain ?? stub<ChainAccess>('chain'),

    async contractAt(abstraction, address) {
      const attachable = abstraction as {
        at?: (target: string) => Promise<unknown> | unknown;
      };
      if (typeof attachable.at !== 'function') {
        throw new Error(
          'the contract abstraction has no `.at` surface in this context',
        );
      }
      return (await attachable.at(address)) as ContractHandle;
    },

    async validateImplementation(contractName, resolvedOptions) {
      const outcome = await validationInput.deriveValidationInput({
        contract: contractName,
        env: { ...env, output: channel } as never,
      });
      if (outcome.kind === 'refused') {
        throw new validationInput.ValidationInputRefusedError(
          outcome.cause as never,
          outcome.diagnosis as never,
        );
      }
      const input = outcome.input;
      const decoder = engine.solcInputOutputDecoder(
        input.solcInput as never,
        input.solcOutput as never,
      );
      const validations = captureEngineWarnings(channel, 'validate', () =>
        engine.validate(
          input.solcOutput as never,
          decoder,
          input.solcVersion,
          input.solcInput as never,
        ),
      );
      const resolution = env.artifacts.resolve(contractName);
      if (resolution.status !== 'unique') {
        // The operation's own statement for the collision the validation
        // pipeline deliberately proceeds through in silence (see
        // `validation-input/pipeline.ts:artifactAbstraction`, whose own doc
        // comment names this call site as the one that owns it) — recorded
        // here rather than there so the disclosure has exactly one source.
        channel.degraded({
          code: 'artifact-name-indeterminate',
          summary: `${contractName}: the build-info index could not be built, so artifact-name collisions could not be checked.`,
          detail: ['The abstraction still came from the host resolver for this exact name.'],
          remedy: 'Run `tronbox compile --all` to rebuild the build-info directory, or rename the colliding contract.',
        });
      }
      const abstraction =
        resolution.status === 'unique'
          ? resolution.contract
          : resolution.unverifiedContract;
      const record = env.artifacts.record(abstraction);
      if (record.status !== 'complete') {
        throw new Error(
          `the compiled artifact for ${contractName} is missing fields the ` +
            `deployment needs (${record.status}); recompile with ` +
            '`tronbox compile`',
        );
      }
      const bytecode = record.record.bytecode;
      const unlinked = engine.getUnlinkedBytecode(validations as never, bytecode);
      const abi = (abstraction as { abi?: readonly unknown[] }).abi ?? [];
      const encodedArgs = new Interface(abi as never).encodeDeploy(
        [...resolvedOptions.constructorArgs] as never,
      );
      const version = engine.getVersion(unlinked, bytecode, encodedArgs);
      /*
       * The kind `getErrors` judges with: the caller's, or — omitted — the
       * engine's own inference over the run data just derived. This mirrors
       * the parity target's ordering, where `processProxyKind` resolves the
       * kind BEFORE the error check runs (`upgrades-core@1.46
       * dist/proxy-kind.js:34-41` falls back to `inferProxyKind` for a
       * proxy-less deploy) — never a fabricated `'transparent'`, which would
       * suppress the uups-only `missing-public-upgradeto` judgement for every
       * caller who chose no kind (`dist/validate/overrides.js:86-88` filters
       * that error for transparent/beacon). At 1.46 the substitution is
       * provably invisible in the output — `inferProxyKind` answers `'uups'`
       * only when the upgrade entry point exists
       * (`dist/validate/query.js:170-183`), exactly the case where
       * `getErrors` never records the error (`query.js:138-144`) — but the
       * exactness is what keeps a future kind-gated judgement from silently
       * diverging. Same machinery as `inferKind` below, so the two cannot
       * disagree.
       */
      const kindForErrors =
        resolvedOptions.kind ??
        engine.inferProxyKind(validations as never, version as never);
      const errors = captureEngineWarnings(channel, 'getErrors', () =>
        engine.getErrors(
          validations as never,
          version as never,
          {
            ...resolvedOptions.engineOptions,
            kind: kindForErrors,
          } as never,
        ),
      );
      if (errors.length > 0) {
        const report = new engine.UpgradeableContractErrorReport(errors as never);
        throw new Error(
          `${contractName} is not upgrade-safe:\n${report.explain()}`,
        );
      }
      return {
        name: contractName,
        input,
        validations,
        version,
        layout: engine.getStorageLayout(validations as never, version as never),
        encodedArgs,
      };
    },

    requireDeployer() {
      const scheduling = env.scheduling;
      if (scheduling === undefined) {
        throw new DeployerAbsentError('scheduling');
      }
      return scheduling.deployer as QueueHost;
    },

    queue: (host, step) => runThroughQueue(host, step),

    priorDeployedAddress: readPriorDeployedAddress,
    replayVerdicts: () => requireSession().report.proxies,

    resolveSender: () => resolveEffectiveSender(env.network.sender),

    async signerOf(transactionHash) {
      try {
        const transaction = (await requireChain().provider.send('eth_getTransactionByHash', [
          transactionHash,
        ])) as { from?: unknown } | null;
        const from = transaction?.from;
        return typeof from === 'string' && from !== ''
          ? canonicalizeAddress(from)
          : null;
      } catch {
        return null;
      }
    },

    proxyArtifact: name => requireProxyArtifact(env.artifacts, name),

    looksLikeProxyAdmin: address =>
      requireChain().read.looksLikeProxyAdmin(address),

    async fetchOrDeployImplementation(validated, resolvedOptions, deploy) {
      const fetch = () =>
        engine.fetchOrDeployGetDeployment(
          validated.version as never,
          requireChain().provider as never,
          async () => {
            // The `'never'` gate, at the single choke point every consumer of
            // this method shares (`deployProxy`, `upgradeProxy`, the beacon
            // and standalone operations, and — inertly — `forceImport`'s
            // adoption probe, which always overrides this field before
            // calling in). This callback is `engine.fetchOrDeployGetDeployment`'s
            // OWN `deploy` argument, invoked only after ITS cache lookup
            // already found nothing valid to reuse — so a genuinely
            // recorded implementation for this exact version is fetched and
            // returned above this closure, never reaching it, and the throw
            // below happens before any host spend. Mirrors the parity
            // target's mechanism, not its class: see
            // `ImplementationNotPreviouslyDeployedError`'s own doc comment
            // for the read `hardhat-tron-upgrades` source this wraps the
            // same way.
            // Fine print, honest rather than papered over: this throw is
            // reached only when the engine's OWN cache lookup already
            // decided "nothing valid to reuse" — which is also the verdict
            // for a RECORDED-but-invalid entry (no code at the stored
            // address, or its stored transaction hash is unfindable) on a
            // non-development network. There, upstream's own
            // `validateStoredDeployment` throws `InvalidDeployment` before
            // this callback is ever invoked, and the catch block below
            // (`redeployImplementation === 'never'` already suppresses its
            // retry) re-throws it as-is — the engine's own "No contract at
            // address … (Removed from manifest)", never this named class.
            // The distinguishing fact for a caller reading either message:
            // ours means no record ever existed for this version; the
            // engine's means one existed and failed revalidation.
            if (resolvedOptions.redeployImplementation === 'never') {
              throw new ImplementationNotPreviouslyDeployedError(validated.name);
            }
            const writeBack = await deploy();
            return {
              address: writeBack.address,
              txHash: writeBack.transactionHash,
              layout: validated.layout,
            } as never;
          },
          {} as never,
          resolvedOptions.redeployImplementation === 'always',
        );
      let deployment: { address: string };
      try {
        deployment = (await fetch()) as { address: string };
      } catch (error) {
        // Upstream removes an invalid cached deployment and then throws on
        // non-EVM dev networks; one retry preserves onchange/always semantics.
        if (
          (error as { removed?: boolean })?.removed !== true ||
          resolvedOptions.redeployImplementation === 'never'
        ) {
          throw error;
        }
        deployment = (await fetch()) as { address: string };
      }
      return deployment.address;
    },

    hostDeploy:
      mode === 'validate-only'
        ? notInThisMode('hostDeploy')
        : async (abstraction, args) => {
            const deployable = abstraction as {
              new?: (...deployArgs: unknown[]) => Promise<unknown>;
              address?: unknown;
              transactionHash?: unknown;
            };
            if (typeof deployable.new !== 'function') {
              throw new Error(
                `the ${String((abstraction as { contractName?: unknown }).contractName)} ` +
                  `abstraction has no deployable surface in this context`,
              );
            }
            // The seam's half of the joint obligation with `refuseUnlessLinkingAllowed`
            // (the entry gate an `unsafeAllowLinkedLibraries` opt-out passes through):
            // `binary` is the exact field the host's own `Contract.new()` deploys —
            // `tx_params.data = self.binary`, the linked form the host computes from
            // `bytecode` and its own `links` map — never `bytecode` itself, which is
            // the pre-link form. Checked here, immediately before the call that sends
            // it on-chain, so no path to a deploy can skip it.
            const deployableBytecode =
              (abstraction as { binary?: string }).binary ??
              (abstraction as { bytecode?: string }).bytecode ??
              // Deliberate passthrough: the fully-linked guard detects unresolved
              // placeholders; an abstraction with no bytecode exposes none to reject.
              '';
            assertFullyLinked(deployableBytecode);
            // The single choke point for the cheatcode-collision guard (review
            // M1): every operation's deploy funnels through this call — `deploy-
            // proxy.ts` also runs it pre-queue as a fail-fast for its own
            // implementation deploy, but `upgradeProxy`, `deployBeacon`,
            // `upgradeBeacon`, `deployImplementation` and `prepareUpgrade` had no
            // guard of their own before this one, since their constructor args
            // reach the host only from inside a queued step. The guard refuses
            // BOTH a trailing plain object and a trailing `null` — a trailing
            // `null` is not a safe pass-through either, verified per installed
            // TronBox minor in `assertNoCheatcodeCollision`'s doc comment. Args
            // this seam builds itself never reach here as a trailing `null`:
            // `deployBeacon`'s owner is the one plugin-built LAST argument that
            // could be null, and it is refused pre-flight, before the queue, by
            // `BeaconInitialOwnerRequiredError` — every other plugin-built last
            // argument is an encoded call/address string. That is a claim about
            // the last position only, which is all this guard can see: the
            // transparent proxy's `initialOwner` is a second plugin-built
            // nullable, but it rides in the MIDDLE of the constructor args, so
            // an unconfigured sender with no `initialOwner` sails past this
            // guard and fails later, client-side, in the host's ABI encoder.
            assertNoCheatcodeCollision(args);
            const instance = (await deployable.new(...args)) as {
              address?: unknown;
              transactionHash?: unknown;
            };
            const address = instance?.address;
            const transactionHash = instance?.transactionHash;
            if (
              typeof address !== 'string' ||
              typeof transactionHash !== 'string'
            ) {
              throw new Error(
                'the host deploy resolved without an address and transaction hash',
              );
            }
            /*
             * The write-back the host's own deploy action performs, mirrored here
             * because this seam deploys through `.new` directly: assigning the
             * class's `address` is what CREATES the artifact's per-network entry
             * (the setter writes `_json.networks[network_id]`), which is both the
             * replay memory `decideDeployReplay` reads and what the host persists
             * back into the artifact after the migration. Reading the class getter
             * before this assignment throws — measured on the first live run.
             */
            deployable.address = address;
            deployable.transactionHash = transactionHash;
            return { address, transactionHash };
          },

    confirm: transactionHash => confirmTransaction(transactionHash, wait),

    hashWithoutMetadata: bytecode =>
      engine.hashBytecodeWithoutMetadata(bytecode),

    async inferKind(validated) {
      const kind: unknown = engine.inferProxyKind(
        validated.validations as never,
        validated.version as never,
      );
      if (kind !== 'transparent' && kind !== 'uups' && kind !== 'beacon') {
        throw new Error(`the engine inferred an unknown proxy kind: ${String(kind)}`);
      }
      return kind;
    },

    async processProxyKind(proxyAddress, validated, resolvedOptions) {
      /*
       * Built without ever writing an own `kind: undefined` key — the exact
       * hazard `options/resolve.ts:buildResolved` documents. Two branches,
       * both load-bearing:
       *
       * - A caller-supplied kind overrides whatever the engine options carry.
       * - An omitted kind must reach the engine as an ABSENT key, so the key
       *   is deleted rather than spread through: `withValidationDefaults`
       *   stamps `kind: opts.kind ?? 'transparent'` onto every engine-options
       *   object (`dist/validate/overrides.js`), and upstream's
       *   `processProxyKind` infers the kind from the implementation only
       *   when `opts.kind === undefined` — spreading the defaulted
       *   `'transparent'` verbatim would silently disable that inference for
       *   every caller who never chose a kind. The parity target hands
       *   upstream the caller's RAW options, where an omitted kind is
       *   genuinely absent; absence is what preserves its semantics here.
       */
      const kindOptions: Record<string, unknown> = {
        ...resolvedOptions.engineOptions,
      };
      if (resolvedOptions.kind !== undefined) {
        kindOptions['kind'] = resolvedOptions.kind;
      } else {
        delete kindOptions['kind'];
      }
      await engine.processProxyKind(
        requireChain().provider as never,
        proxyAddress,
        kindOptions as never,
        validated.validations as never,
        validated.version as never,
      );
      const kind = kindOptions['kind'];
      if (kind !== 'transparent' && kind !== 'uups') {
        throw new Error(`unsupported proxy kind for this operation: ${String(kind)}`);
      }
      return kind;
    },

    async storedLayoutFor(implementationAddress) {
      const record = await requireSession().getImplRecord(implementationAddress);
      if (record?.layout === undefined) {
        throw new Error(
          `No stored storage layout for the implementation at ` +
            `${implementationAddress}. Register the deployment first with ` +
            `forceImport, or upgrade from the plugin that deployed it.`,
        );
      }
      return record.layout;
    },

    async assertStorageCompatible(currentLayout, validated, resolvedOptions) {
      const report = captureEngineWarnings(channel, 'getStorageUpgradeReport', () =>
        engine.getStorageUpgradeReport(
          currentLayout as never,
          validated.layout as never,
          resolvedOptions.engineOptions as never,
        ),
      );
      if (!report.ok) {
        throw new Error(
          `The new implementation is not storage-compatible with the current ` +
            `one:\n${report.explain()}`,
        );
      }
    },

    callThroughFacade:
      mode === 'validate-only'
        ? notInThisMode('callThroughFacade')
        : async request => {
            const facade = requireProxyArtifact(
              env.artifacts,
              request.facadeName,
            );
            const attachable = facade as {
              at?: (address: string) => Promise<unknown> | unknown;
            };
            if (typeof attachable.at !== 'function') {
              throw new Error(
                `the ${request.facadeName} abstraction has no attachable surface in this context`,
              );
            }
            const instance = (await attachable.at(request.at)) as Record<
              string,
              (...callArgs: unknown[]) => Promise<unknown>
            >;
            const method = instance[request.method];
            if (typeof method !== 'function') {
              throw new Error(
                `${request.facadeName} at ${request.at} exposes no ${request.method} method`,
              );
            }
            const result: unknown = await method(...request.args);
            // Measured: the host's send path resolves the transaction id as a
            // string (`transaction.transaction.txID`). The object arms cover the
            // polling configurations that resolve a receipt-shaped value instead.
            const transactionHash =
              typeof result === 'string'
                ? result
                : typeof (result as { txID?: unknown })?.txID === 'string'
                  ? ((result as { txID: string }).txID)
                  : typeof (result as { transactionHash?: unknown })
                        ?.transactionHash === 'string'
                    ? ((result as { transactionHash: string }).transactionHash)
                    : null;
            if (transactionHash === null) {
              throw new Error(
                `the ${request.method} call returned no recognisable transaction id; ` +
                  `refusing to report a state change it cannot confirm`,
              );
            }
            return { address: request.at, transactionHash };
          },

    proxySlots: address => requireChain().read.readProxySlots(address),

    async ownerOf(address) {
      // owner()'s selector; the answer is a 32-byte word carrying the address
      // in its last 20 bytes. A revert or empty answer means "does not answer
      // owner()", which the caller treats as its own named state.
      const outcome = await requireChain().read.tvmCallOptional(
        address,
        '0x8da5cb5b',
      );
      if (outcome.kind !== 'answered' || typeof outcome.data !== 'string') {
        return null;
      }
      const word = outcome.data.replace(/^0x/, '');
      if (word.length < 40 || /^0+$/.test(word)) {
        return null;
      }
      return canonicalizeAddress(`0x${word.slice(-40)}`);
    },

    async sendUpgradeCall(request) {
      /*
       * The dispatched call rides a plugin-shipped facade attached at the
       * CURRENT generation's contract (never the new implementation's ABI):
       * a v5 admin is the real ProxyAdmin; a v4 admin goes through
       * ITronUpgradesProxyAdminV4; both uups routes go through
       * ITronUpgradesUUPS at the proxy. All three are compiled by the
       * consumer's own import of contracts/Proxies.sol, so resolution takes
       * the same triage as the proxy artifacts.
       */
      const facadeName =
        request.route === 'admin-v5'
          ? 'ProxyAdmin'
          : request.route === 'admin-v4'
            ? 'ITronUpgradesProxyAdminV4'
            : 'ITronUpgradesUUPS';
      const callArgs =
        request.route === 'admin-v5' || request.route === 'admin-v4'
          ? request.call === 'upgrade'
            ? [request.proxyAddress, request.implementationAddress]
            : [request.proxyAddress, request.implementationAddress, request.data]
          : request.call === 'upgradeTo'
            ? [request.implementationAddress]
            : [request.implementationAddress, request.data];
      const writeBack = await toolkit.callThroughFacade({
        facadeName,
        at: request.adminAddress === null ? request.proxyAddress : request.adminAddress,
        method: request.call,
        args: callArgs,
      });
      return { address: request.proxyAddress, transactionHash: writeBack.transactionHash };
    },

    recordProxy: (address, kind) =>
      requireSession().addProxyRecord({ address, kind }),
  };

  return { toolkit, resolved };
}
