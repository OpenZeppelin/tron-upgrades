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
 *    the two dynamic imports the closure rule requires (`../options/resolve`
 *    holds the package's one static engine value-import; the engine itself is
 *    the other) — and it does them *after* `configureRecordLocation` has run
 *    inside `openRecord`, which is the whole point of deferring.
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
import { EmptyInitializerRefusedError } from './errors';

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
  /** The operation's channel: notes recorded here ride the result (INV-16 of SF-10). */
  readonly channel: OutputChannel;
  readonly session: RecordSession;
  readonly chain: ChainAccess;

  /** Contract-call access at an address, over the host's public `.at` surface. */
  contractAt(
    abstraction: ContractAbstraction,
    address: string,
  ): Promise<ContractHandle>;

  /** INV-1's subject: runs first, refuses on an unsafe implementation. */
  validateImplementation(
    contractName: string,
    resolved: ResolvedForProxyOps,
  ): Promise<ValidatedImplementation>;

  /** INV-18: consulted only AFTER validation; throws `DeployerAbsentError`. */
  requireDeployer(): QueueHost;

  /** INV-13: the operation's single queued step. */
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
   * INV-2's subject on the upgrade path: the implementation deploy, routed
   * through the engine's `fetchOrDeployGetDeployment` so replay reuse is
   * upstream's own. `deploy` runs only when the record has no live entry.
   */
  fetchOrDeployImplementation(
    validated: ValidatedImplementation,
    resolved: ResolvedForProxyOps,
    deploy: () => Promise<WriteBack>,
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
 * Encodes initializer data over the abstraction's public `abi`. `'0x'` is a
 * refusal, not a value (INV-11): the ported TRC1967Proxy rejects empty
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
  // site INV-49's instrument permits.
  const iface = new Interface(abi as never);
  const name = initializer ?? 'initialize';
  const fragment = iface.getFunction(name, [...args] as never);
  if (fragment === null) {
    if (initializer === undefined && args.length === 0) {
      throw new EmptyInitializerRefusedError(kind, 'no-default-initializer');
    }
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
        });

  // The deferred loads, in one place — every module whose static closure
  // reaches the engine: `options/resolve` and `validation-input/identity`
  // both hold engine value-imports (the entry-closure guard found the second
  // one the day the operations were wired), plus the engine itself.
  const optionsModule = await import('../options/resolve');
  const validationInput = await import('../validation-input');
  const engine = await import('@openzeppelin/upgrades-core');

  const resolvedRaw = optionsModule.resolveUpgradeOptions(
    request.rawOptions as never,
    request.acceptedOptions,
  ) as unknown as Record<string, unknown>;
  const resolved: ResolvedForProxyOps = {
    kind: resolvedRaw['kind'] as ResolvedForProxyOps['kind'],
    initializer: resolvedRaw['initializer'] as ResolvedForProxyOps['initializer'],
    constructorArgs:
      (resolvedRaw['constructorArgs'] as readonly unknown[] | undefined) ?? [],
    redeployImplementation:
      (resolvedRaw['redeployImplementation'] as ResolvedForProxyOps['redeployImplementation']) ??
      'onchange',
    unsafeAllowLinkedLibraries: resolvedRaw['unsafeAllowLinkedLibraries'] === true,
    unsafeSkipProxyAdminCheck: resolvedRaw['unsafeSkipProxyAdminCheck'] === true,
    initialOwner: resolvedRaw['initialOwner'] as string | undefined,
    call: resolvedRaw['call'] as ResolvedForProxyOps['call'],
    engineOptions: optionsModule.engineValidationOptions(
      resolvedRaw as never,
    ) as unknown as Record<string, unknown>,
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
      const validations = engine.validate(
        input.solcOutput as never,
        decoder,
        input.solcVersion,
        input.solcInput as never,
      );
      const resolution = env.artifacts.resolve(contractName);
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
      const errors = engine.getErrors(
        validations as never,
        version as never,
        {
          ...resolvedOptions.engineOptions,
          kind: resolvedOptions.kind ?? 'transparent',
        } as never,
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
        throw new DeployerAbsentError('tronbox test');
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

    async hostDeploy(abstraction, args) {
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
      const instance = (await deployable.new(...args)) as {
        address?: unknown;
        transactionHash?: unknown;
      };
      const address = instance?.address;
      const transactionHash = instance?.transactionHash;
      if (typeof address !== 'string' || typeof transactionHash !== 'string') {
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
      const kindOptions: Record<string, unknown> = {
        ...resolvedOptions.engineOptions,
        kind: resolvedOptions.kind,
      };
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
      const report = engine.getStorageUpgradeReport(
        currentLayout as never,
        validated.layout as never,
        resolvedOptions.engineOptions as never,
      );
      if (!report.ok) {
        throw new Error(
          `The new implementation is not storage-compatible with the current ` +
            `one:\n${report.explain()}`,
        );
      }
    },

    async callThroughFacade(request) {
      const facade = requireProxyArtifact(env.artifacts, request.facadeName);
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
            : typeof (result as { transactionHash?: unknown })?.transactionHash ===
                'string'
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
