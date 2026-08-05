import type {
  ContractAbstraction,
  RawMigrationHandles,
  ResolverInterceptHandle,
} from '../../src/environment';
import { configFixture, type ConfigFixtureSpec } from './config-fixtures';

/**
 * Migration-handle stand-ins.
 *
 * Property *ownership* is reproduced deliberately, because the seam reads own
 * properties and prototype members through different primitives:
 * `ResolverIntercept.prototype.require` / `.contracts` and `Deployer.prototype
 * .then` live on prototypes and are probed with `in`, while `Config` props,
 * `deployer.logger` and `artifacts.resolver` are own properties probed with
 * `hasOwnProperty`. Fixtures are provided in both ownerships so neither
 * primitive can be substituted for the other without a test failing.
 *
 * The intercept fixture's `require` is typed `unknown` rather than
 * `ContractAbstraction`, because the host's failure channel *is* returning a
 * nullish value from a function whose contract says otherwise
 * (`build/components/Resolver/fs.js:FS.prototype.requireJson`). Typing it
 * honestly means the fixture needs no cast to reproduce that channel, and the
 * handle enters the seam through `unknown` anyway.
 */

export interface InterceptFixture {
  readonly resolver: Record<string, unknown>;
  require(importPath: string): unknown;
  contracts(): unknown[];
  /** Every `require` argument this intercept received, in order. */
  readonly calls: readonly string[];
}

export interface InterceptOptions {
  /** How `require` behaves. `'resolve'` mints and caches an abstraction. */
  readonly mode?: 'resolve' | 'throw' | 'null' | 'undefined' | 'primitive';
  /** Message of the thrown host error, for leak assertions. */
  readonly throwMessage?: string;
  /** Abstractions keyed by normalized name, for `sourcePath` control. */
  readonly abstractions?: Readonly<Record<string, ContractAbstraction>>;
  /** Source path minted abstractions carry. `null` omits the field entirely. */
  readonly sourcePath?: string | null;
  /** Names that resolve; anything else throws. Absent means every name resolves. */
  readonly resolvable?: readonly string[];
}

class FixtureIntercept implements InterceptFixture {
  readonly resolver: Record<string, unknown>;
  readonly #cache = new Map<string, object>();
  readonly #calls: string[] = [];
  readonly #options: InterceptOptions;

  constructor(resolver: Record<string, unknown>, options: InterceptOptions) {
    this.resolver = resolver;
    this.#options = options;
  }

  get calls(): readonly string[] {
    return [...this.#calls];
  }

  require(importPath: string): unknown {
    this.#calls.push(importPath);
    const mode = this.#options.mode ?? 'resolve';
    const resolvable = this.#options.resolvable;
    if (resolvable !== undefined && !resolvable.includes(importPath)) {
      throw new Error(
        `Could not find artifacts for ${importPath} from any sources`,
      );
    }
    if (mode === 'throw') {
      throw new Error(
        this.#options.throwMessage ??
          `Could not find artifacts for ${importPath} from any sources`,
      );
    }
    if (mode === 'null') {
      return null;
    }
    if (mode === 'undefined') {
      return undefined;
    }
    if (mode === 'primitive') {
      return 7;
    }

    const cached = this.#cache.get(importPath);
    if (cached !== undefined) {
      return cached;
    }
    const supplied = this.#options.abstractions?.[importPath];
    const sourcePath = this.#options.sourcePath;
    const minted: object =
      supplied ??
      (sourcePath === null
        ? { contractName: importPath }
        : {
            contractName: importPath,
            sourcePath: sourcePath ?? `contracts/${importPath}.sol`,
          });
    this.#cache.set(importPath, minted);
    return minted;
  }

  contracts(): unknown[] {
    return [...this.#cache.values()];
  }
}

/**
 * A `ResolverIntercept` stand-in whose `require` / `contracts` live on the
 * prototype, matching the host.
 */
export function interceptFixture(
  resolver: Record<string, unknown>,
  options: InterceptOptions = {},
): InterceptFixture {
  return new FixtureIntercept(resolver, options);
}

/**
 * A structurally typed `ResolverInterceptHandle`, for the portability test that
 * drives `createArtifactAccess` directly with no `resolveEnvironment` around
 * it. No cast: the object satisfies the published interface as written.
 */
export function typedInterceptFixture(): ResolverInterceptHandle {
  const cache = new Map<string, ContractAbstraction>();
  const resolver: Record<string, unknown> = {};
  return {
    resolver,
    require(importPath: string): ContractAbstraction {
      const cached = cache.get(importPath);
      if (cached !== undefined) {
        return cached;
      }
      const minted: ContractAbstraction = {
        contractName: importPath,
        sourcePath: `contracts/${importPath}.sol`,
      };
      cache.set(importPath, minted);
      return minted;
    },
    contracts(): ContractAbstraction[] {
      return [...cache.values()];
    },
  };
}

/** The same surface with own-property methods, to prove `in` is not `hasOwnProperty`. */
export function ownPropertyInterceptFixture(
  resolver: Record<string, unknown>,
): Record<string, unknown> {
  const cache = new Map<string, object>();
  return {
    resolver,
    require(importPath: string): unknown {
      const cached = cache.get(importPath);
      if (cached !== undefined) {
        return cached;
      }
      const minted: object = {
        contractName: importPath,
        sourcePath: `contracts/${importPath}.sol`,
      };
      cache.set(importPath, minted);
      return minted;
    },
    contracts(): unknown[] {
      return [...cache.values()];
    },
  };
}

export interface DeployerFixtureOptions {
  readonly logger?: unknown;
  /** `deployer.options.basePath` — the migrations directory, never the root. */
  readonly basePath?: string;
  /** `false` omits `then`, exercising the `handle-malformed` path. */
  readonly withThen?: boolean;
  /** Put `then` on the prototype instead of the instance. */
  readonly thenOnPrototype?: boolean;
}

class PrototypeThenDeployer {
  readonly options: Record<string, unknown>;
  readonly logger: unknown;

  constructor(options: Record<string, unknown>, logger: unknown) {
    this.options = options;
    this.logger = logger;
  }

  then(step: (...args: unknown[]) => unknown): unknown {
    return step;
  }
}

/** `deployer.options.options` is the Config — one hop deeper than it looks. */
export function deployerHandle(
  config: unknown,
  options: DeployerFixtureOptions = {},
): unknown {
  const logger = 'logger' in options ? options.logger : { log(): void {} };
  const inner: Record<string, unknown> = {
    options: config,
    logger,
    network: 'development',
    network_id: '*',
    basePath: options.basePath ?? '/proj/migrations',
  };
  if (options.thenOnPrototype === true) {
    return new PrototypeThenDeployer(inner, logger);
  }
  const handle: Record<string, unknown> = { options: inner, logger };
  if (options.withThen !== false) {
    handle.then = (step: (...args: unknown[]) => unknown): unknown => step;
  }
  return handle;
}

/**
 * A deployer whose Config hop is truncated, for the property-path
 * diagnosis's `expectedPath` tests.
 */
export function shallowDeployerHandle(depth: 0 | 1): unknown {
  return depth === 0
    ? { logger: { log(): void {} }, then: (): void => {} }
    : { options: {}, logger: { log(): void {} }, then: (): void => {} };
}

function hostile(what: string): never {
  throw new Error(
    `the environment seam must never call the chain: ${what} was invoked during resolution`,
  );
}

export function tronWrapHandle(): Record<string, unknown> {
  return {
    trx: {
      getCurrentBlock: (): never => hostile('trx.getCurrentBlock'),
    },
  };
}

/**
 * Every method throws, so a resolution that succeeds proves the raw handle
 * is never invoked.
 */
export function hostileTronWrapHandle(): Record<string, unknown> {
  const trx = new Proxy(
    {},
    {
      get: (_target, property) =>
        property === 'then' || property === 'toJSON'
          ? undefined
          : (): never => hostile(`trx.${String(property)}`),
      has: () => true,
    },
  );
  return new Proxy(
    { trx },
    {
      get: (_target, property) => {
        if (property === 'trx') {
          return trx;
        }
        if (property === 'then' || property === 'toJSON') {
          return undefined;
        }
        return (): never => hostile(String(property));
      },
      has: () => true,
    },
  );
}

export interface HandleSetOptions {
  readonly deployer?: unknown;
  readonly artifacts?: unknown;
  readonly tronWrap?: unknown;
  readonly tronWeb?: unknown;
  readonly waitForTransactionReceipt?: unknown;
}

/** Only the keys explicitly supplied become own properties. */
export function handles(
  options: HandleSetOptions = {},
): RawMigrationHandles {
  const built: Record<string, unknown> = {};
  for (const key of [
    'deployer',
    'artifacts',
    'tronWrap',
    'tronWeb',
    'waitForTransactionReceipt',
  ] as const) {
    if (key in options) {
      built[key] = options[key];
    }
  }
  return built;
}

export interface LoggerSpy {
  readonly logger: Record<string, unknown>;
  readonly calls: readonly unknown[][];
}

function spyLogger(): { logger: Record<string, unknown>; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    logger: {
      log(...args: unknown[]): void {
        calls.push(args);
      },
    },
    calls,
  };
}

export interface HandleShape {
  readonly handles: RawMigrationHandles;
  /** The lineage the `artifacts` handle reaches. */
  readonly config: Record<string, unknown>;
  readonly resolver: Record<string, unknown>;
  readonly intercept: InterceptFixture;
  readonly deployer: unknown;
  readonly loggerCalls: readonly unknown[][];
}

/**
 * The `tronbox migrate` shape: both lineages are the **identical** live Config,
 * so `provenance.sameObject` is `true` and no cross-lineage disagreement is
 * possible. This is the shape every developer run takes, which is why the
 * no-lineage-preference path is untested by ordinary use.
 */
export function migrateShapedHandles(
  spec: ConfigFixtureSpec = {},
  interceptOptions: InterceptOptions = {},
): HandleShape {
  const resolver: Record<string, unknown> = {};
  const { logger, calls } = spyLogger();
  const config = configFixture({
    binding: 'live-config',
    resolver,
    logger,
    ...spec,
  });
  resolver.options = config;
  const intercept = interceptFixture(resolver, interceptOptions);
  const deployer = deployerHandle(config, { logger });
  return {
    handles: handles({
      deployer,
      artifacts: intercept,
      tronWrap: tronWrapHandle(),
      waitForTransactionReceipt: (): void => {},
    }),
    config,
    resolver,
    intercept,
    deployer,
    loggerCalls: calls,
  };
}

export interface TestShape extends HandleShape {
  readonly snapshot: Record<string, unknown>;
  readonly liveConfig: Record<string, unknown>;
}

/**
 * The `tronbox test` shape: the deployer holds the early-bound plain-object
 * snapshot `Config.prototype.with` produced, while the resolver holds the live
 * `Config`. Distinct objects, able to disagree the moment anything mutates the
 * live Config after the snapshot.
 */
export function testShapedHandles(
  live: ConfigFixtureSpec = {},
  snapshotOverrides: ConfigFixtureSpec = {},
  interceptOptions: InterceptOptions = {},
): TestShape {
  const resolver: Record<string, unknown> = {};
  const { logger, calls } = spyLogger();
  const liveConfig = configFixture({
    binding: 'live-config',
    resolver,
    logger,
    ...live,
  });
  resolver.options = liveConfig;
  const snapshot = configFixture({
    binding: 'materialized-snapshot',
    resolver,
    logger,
    ...live,
    ...snapshotOverrides,
  });
  const intercept = interceptFixture(resolver, interceptOptions);
  const deployer = deployerHandle(snapshot, { logger });
  return {
    handles: handles({
      deployer,
      artifacts: intercept,
      tronWrap: tronWrapHandle(),
      waitForTransactionReceipt: (): void => {},
    }),
    config: liveConfig,
    liveConfig,
    snapshot,
    resolver,
    intercept,
    deployer,
    loggerCalls: calls,
  };
}

/** The mocha-file shape: `artifacts` only — no deployer, no receipts. */
export function artifactsOnlyHandles(
  spec: ConfigFixtureSpec = {},
  interceptOptions: InterceptOptions = {},
): HandleShape {
  const resolver: Record<string, unknown> = {};
  const { logger, calls } = spyLogger();
  const config = configFixture({
    binding: 'live-config',
    resolver,
    logger,
    ...spec,
  });
  resolver.options = config;
  const intercept = interceptFixture(resolver, interceptOptions);
  return {
    handles: handles({ artifacts: intercept, tronWrap: tronWrapHandle() }),
    config,
    resolver,
    intercept,
    deployer: undefined,
    loggerCalls: calls,
  };
}

/** The deployer-only shape: no `artifacts`, so only one lineage is reachable. */
export function deployerOnlyHandles(
  spec: ConfigFixtureSpec = {},
): HandleShape {
  const resolver: Record<string, unknown> = {};
  const { logger, calls } = spyLogger();
  const config = configFixture({
    binding: 'materialized-snapshot',
    resolver,
    logger,
    ...spec,
  });
  resolver.options = config;
  const deployer = deployerHandle(config, { logger });
  return {
    handles: handles({ deployer, tronWrap: tronWrapHandle() }),
    config,
    resolver,
    intercept: interceptFixture(resolver),
    deployer,
    loggerCalls: calls,
  };
}
