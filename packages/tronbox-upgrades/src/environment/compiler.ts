import {
  ConfigReadFailureError,
  failInvariant,
  failMalformed,
  readLineageProperty,
  requireObjectLike,
  requireString,
  type CompilerScalarField,
  type ConfigLineage,
  type ConfigLineages,
  type ConfigReadFailure,
} from './config-lineage';
import {
  isObjectLike,
  readOwnProperty,
  type InternalPathRecorder,
} from './handles';
import type {
  CompilerConfiguration,
  CompilerSettingsSource,
} from './types';

/**
 * **How to read the host citations in this module.** Every `src/components/…`
 * path and line number below is a path into a **TronBox git clone** at tag
 * `v4.9.0` or `v4.8.0`, not into the installed package: the published npm
 * package ships only `build/`, transpiled to one physical line per file, so
 * `src/` has no line numbers a consumer can check from a package root. What a
 * consumer *can* check is `build/`, and every claim here is additionally pinned
 * against it — a captured live probe of `compilerConfiguration` asserts eleven
 * exact expressions in `build/components/TronSolc.js` and
 * `build/components/Compile/index.js`, and passes on both minors. The clone paths
 * are for reading; the probe is the verification.
 */

/**
 * TronBox's own built-in compiler version, taken when a project selects none.
 *
 * Restated here rather than read, because importing the host by
 * any path is forbidden — `src/components/TronSolc.js:9` is `const maxVersion = '0.8.26'`,
 * module-private, and the module exports it only alongside a function that
 * downloads compilers and calls `process.exit`. Verified present and identical at
 * `v4.9.0` and `v4.8.0`.
 *
 * A restated host constant is a drift risk, so it is exported and
 * {@link CompilerConfiguration.versionIsHostDefault} says when it was used — a
 * consumer never has to decide whether a version it received came from the
 * project or from this line.
 */
export const HOST_DEFAULT_SOLC_VERSION = '0.8.26';

/**
 * The two versions the legacy flags select. `src/components/TronSolc.js:70`
 * and `:72`, verified at `v4.9.0` and `v4.8.0`.
 */
const LEGACY_COMPILER_VERSIONS = Object.freeze({
  useZeroFourCompiler: '0.4.25',
  useZeroFiveCompiler: '0.5.4',
} as const);

type LegacyFlag = keyof typeof LEGACY_COMPILER_VERSIONS;

/** Which config key selected the version, for the refusal message's field name. */
type VersionSource =
  | 'host default'
  | LegacyFlag
  | 'compilers.solc.version'
  | 'networks.compilers.solc.version';

export interface CompilerScalarValues {
  readonly 'compiler.resolvedVersion': string;
  readonly 'compiler.family': 'tvm' | 'evm';
  /** `null`, not absent: the record's keys must be exactly the compared group. */
  readonly 'compiler.viaLegacyFlag': LegacyFlag | null;
  readonly 'compiler.versionIsHostDefault': boolean;
  readonly 'compiler.settingsSource': CompilerSettingsSource;
}

/**
 * The same correspondence `NetworkScalarValuesCoverage` asserts, for the same
 * reason: `resolveGroup` returns one lineage's record as the *agreed* record on
 * the strength of having compared every key in the group, which holds only while
 * this record's keys are exactly that group. A key outside it would be taken from
 * the deployer lineage uncompared — exactly the silent lineage-preference
 * this seam refuses, reintroduced one field at a time.
 */
type AssertTrue<T extends true> = T;
export type CompilerScalarValuesCoverage = AssertTrue<
  [keyof CompilerScalarValues] extends [CompilerScalarField]
    ? [CompilerScalarField] extends [keyof CompilerScalarValues]
      ? true
      : false
    : false
>;

/** What a project with no solc settings compiles with: `Compile/index.js:69`'s `|| {}`. */
const NO_SETTINGS: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * The host's optional-chain reads, reproduced hop by hop.
 *
 * `TronSolc.js:74-75` reads `options.networks.compilers?.solc?.version` and
 * `options.compilers?.solc?.version`, and `Compile/index.js:69` reads
 * `options.compilers?.solc?.settings`. `?.` ends the chain at `undefined` for a
 * nullish hop, and a non-nullish primitive hop yields `undefined` from the next
 * property read — so every non-object hop ends at `undefined` without throwing,
 * which is what this returns.
 *
 * Two departures from a literal `?.`, both deliberate:
 * - Own-property reads, so a key inherited from a prototype is not
 *   mistaken for one the project configured.
 * - A hop whose getter *throws* is `handle-malformed` rather than `undefined`,
 *   because a raising host accessor must be named by the seam instead of
 *   silently reporting the absence it is not.
 *
 * Nothing beyond the hop that ended the chain is recorded, so `internalPathsRead`
 * stays exactly what was read.
 */
function ownChainFrom(
  lineage: ConfigLineage,
  owner: unknown,
  basePath: string,
  hops: readonly string[],
  recorder: InternalPathRecorder,
): unknown {
  let current = owner;
  let path = basePath;

  for (const hop of hops) {
    path = `${path}.${hop}`;
    if (!isObjectLike(current)) {
      return undefined;
    }
    const read = readOwnProperty(current, hop, path, recorder);
    if (!read.ok) {
      return read.reason === 'threw'
        ? failMalformed(lineage, path, 'threw')
        : undefined;
    }
    current = read.value;
  }

  return current;
}

function ownChain(
  lineage: ConfigLineage,
  hops: readonly string[],
  recorder: InternalPathRecorder,
): unknown {
  return ownChainFrom(
    lineage,
    lineage.config,
    lineage.prefix,
    hops,
    recorder,
  );
}

/**
 * `Object.keys` guarded: the argument is object-like by construction here,
 * but a host object may still be exotic enough to raise from its own trap, and no
 * host throw leaves the seam.
 */
function ownKeyCount(
  lineage: ConfigLineage,
  value: Record<PropertyKey, unknown>,
  path: string,
): number {
  try {
    return Object.keys(value).length;
  } catch {
    return failMalformed(lineage, path, 'threw');
  }
}

/**
 * Which key supplies the settings, reproducing `Compile/index.js:69` exactly:
 * `Object.keys(options.solc).length ? options.solc : options.compilers?.solc?.settings || {}`.
 *
 * `solc` is read strictly, unlike `compilers`, because the two keys are not the
 * same kind of thing on a `Config`. `Config.js:50` and `:63` declare `solc` with a
 * default of `{}`, so it is an own enumerable accessor on every live Config and is
 * copied onto every `config.with` snapshot — an absent `solc` means the object is
 * not a TronBox Config at all. `compilers` is declared nowhere and exists only
 * when the project's `tronbox.js` supplies one, through
 * `Config.prototype.merge`'s `self[key] = clone[key]`, so its absence is the
 * common case. Verified at `v4.9.0` and `v4.8.0`.
 *
 * A *nullish* `solc` is reachable — `addProp`'s getter is truthiness-guarded, so
 * `solc: 0` in a `tronbox.js` reads back as `undefined` — and the host refuses it
 * one step later at `Compile/index.js:26`, `expect.options(options, […, 'solc'])`,
 * whose `has` is `if (options[key] == null) throw`. The seam reports the host's own
 * refusal rather than inventing a second wording for a project TronBox also
 * rejects.
 */
function settingsSourceOf(
  lineage: ConfigLineage,
  recorder: InternalPathRecorder,
): CompilerSettingsSource {
  const solc = readLineageProperty(lineage, 'solc', recorder);
  if (solc === undefined || solc === null) {
    return failInvariant(
      'Config field "solc" is absent. TronBox refuses to compile a project ' +
        'whose "solc" is nullish — `expect.options` reports "Expected ' +
        'parameter \'solc\' not passed to function." — and a `solc` configured ' +
        'as any falsy value reads back this way, because the Config getter is ' +
        'truthiness-guarded.',
    );
  }

  const record = requireObjectLike(solc, 'solc', 'an object of solc settings');
  if (ownKeyCount(lineage, record, `${lineage.prefix}.solc`) > 0) {
    return 'solc';
  }

  const nested = ownChain(
    lineage,
    ['compilers', 'solc', 'settings'],
    recorder,
  );
  // The host's `|| {}`, so a falsy `settings` is the same as none at all.
  return nested ? 'compilers.solc.settings' : 'none';
}

/**
 * Reads and resolves every compiler scalar off one lineage.
 *
 * The precedence is `TronSolc.js:getWrapper` line for line, including the two
 * places it is easy to get subtly wrong:
 *
 * 1. **The legacy flags are applied first and then overridden.** A project with
 *    both `useZeroFourCompiler` and `compilers.solc.version` uses the version, so
 *    `viaLegacyFlag` is `null` there — a flag that did not decide the outcome must
 *    not be reported as the reason for it.
 * 2. **The whole selection block is inside `if (options.networks)`.** A falsy
 *    `networks` skips it, so no configured version is consulted at all and the
 *    host's default is taken. `addProp`'s truthiness-guarded getter means
 *    `networks: null` in a `tronbox.js` reads back as `undefined`, which is how a
 *    project reaches that branch.
 *
 * Note where the flags and the network-level version are read from: the `networks`
 * **map**, not the selected network's entry. That is the host's own shape —
 * `options.networks.useZeroFourCompiler` and
 * `options.networks.compilers?.solc?.version` — and the seam reproduces it rather
 * than the shape it would have chosen, because guessing differently means naming a
 * different compiler than the one that produced the artifacts on disk.
 */
export function projectCompilerValues(
  lineage: ConfigLineage,
  recorder: InternalPathRecorder,
): CompilerScalarValues | ConfigReadFailure {
  try {
    // `path.join(homedir(), '.tronbox', options.evm ? 'evm-solc' : 'solc')`.
    // `evm` is not a declared Config prop; it arrives from the CLI's `--evm` and
    // is merged on as a plain data property, so absence is the common case.
    const family = ownChain(lineage, ['evm'], recorder) ? 'evm' : 'tvm';

    const networksPath = `${lineage.prefix}.networks`;
    const networks = readLineageProperty(lineage, 'networks', recorder);

    let source: VersionSource = 'host default';
    let rawVersion: unknown = HOST_DEFAULT_SOLC_VERSION;
    let viaLegacyFlag: LegacyFlag | null = null;

    if (networks) {
      for (const flag of ['useZeroFourCompiler', 'useZeroFiveCompiler'] as const) {
        if (ownChainFrom(lineage, networks, networksPath, [flag], recorder)) {
          source = flag;
          rawVersion = LEGACY_COMPILER_VERSIONS[flag];
          viaLegacyFlag = flag;
          break;
        }
      }

      const networkVersion = ownChainFrom(
        lineage,
        networks,
        networksPath,
        ['compilers', 'solc', 'version'],
        recorder,
      );
      const globalVersion = ownChain(
        lineage,
        ['compilers', 'solc', 'version'],
        recorder,
      );

      // The host's own order: global wins over network-level, and either
      // overrides a legacy flag that already fired.
      if (globalVersion) {
        source = 'compilers.solc.version';
        rawVersion = globalVersion;
        viaLegacyFlag = null;
      } else if (networkVersion) {
        source = 'networks.compilers.solc.version';
        rawVersion = networkVersion;
        viaLegacyFlag = null;
      }
    }

    return Object.freeze({
      // A string, and nothing more. `TronSolc.js:82` additionally refuses a
      // version not matching `/^\d+\.\d+\.\d+$/` and one above its own ceiling,
      // both by `process.exit(1)`. The seam reproduces neither: which versions are
      // usable is a support policy, and a seam that owned a second version gate
      // would have to be kept in step with the consumer that owns the first.
      'compiler.resolvedVersion': requireString(rawVersion, source),
      'compiler.family': family,
      'compiler.viaLegacyFlag': viaLegacyFlag,
      'compiler.versionIsHostDefault': source === 'host default',
      'compiler.settingsSource': settingsSourceOf(lineage, recorder),
    });
  } catch (error) {
    if (error instanceof ConfigReadFailureError) {
      return error.failure;
    }
    throw error;
  }
}

export type CompilerSettingsOutcome =
  | {
      readonly status: 'resolved';
      readonly settings: Readonly<Record<string, unknown>>;
    }
  | { readonly status: 'failed'; readonly failure: ConfigReadFailure }
  | { readonly status: 'conflict' };

/**
 * A deep copy, so no slot field aliases a host-owned mutable object.
 *
 * A shallow copy would not do it. A consumer spreads these settings into a solc
 * standard-JSON input, and a shallow copy's `optimizer` is still the user's own
 * object — an edit would reach their next `tronbox compile`.
 *
 * `structuredClone` rather than a hand-rolled walk or a JSON round-trip: it is
 * cycle-safe, and it preserves every value it copies unchanged, so it is a copy
 * and not a normalization (the seam's only normalization list is closed at two
 * `network_id` entries). It drops the prototype of a class instance, which is the one
 * difference, and is no loss here — the host's own `Compile/index.js:107`
 * serializes these settings with `JSON.stringify`, which keeps no prototype
 * either.
 *
 * The refusal deliberately does not quote the underlying error. Node's
 * `DataCloneError` message embeds the offending value — for a function, its
 * source text — and source content is forbidden in any error the seam renders.
 */
function copyOutSettings(
  value: Record<PropertyKey, unknown>,
  field: string,
): Readonly<Record<string, unknown>> {
  try {
    return Object.freeze(
      structuredClone(value) as Record<string, unknown>,
    );
  } catch {
    return failInvariant(
      `Config field "${field}" could not be copied out of the TronBox ` +
        'config: it holds a value that is not structured-cloneable, such as a ' +
        'function or a symbol. TronBox serializes these settings with ' +
        '`JSON.stringify`, which would silently drop such a value, so the ' +
        'plugin cannot reproduce the compilation faithfully.',
    );
  }
}

/**
 * Cross-checks the solc settings across lineages, then copies them out.
 *
 * Separate from {@link projectCompilerValues} because the settings are an object
 * and every member of a compared field group is rendered verbatim into an
 * `inconsistent` message. Comparing them here by identity and reporting a
 * disagreement as the payload-free `compiler-settings-conflict` keeps them
 * cross-checked without putting a user-supplied object anywhere near a message —
 * the instrument `chain-handle-conflict` already uses for exactly this.
 *
 * Identity is the right comparison rather than a weaker one, because the host's own
 * flows make the two lineages hold the *same* object: under `tronbox migrate` both
 * reach one `Config`, and `Config.prototype.normalize` builds a `config.with`
 * snapshot with `clone[key] = obj[key]`, which copies an object-valued key by
 * reference. Verified at `v4.9.0` and `v4.8.0`.
 *
 * `source` comes from the already-agreed value record, so both lineages are known
 * to resolve their settings from the same key before this runs.
 */
export function compareCompilerSettings(
  lineages: ConfigLineages,
  source: CompilerSettingsSource,
  recorder: InternalPathRecorder,
): CompilerSettingsOutcome {
  if (source === 'none') {
    return Object.freeze({ status: 'resolved', settings: NO_SETTINGS });
  }

  const hops =
    source === 'solc' ? ['solc'] : ['compilers', 'solc', 'settings'];

  try {
    const found: unknown[] = [];
    for (const attempt of [lineages.viaDeployer, lineages.viaArtifacts]) {
      if (attempt.status === 'present') {
        found.push(ownChain(attempt.lineage, hops, recorder));
      }
    }

    const [first, second] = found;
    if (found.length === 2 && !Object.is(first, second)) {
      return Object.freeze({ status: 'conflict' });
    }

    return Object.freeze({
      status: 'resolved',
      settings: copyOutSettings(
        requireObjectLike(first, source, 'an object of solc settings'),
        source,
      ),
    });
  } catch (error) {
    if (error instanceof ConfigReadFailureError) {
      return Object.freeze({ status: 'failed', failure: error.failure });
    }
    throw error;
  }
}

/**
 * Total function of the agreed scalars and the copied-out settings — every
 * failure already happened in {@link projectCompilerValues} or
 * {@link compareCompilerSettings}.
 *
 * `viaLegacyFlag` is spread conditionally rather than assigned `undefined`, so
 * under `exactOptionalPropertyTypes` the field is genuinely absent when no flag
 * decided the version.
 */
export function buildCompilerConfiguration(
  values: CompilerScalarValues,
  settings: Readonly<Record<string, unknown>>,
): CompilerConfiguration {
  const flag = values['compiler.viaLegacyFlag'];
  return Object.freeze({
    resolvedVersion: values['compiler.resolvedVersion'],
    settings,
    family: values['compiler.family'],
    ...(flag === null ? {} : { viaLegacyFlag: flag }),
    versionIsHostDefault: values['compiler.versionIsHostDefault'],
    settingsSource: values['compiler.settingsSource'],
  });
}

/** Re-exported for the resolver's field-group comparison. */
export type { CompilerScalarField };
