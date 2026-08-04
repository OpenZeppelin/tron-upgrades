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
import { openRecord, canonicalizeAddress } from '../record';
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

  /** The dispatched upgrade call, sent through the host (upgrade path). */
  sendUpgradeCall(request: {
    readonly route: 'admin-v5' | 'admin-v4' | 'uups-v5' | 'uups-pre5';
    readonly call: string;
    readonly proxyAddress: string;
    readonly adminAddress: string | null;
    readonly implementationAddress: string;
    readonly data: string;
  }): Promise<WriteBack>;

  recordProxy(address: string, kind: 'transparent' | 'uups'): Promise<void>;
}

/** What an operation entry point receives beyond the user's own arguments. */
export interface OperationContext {
  readonly toolkit: OperationToolkit;
  readonly resolved: ResolvedForProxyOps;
}

/** Options every operation accepts at minimum; the per-operation lists extend it. */
export interface RawOperationOptions {
  readonly deployer?: unknown;
  readonly [key: string]: unknown;
}

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
  (typeof REQUIRED_SLOTS)[number]
> & { readonly scheduling?: SlotShapes['scheduling'] };

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
}): Promise<OperationContext> {
  const env = resolveEnvironment(request.handles, {
    require: REQUIRED_SLOTS,
    optional: ['scheduling'] as const,
  }) as unknown as OperationEnvironment;

  const channel = createOutputChannel(env.output);
  const chain = await createChainAccess(env.chain, {
    env: request.processEnv ?? process.env,
  });
  const session = await openRecord({
    root: env.paths.root,
    env: request.processEnv ?? process.env,
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

  const wait: BoundWait = (hash, intervalMs, maxRetries) =>
    Promise.resolve(
      (env.receipts.waitForTransactionReceipt as (...args: unknown[]) => unknown)(
        hash,
        intervalMs,
        maxRetries,
      ),
    );

  const toolkit: OperationToolkit = {
    network: env.network,
    artifacts: env.artifacts,
    channel,
    session,
    chain,

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
    replayVerdicts: () => session.report.proxies,

    resolveSender: () => resolveEffectiveSender(env.network.sender),

    async signerOf(transactionHash) {
      try {
        const transaction = (await chain.provider.send('eth_getTransactionByHash', [
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

    looksLikeProxyAdmin: address => chain.read.looksLikeProxyAdmin(address),

    async fetchOrDeployImplementation(validated, resolvedOptions, deploy) {
      const fetch = () =>
        engine.fetchOrDeployGetDeployment(
          validated.version as never,
          chain.provider as never,
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
      await deployable.new(...args);
      const address = deployable.address;
      const transactionHash = deployable.transactionHash;
      if (typeof address !== 'string' || typeof transactionHash !== 'string') {
        throw new Error(
          'the host deploy completed without writing address and transactionHash back',
        );
      }
      return { address, transactionHash };
    },

    confirm: transactionHash => confirmTransaction(transactionHash, wait),

    async processProxyKind(proxyAddress, validated, resolvedOptions) {
      const kindOptions: Record<string, unknown> = {
        ...resolvedOptions.engineOptions,
        kind: resolvedOptions.kind,
      };
      await engine.processProxyKind(
        chain.provider as never,
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
      const record = await session.getImplRecord(implementationAddress);
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

    async sendUpgradeCall() {
      throw new Error(
        'sendUpgradeCall is not wired for this host yet: the dispatched call ' +
          'rides the plugin-shipped interfaces, which need a provisioned ' +
          'abstraction surface this context did not supply',
      );
    },

    recordProxy: (address, kind) => session.addProxyRecord({ address, kind }),
  };

  return { toolkit, resolved };
}
