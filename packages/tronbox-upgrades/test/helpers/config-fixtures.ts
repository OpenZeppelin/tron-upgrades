import path from 'node:path';

/**
 * Plain-object stand-ins for the two TronBox `Config` lineages.
 *
 * Every default below reproduces what a *real* `Config` reports rather than what
 * would be convenient, because several invariants turn on the difference:
 *
 * - `callValue`, `tokenValue`, `tokenId` and `from` default to a key that is
 *   **present with an `undefined` value**, not to an absent key. That is what
 *   `build/components/Config.js:Config`'s getters produce, since
 *   `build/components/TronWrap/constants.js:deployParameters` declares
 *   `tokenValue: undefined`, `tokenId: undefined`, `from: undefined`. INV-4 and
 *   INV-17 both depend on absent and present-but-undefined being different
 *   states, so a fixture that omitted the keys would exercise the wrong branch.
 * - `feeLimit: 1e9`, `userFeePercentage: 100`, `originEnergyLimit: 1e7` are the
 *   `deployParameters` constants — the "complete, plausible, entirely fictional
 *   network configuration" INV-16 exists to refuse.
 * - `working_directory` is an own **accessor** on a live `Config` and an own
 *   **data property** on the `Config.prototype.with` snapshot. That descriptor
 *   difference is the only thing `config-lineage.ts:classifyBinding` inspects.
 *
 * The real-host suites in `real-tronbox.test.ts` pin these defaults against the
 * installed TronBox trees, so a fixture that drifts from the tool fails there.
 */

/** Recognizable, and valid 64-hex so TronWeb accepts it in the real-host suites. */
export const SENTINEL_PRIVATE_KEY = 'cafebabe'.repeat(8);
export const SENTINEL_MNEMONIC = 'SF0-SENTINEL-MNEMONIC-NEVER-LOGGED';
export const SENTINEL_FILE_CONTENT = 'SF0-SENTINEL-BUILD-INFO-BYTES';

export const DEPLOY_PARAMETER_FEE_LIMIT = 1_000_000_000;
export const DEPLOY_PARAMETER_USER_FEE_PERCENTAGE = 100;
export const DEPLOY_PARAMETER_ORIGIN_ENERGY_LIMIT = 10_000_000;

export type Binding = 'live-config' | 'materialized-snapshot';

export interface ConfigFixtureSpec {
  /** `working_directory`. */
  readonly root?: unknown;
  readonly contractsDirectory?: unknown;
  readonly contractsBuildDirectory?: unknown;
  readonly buildInfoDirectory?: unknown;
  readonly network?: unknown;
  readonly networks?: unknown;
  /** The config-level `network_id` getter's value — distinct from the entry's. */
  readonly networkId?: unknown;
  readonly from?: unknown;
  readonly feeLimit?: unknown;
  readonly userFeePercentage?: unknown;
  readonly originEnergyLimit?: unknown;
  readonly callValue?: unknown;
  readonly tokenValue?: unknown;
  readonly tokenId?: unknown;
  readonly logger?: unknown;
  readonly quiet?: unknown;
  readonly resolver?: unknown;
  readonly binding?: Binding;
  /**
   * Define the derived scalars as **accessors over `networks[network]`**, the
   * way a live `Config` computes them, instead of as data properties.
   *
   * INV-9's mutation test needs this: on a real live Config every one of these
   * is late-bound through the freshly merged `network_config`, so mutating
   * `networks[name].from` after resolution changes what the *host* reports. A
   * data-property fixture would pass INV-9's assertion for the wrong reason —
   * the fixture, not the seam, would be the thing that copied.
   */
  readonly liveGetters?: boolean;
  /** Extra own properties, for "a future upstream key" tests (INV-41). */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** Keys deleted entirely — absent, not nullish (INV-17). */
  readonly omit?: readonly string[];
  /** Keys defined as accessors that throw, like `network_config` (INV-15). */
  readonly throwOn?: readonly string[];
}

export interface NetworkEntrySpec {
  readonly networkId?: unknown;
  readonly privateKey?: unknown;
  readonly from?: unknown;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly omit?: readonly string[];
}

export function networkEntry(
  spec: NetworkEntrySpec = {},
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    network_id: 'networkId' in spec ? spec.networkId : '*',
    privateKey:
      'privateKey' in spec ? spec.privateKey : SENTINEL_PRIVATE_KEY,
    fullHost: 'http://127.0.0.1:9090',
    ...(spec.extra ?? {}),
  };
  if ('from' in spec) {
    entry.from = spec.from;
  }
  for (const key of spec.omit ?? []) {
    delete entry[key];
  }
  return entry;
}

const THROWING_GETTER_MESSAGE =
  'Network not set. Cannot determine network to use.';

/** The fresh merge a real `Config.network_config` performs on every access. */
function networkConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const selected = config.network;
  const networks = config.networks;
  const entry =
    typeof selected === 'string' &&
    typeof networks === 'object' &&
    networks !== null &&
    Object.prototype.hasOwnProperty.call(networks, selected)
      ? (networks as Record<string, unknown>)[selected]
      : undefined;
  return {
    ...(typeof entry === 'object' && entry !== null
      ? (entry as Record<string, unknown>)
      : {}),
  };
}

/**
 * Builds one Config-lineage stand-in.
 *
 * `binding` decides whether `working_directory` is an accessor (`live-config`)
 * or a data property (`materialized-snapshot`), which is exactly what the seam
 * classifies on.
 */
export function configFixture(
  spec: ConfigFixtureSpec = {},
): Record<string, unknown> {
  const root = 'root' in spec ? spec.root : '/proj';
  const rootString = typeof root === 'string' ? root : '/proj';
  const networks =
    'networks' in spec
      ? spec.networks
      : { development: networkEntry() };
  const selected = 'network' in spec ? spec.network : 'development';

  const entry =
    typeof selected === 'string' &&
    typeof networks === 'object' &&
    networks !== null &&
    Object.prototype.hasOwnProperty.call(networks, selected)
      ? (networks as Record<string, unknown>)[selected]
      : undefined;
  const entryRecord =
    typeof entry === 'object' && entry !== null
      ? (entry as Record<string, unknown>)
      : undefined;

  const values: Record<string, unknown> = {
    contracts_directory:
      'contractsDirectory' in spec
        ? spec.contractsDirectory
        : path.join(rootString, 'contracts'),
    contracts_build_directory:
      'contractsBuildDirectory' in spec
        ? spec.contractsBuildDirectory
        : path.join(rootString, 'build', 'contracts'),
    build_info_directory:
      'buildInfoDirectory' in spec
        ? spec.buildInfoDirectory
        : path.join(rootString, 'build', 'build-info'),
    network: selected,
    networks,
    // Mirrors the getter: `network_config.network_id`, i.e. the selected
    // entry's id, which is *not* the same fact as the entry read directly.
    network_id:
      'networkId' in spec ? spec.networkId : entryRecord?.network_id,
    from: 'from' in spec ? spec.from : entryRecord?.from,
    feeLimit: 'feeLimit' in spec ? spec.feeLimit : DEPLOY_PARAMETER_FEE_LIMIT,
    userFeePercentage:
      'userFeePercentage' in spec
        ? spec.userFeePercentage
        : DEPLOY_PARAMETER_USER_FEE_PERCENTAGE,
    originEnergyLimit:
      'originEnergyLimit' in spec
        ? spec.originEnergyLimit
        : DEPLOY_PARAMETER_ORIGIN_ENERGY_LIMIT,
    // `config.callValue` is `network_config.callValue || network_config.call_value`
    // and `deployParameters.callValue` is `0` — falsy — so the getter falls
    // through to the absent snake_case key and reads `undefined`.
    callValue: 'callValue' in spec ? spec.callValue : undefined,
    tokenValue: 'tokenValue' in spec ? spec.tokenValue : undefined,
    tokenId: 'tokenId' in spec ? spec.tokenId : undefined,
    logger: 'logger' in spec ? spec.logger : { log(): void {} },
    // `Config.js:50` and `:63` declare `solc` with a default of `{}`, so it is an
    // own enumerable member of every live Config and of every `config.with`
    // snapshot. A fixture without it is a shape TronBox never produces. Placed
    // before the `extra` spread so a test can still override or delete it.
    solc: {},
    ...(spec.extra ?? {}),
  };
  if ('quiet' in spec) {
    values.quiet = spec.quiet;
  }
  if ('resolver' in spec) {
    values.resolver = spec.resolver;
  }

  const config: Record<string, unknown> = {};
  const binding: Binding = spec.binding ?? 'live-config';
  if (binding === 'live-config') {
    Object.defineProperty(config, 'working_directory', {
      get: () => root,
      enumerable: true,
      configurable: true,
    });
  } else {
    Object.defineProperty(config, 'working_directory', {
      value: root,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const [key, value] of Object.entries(values)) {
    config[key] = value;
  }

  if (spec.liveGetters === true) {
    // Mirrors `build/components/Config.js:Config`: `network_config` is
    // `_.extend({}, default_tx_values, self.networks[network] || {})`, freshly
    // merged on every access, and each consumer getter reads through it.
    const derived: Record<string, () => unknown> = {
      network_id: () => networkConfig(config).network_id,
      from: () => networkConfig(config).from,
      feeLimit: () =>
        networkConfig(config).feeLimit ?? DEPLOY_PARAMETER_FEE_LIMIT,
      userFeePercentage: () =>
        networkConfig(config).userFeePercentage ??
        DEPLOY_PARAMETER_USER_FEE_PERCENTAGE,
      originEnergyLimit: () =>
        networkConfig(config).originEnergyLimit ??
        DEPLOY_PARAMETER_ORIGIN_ENERGY_LIMIT,
      callValue: () => networkConfig(config).callValue,
      tokenValue: () => networkConfig(config).tokenValue,
      tokenId: () => networkConfig(config).tokenId,
    };
    for (const [key, get] of Object.entries(derived)) {
      delete config[key];
      Object.defineProperty(config, key, {
        get,
        enumerable: true,
        configurable: true,
      });
    }
  }

  for (const key of spec.throwOn ?? []) {
    delete config[key];
    Object.defineProperty(config, key, {
      get: () => {
        throw new Error(THROWING_GETTER_MESSAGE);
      },
      enumerable: true,
      configurable: true,
    });
  }
  for (const key of spec.omit ?? []) {
    delete config[key];
  }

  return config;
}

/**
 * The live `networks[name]` entry of a fixture config, for post-resolution
 * mutation tests (INV-9). Throws rather than returning undefined, so a fixture
 * drift shows up as a fixture error instead of a vacuously passing assertion.
 */
export function mutableNetworkEntry(
  config: Record<string, unknown>,
  name = 'development',
): Record<string, unknown> {
  const networks = config.networks;
  if (typeof networks !== 'object' || networks === null) {
    throw new Error('fixture config has no networks object');
  }
  const entry = (networks as Record<string, unknown>)[name];
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`fixture config has no networks[${name}] entry`);
  }
  return entry as Record<string, unknown>;
}

/** The `working_directory`-only lineage shape used by `classifyBinding` tests. */
export function bindingProbeConfig(binding: Binding): Record<string, unknown> {
  return configFixture({ binding });
}

export const THROWING_GETTER_TEXT = THROWING_GETTER_MESSAGE;
