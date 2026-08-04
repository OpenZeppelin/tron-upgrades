declare const AbsolutePathBrand: unique symbol;

/**
 * A path asserted absolute at the TronBox environment boundary.
 *
 * INV-2: the brand is mintable only by `assertAbsolutePath`, which refuses a
 * non-absolute input rather than resolving it. Resolving would anchor on a cwd
 * that `build/components/Require.js:Require.file` changes for the migration
 * file's top-level evaluation and restores before the exported function runs.
 */
export type AbsolutePath = string & {
  readonly [AbsolutePathBrand]: true;
};

export type SlotName =
  | 'paths'
  | 'network'
  | 'artifacts'
  | 'chain'
  | 'receipts'
  | 'scheduling'
  | 'output'
  | 'compiler';

export type HandleName =
  | 'deployer'
  | 'artifacts'
  | 'tronWrap'
  | 'tronWeb'
  | 'waitForTransactionReceipt';

/**
 * The five invocation contexts, measured against a real TronBox tree. `plain
 * node` is a named context because `EnvironmentAbsentError` is the diagnosis for
 * it and INV-14 renders `absentIn` from the slot table — an unnamed context
 * renders as an omission.
 */
export type InvocationContextName =
  | 'tronbox migrate'
  | 'tronbox test migration phase'
  | 'tronbox test mocha files'
  | 'tronbox console'
  | 'plain node';

/**
 * TronBox contract abstractions are callable host objects. SF-0 preserves their
 * identity and never models the operation-specific methods on them.
 */
export type ContractAbstraction = object & {
  readonly contract_name?: string;
  readonly contractName?: string;
  readonly sourcePath?: string;
};

export interface TronWrapHandle {
  readonly trx: object;
}

export interface DeployerHandle {
  then(step: (...args: unknown[]) => unknown): unknown;
}

export interface ResolverInterceptHandle {
  require(importPath: string): ContractAbstraction;
  contracts(): ContractAbstraction[];
  readonly resolver: object;
}

export type WaitForTransactionReceipt = (...args: unknown[]) => unknown;

/**
 * INV-35: exactly one method. Four of TronBox's five logger-injection paths
 * supply a single-method object, so `logger.warn` must not be writable
 * anywhere in the package — a `warn` call is a `TypeError` under `--quiet`,
 * under `tronbox test`, and through the deployer's own wrapper.
 */
export interface TronBoxLogger {
  log(...args: unknown[]): void;
}

export interface ProjectPaths {
  readonly root: AbsolutePath;
  readonly contractsDirectory: AbsolutePath;
  readonly contractsBuildDirectory: AbsolutePath;
  readonly buildInfoDirectory: AbsolutePath;
  /** INV-3: observed by containment, never inferred from an upstream flag. */
  readonly contractsBuildDirectoryIsExternal: boolean;
}

export interface NonAuthoritativeSender {
  readonly kind: 'configured-not-authoritative';
  /**
   * `networks[network].from` as TronBox holds it — not canonicalized (INV-7).
   * INV-4: an upstream `undefined` is normalized to `null` here, because
   * `build/components/TronWrap/constants.js:deployParameters` declares `from`
   * as `undefined` rather than `null`.
   */
  readonly address: string | null;
}

export interface NetworkTxDefaults {
  readonly feeLimit: number | null;
  readonly userFeePercentage: number | null;
  readonly originEnergyLimit: number | null;
  readonly callValue: number | null;
  readonly tokenValue: number | null;
  readonly tokenId: number | null;
}

export interface NetworkEnvironment {
  readonly name: string;
  /** Compatibility metadata about the tool — never evidence about the chain. */
  readonly artifactNetworkId: string;
  /** INV-6: `'*'` is legal and TronBox never resolves it. */
  readonly configuredId: {
    readonly value: string;
    readonly syntax: 'exact' | 'wildcard';
  };
  readonly txDefaults: NetworkTxDefaults;
  readonly sender: NonAuthoritativeSender;
  /** INV-40: derived from presence alone. Never the key. */
  readonly signingKeyConfigured: boolean;
}

export interface ArtifactCandidate {
  readonly sourcePath: string;
  readonly contractName: string;
  readonly buildInfoFile: AbsolutePath;
}

export interface ArtifactNameCollision {
  readonly name: string;
  readonly candidates: readonly ArtifactCandidate[];
}

/**
 * INV-34: a closed union of three mechanisms. INV-42: paths and a cause
 * string only — never file bytes and never a parsed fragment.
 */
export type IndeterminateReason =
  | {
      readonly kind: 'build-info-absent';
      readonly buildInfoDirectory: AbsolutePath;
      readonly artifactTreeIsExternal: boolean;
    }
  | {
      readonly kind: 'build-info-unreadable';
      readonly file: AbsolutePath;
      readonly cause: string;
    }
  | {
      readonly kind: 'build-info-lacks-contract-map';
      readonly file: AbsolutePath;
    };

export type ArtifactAmbiguityReport =
  | {
      readonly status: 'indexed';
      readonly collisions: readonly ArtifactNameCollision[];
      readonly indexedFrom: readonly AbsolutePath[];
    }
  | {
      readonly status: 'indeterminate';
      readonly reason: IndeterminateReason;
    };

/**
 * INV-5: only the verified branch names the abstraction `contract`. The
 * asymmetric field name is the enforcement — storing an unverified abstraction
 * into a `contract`-typed position is impossible without renaming it.
 */
export type ArtifactResolution =
  | {
      readonly status: 'unique';
      readonly name: string;
      readonly contract: ContractAbstraction;
      readonly sourcePath: string;
    }
  | {
      readonly status: 'ambiguous';
      readonly name: string;
      readonly candidates: readonly ArtifactCandidate[];
      readonly unverifiedContract: ContractAbstraction;
    }
  | {
      readonly status: 'indeterminate';
      readonly name: string;
      readonly reason: IndeterminateReason;
      readonly unverifiedContract: ContractAbstraction;
    };

/**
 * The artifact fields a consumer may ask the seam to project, named by their
 * **host key path** rather than by the record member they fill.
 *
 * Named that way because the one thing a consumer does with an absent field is
 * tell the user which key their artifact lacks, and a message naming
 * `longCompilerVersion` would name something no artifact on disk has. The five
 * are exactly TronBox's own artifact allow-list minus the fields nothing needs:
 * `src/components/Compile/index.js:165-179` assembles every artifact from the
 * hard-coded literal `contract_name, sourcePath, source, sourceMap,
 * deployedSourceMap, abi, bytecode, deployedBytecode, unlinked_binary, compiler`,
 * so a field can be absent only because the *host version* predates it — never
 * because of anything about the project. Verified at `v4.9.0`.
 */
export type ArtifactRecordField =
  | 'compiler.version'
  | 'source'
  | 'sourcePath'
  | 'bytecode'
  | 'deployedBytecode';

/**
 * What a compiled contract's artifact says about itself — as plain frozen data,
 * never a view onto the host handle.
 *
 * INV-28 is why this exists at all: every value here lives behind
 * `contract._json`, a TronBox-internal property path, so only
 * `src/environment/**` may read it. A consumer receiving the handle instead and
 * reading `.bytecode` off it would be reading a host shape outside the seam — the
 * boundary this type moves inside it.
 *
 * Every member is a `string`, so INV-9's aliasing hazard does not arise: there is
 * no host-owned mutable object to copy out, unlike
 * {@link CompilerConfiguration.settings}.
 *
 * `longCompilerVersion` is deliberately not called `compilerVersion`. It is the
 * **long** form solc reports — `0.8.26+commit.733b4d28` — and it is the only
 * evidence of which compiler *actually built* this artifact:
 * `~/.tronbox/solc/soljson_v0.8.26.js` and `~/.tronbox/evm-solc/soljson_v0.8.26.js`
 * are different compilers at the same filename shape, so
 * {@link CompilerConfiguration.resolvedVersion} — a version to *request* — cannot
 * stand in for it.
 */
export interface ArtifactRecord {
  readonly longCompilerVersion: string;
  readonly bytecode: string;
  readonly deployedBytecode: string;
  readonly source: string;
  /**
   * The artifact's own record of where it was compiled from. Tool-verbatim and
   * deliberately not resolved against {@link ProjectPaths} — it may be relative,
   * and INV-2 forbids resolving a path against a cwd TronBox moves.
   */
  readonly sourcePath: string;
}

/**
 * Which keys the artifact carried, and which of the five it did not.
 *
 * A report rather than a throw because "this artifact lacks `deployedBytecode`"
 * is a *diagnosis a consumer renders*, with a remedy naming the host version —
 * not a broken invariant. A host accessor that **raises** is the other thing
 * entirely and does not come back through here: INV-15 turns it into
 * `EnvironmentIncompleteError` at the read site, so a consumer never has to tell
 * "absent" and "malfunctioning" apart from one value.
 *
 * `observedKeys` is on **both** variants, not just the failing one. A consumer
 * reporting a missing field wants to say what the artifact did have, and a
 * consumer that got everything still wants it to detect an artifact from a
 * *newer* host than the plugin knows about. Keys only, never values: INV-42
 * forbids file content in anything the seam renders, and `source` is file content.
 */
export type ArtifactRecordReport =
  | {
      readonly status: 'complete';
      readonly record: ArtifactRecord;
      readonly observedKeys: readonly string[];
      readonly internalPathsRead: readonly string[];
    }
  | {
      /** Non-empty by construction — `complete` is the empty case. */
      readonly status: 'incomplete';
      readonly missing: readonly ArtifactRecordField[];
      readonly observedKeys: readonly string[];
      readonly internalPathsRead: readonly string[];
    };

export interface ArtifactAccess {
  resolve(name: string): ArtifactResolution;
  resolvePackaged(packageRelativePath: string): ContractAbstraction;
  ambiguities(): ArtifactAmbiguityReport;
  /**
   * Projects {@link ArtifactRecord} off an abstraction this seam produced.
   *
   * A method rather than a member of {@link ArtifactResolution}'s `unique` branch
   * on purpose. Attaching it there would read `_json` on every `resolve()`,
   * including the callers that want only the name — and, the substantive reason,
   * an incomplete artifact would then need a fourth `ArtifactResolution` status,
   * which is a *relaxation* of INV-5's closed three-variant union rather than an
   * addition to it. Here, absence is a value of this method's own return type and
   * INV-5 is untouched.
   */
  record(contract: ContractAbstraction): ArtifactRecordReport;
  /** INV-24: the write-back path. Never substitute `config.resolver`. */
  readonly intercept: ResolverInterceptHandle;
}

export interface ChainHandleSlot {
  /** INV-27: one name. `tronWeb` is normalized away and never re-exported. */
  readonly tronWrap: TronWrapHandle;
}

export interface ReceiptSlot {
  readonly waitForTransactionReceipt: WaitForTransactionReceipt;
}

export interface SchedulingSlot {
  /** INV-29's one deliberate exception: the whole deployer, named as such. */
  readonly deployer: DeployerHandle;
}

export interface OutputChannelSlot {
  readonly logger: TronBoxLogger;
  /**
   * Which mechanism supplied the logger. `'config-lineage'` may be TronBox's
   * own default noop — `build/components/Config.js:Config` defaults
   * `logger` to `{ log(){} }`, so a lineage-sourced channel can discard
   * output silently. SF-10 needs this discriminant to say so.
   */
  readonly origin: 'deployer' | 'config-lineage';
  /**
   * Whether the host CLI was asked to be quiet, read from the lineage that
   * supplied the channel. `false` does not imply output is visible: under
   * `tronbox test` the injected logger is a noop that no `--quiet` flag
   * produced.
   *
   * Deliberately *not* a cross-checked field (see `ConfigScalarField`). Under
   * `tronbox test` the two lineages genuinely disagree — `performInitialDeploy`
   * calls `config.with({ reset: true, quiet: true, logger: { log(){} } })`, so
   * the deployer's snapshot carries `quiet: true` while the live Config the
   * resolver holds carries no `quiet` key at all. Comparing it would throw
   * `EnvironmentInconsistentError` on every `tronbox test` run. `origin` is what
   * states which lineage this came from, so the choice is reported rather than
   * silent.
   */
  readonly hostQuietRequested: boolean;
}

/**
 * Which config key supplied {@link CompilerConfiguration.settings}.
 *
 * A closed union rather than a boolean because the host's selection is a
 * fall-through over two different keys, and a consumer telling the user which
 * one to edit has to name it. `'none'` is the fall-through's own end:
 * `src/components/Compile/index.js:69` finishes with `|| {}`.
 */
export type CompilerSettingsSource =
  | 'solc'
  | 'compilers.solc.settings'
  | 'none';

/**
 * What TronBox would hand solc if it compiled this project right now.
 *
 * Every member is the *resolved* answer, not a raw config key, because the
 * host's resolution is a precedence chain over five keys and a consumer that
 * re-derived it would be free to derive it differently — which means requesting
 * a different compiler than the artifacts on disk were built with. The chain is
 * reproduced once, here, from `src/components/TronSolc.js:getWrapper` and
 * `src/components/Compile/index.js:69`, verified byte-identical at `v4.9.0` and
 * `v4.8.0`.
 *
 * INV-28 is why this slot exists at all: `compilers.solc.version` and `solc` are
 * TronBox-internal property paths, so only `src/environment/**` may read them.
 */
export interface CompilerConfiguration {
  /**
   * The version string TronBox would look for under `~/.tronbox`, after the
   * host's full precedence chain. Asserted to be a `string` and **not** matched
   * against a shape: which versions are usable is a support policy owned by the
   * consumer, and the seam reporting a version the host would reject is more
   * useful than the seam inventing a second gate.
   */
  readonly resolvedVersion: string;
  /**
   * The solc `settings` object, copied out of the host config (INV-9) and
   * frozen. Never the host's own object: a consumer spreads this into a solc
   * standard-JSON input, and a spread of a live host object would let a
   * consumer's edit reach the user's next `tronbox compile`.
   */
  readonly settings: Readonly<Record<string, unknown>>;
  /** Which of the two `~/.tronbox` compiler trees the host would read. */
  readonly family: 'tvm' | 'evm';
  /**
   * Present only when a legacy flag is what *determined*
   * {@link resolvedVersion} — the flags are applied first and then overridden by
   * either configured version, so a project carrying both a flag and a version
   * is not using the flag. Absent, not `null`, so a consumer's message branch
   * cannot render "via undefined".
   */
  readonly viaLegacyFlag?: 'useZeroFourCompiler' | 'useZeroFiveCompiler';
  /**
   * `true` when nothing in the project selected a version and the host's own
   * built-in default was taken. Two configurations reach it — a falsy
   * `networks`, which makes the host skip its whole selection block, and a
   * `networks` with no compiler version anywhere — and the host produces the
   * same compiler for both, so they are one flag rather than two.
   */
  readonly versionIsHostDefault: boolean;
  /** Which config key {@link settings} came from. */
  readonly settingsSource: CompilerSettingsSource;
}

export interface SlotShapes {
  readonly paths: ProjectPaths;
  readonly network: NetworkEnvironment;
  readonly artifacts: ArtifactAccess;
  readonly chain: ChainHandleSlot;
  readonly receipts: ReceiptSlot;
  readonly scheduling: SchedulingSlot;
  readonly output: OutputChannelSlot;
  readonly compiler: CompilerConfiguration;
}

export type ConfigLineageBinding =
  | 'live-config'
  | 'materialized-snapshot'
  | 'absent';

export interface ConfigLineageProvenance {
  readonly viaDeployer: ConfigLineageBinding;
  readonly viaArtifacts: ConfigLineageBinding;
  /** INV-34 mode 1: `false` iff fewer than two lineages were reachable. */
  readonly crossChecked: boolean;
  readonly crossCheckSkippedBecause?:
    | 'only-deployer-lineage-available'
    | 'only-artifacts-lineage-available';
  /** True under `tronbox migrate`, where both lineages are one object. */
  readonly sameObject: boolean;
}

export interface EnvironmentProvenance {
  readonly slots: Readonly<Record<SlotName, 'present' | 'absent'>>;
  readonly configLineages: ConfigLineageProvenance;
  /**
   * INV-33: every TronBox-internal property path this resolution read, and
   * nothing it did not. Recorded at the read site, never declared centrally.
   * Covers `resolveEnvironment` only — reads performed by a later
   * `resolve()` / `ambiguities()` call are outside this snapshot.
   */
  readonly internalPathsRead: readonly string[];
}

/**
 * INV-1: required slots non-optional, optional slots optional, everything
 * else structurally absent. Requires TypeScript >= 5.0 for the `const` type
 * parameters on `resolveEnvironment` (INV-46).
 */
export type TronBoxEnvironment<
  R extends SlotName = SlotName,
  O extends SlotName = never,
> = {
  readonly [K in R]: SlotShapes[K];
} & {
  readonly [K in O]?: SlotShapes[K];
} & {
  readonly provenance: EnvironmentProvenance;
};

/**
 * INV-25: `unknown` because these cross a trust boundary out of a `vm`
 * sandbox. Typing them as their expected shapes would assert exactly what the
 * shape guards exist to check.
 *
 * **Why they are handed in: a necessity for one, a design choice for another.**
 * Written here because a maintainer who inherits one claim for both will defend
 * the half that does not hold. Verified against the host source at `v4.8.0` and
 * `v4.9.0`.
 *
 * - **Necessity — the live `Config`.** It is reachable only through these
 *   handles, at `deployer.options.options` and `artifacts.resolver.options` (the
 *   two hops `config-lineage.ts` owns). `src/components/Config.js` ends in
 *   `module.exports = Config` — it exports the *constructor*, and every Config in
 *   a run is an instance in a command's local scope. Nothing is memoized at module
 *   scope to recover, and building a fresh one via `Config.detect` computes a
 *   *different* answer than the CLI used, silently.
 * - **A choice — the chain handle.** Hand-off is not the only way to reach it.
 *   `src/components/TronWrap/index.js` is `module.exports = init` over a
 *   module-scope `let instance`, and `init` opens with
 *   `if (instance) { return instance; }`. **The host itself uses the mechanism
 *   that claim denied:** of 11 `TronWrap(` call sites under `src/`, **7 are
 *   argument-less across 5 modules** — `components/Migrate/index.js` (×2),
 *   `components/Deployer/src/actions/deploy.js`, `lib/console.js`,
 *   `lib/environment.js`, `lib/test.js` (×2) — each receiving the live instance
 *   with nothing passed to it.
 *
 * The asymmetry is one sentence: the chain module caches its instance at module
 * scope and `Config` does not. Hand-off remains right for the chain handle on
 * three grounds, in the order they carry weight — not coupling to
 * `tronbox/build/components/TronWrap`, a path reachable only *because* the host
 * publishes no `exports` boundary; portability, since subpath resolution needs the
 * package physically resolvable from the plugin and a global CLI install does not
 * guarantee that; and, **the reason that survives if both are dismissed**, that
 * the failure mode is legible rather than opaque. An absent handle yields
 * `absent`/`incomplete` naming the slot, the handle and the providing contexts,
 * where the subpath alternative throws
 * `TypeError: Cannot read properties of undefined (reading 'fullNode')` from
 * inside the host, naming nothing the user can act on. INV-49 now forbids the
 * alternative outright, which is why the argument is recorded rather than
 * left to be re-derived by whoever next wonders about it.
 */
export interface RawMigrationHandles {
  readonly deployer?: unknown;
  readonly artifacts?: unknown;
  readonly tronWrap?: unknown;
  readonly tronWeb?: unknown;
  readonly waitForTransactionReceipt?: unknown;
}

export type EnvironmentDiagnosis = 'absent' | 'incomplete' | 'inconsistent';

export interface UnsatisfiedSlot {
  readonly slot: SlotName;
  readonly cause:
    | {
        readonly kind: 'handle-missing';
        readonly handle: HandleName;
      }
    | {
        readonly kind: 'handle-malformed';
        readonly handle: HandleName;
        readonly expectedPath: string;
        /**
         * Why the path did not yield a value. `'threw'` is a host getter that
         * raised; `'missing'` is an absent own property. INV-17 turns on these
         * being different states, so the message names which one.
         */
        readonly because: 'missing' | 'threw';
      }
    | {
        readonly kind: 'invariant-violated';
        readonly detail: string;
      };
  /** INV-14: both read from the `slots.ts` table, never authored at a throw site. */
  readonly providedIn: readonly InvocationContextName[];
  readonly absentIn: readonly InvocationContextName[];
}

/**
 * INV-13 / INV-41: the closed allow-list of fields that may be compared
 * between Config lineages and rendered verbatim in a disagreement. An
 * allow-list rather than a deny-list because `config.networks[name]` carries
 * `privateKey` one property away from the values SF-0 legitimately projects,
 * and the `inconsistent` message prints both values.
 *
 * Every scalar the seam exposes from a lineage appears here:
 *   - the four `ProjectPaths` members
 *   - `NetworkEnvironment.name`               -> `network`
 *   - `NetworkEnvironment.artifactNetworkId`  -> `network_id`
 *   - `configuredId.value`                    -> `networks[network].network_id`
 *   - `sender.address`                        -> `from`
 *   - the six `txDefaults`
 *   - `signingKeyConfigured` — a boolean by construction, derived from the
 *     presence of `networks[network].privateKey`, so it cannot carry the key
 *     into a rendered message. Included because leaving an exposed scalar out
 *     of the list would reinstate, for that one field, exactly the silent
 *     preference INV-12 closes.
 *
 * `OutputChannelSlot.hostQuietRequested` is the one exposed lineage-derived
 * scalar deliberately excluded — see its doc comment for why comparing it would
 * fail every `tronbox test` run.
 *
 * The `compiler.*` members are the six-field `CompilerConfiguration` minus its
 * one non-scalar, `settings`. They are named for the resolved value rather than
 * for a host key because that is what the slot exposes, the same choice
 * `signingKeyConfigured` already makes; comparing the five raw keys the host's
 * precedence chain reads would report a disagreement the resolution collapses.
 * `settings` is an object, so it cannot be a member of a type named
 * `ConfigScalarField` and — the substantive reason — INV-41 renders every member
 * of this list **verbatim** into an `inconsistent` message, which is exactly what
 * an arbitrary user-supplied object must not be subjected to. It is cross-checked
 * all the same, by object identity, and a disagreement is reported as the
 * payload-free `compiler-settings-conflict` — the same instrument
 * `chain-handle-conflict` already uses for a host-reference disagreement.
 */
export type ConfigScalarField =
  | 'working_directory'
  | 'contracts_directory'
  | 'contracts_build_directory'
  | 'build_info_directory'
  | 'network'
  | 'network_id'
  | 'networks[network].network_id'
  | 'from'
  | 'feeLimit'
  | 'userFeePercentage'
  | 'originEnergyLimit'
  | 'callValue'
  | 'tokenValue'
  | 'tokenId'
  | 'signingKeyConfigured'
  | 'compiler.resolvedVersion'
  | 'compiler.family'
  | 'compiler.viaLegacyFlag'
  | 'compiler.versionIsHostDefault'
  | 'compiler.settingsSource';

export type Inconsistency =
  | {
      readonly kind: 'config-lineage-field';
      readonly field: ConfigScalarField;
      readonly viaDeployer: unknown;
      readonly viaArtifacts: unknown;
    }
  | {
      readonly kind: 'artifacts-not-wrapping-deployer-resolver';
    }
  | {
      readonly kind: 'chain-handle-conflict';
    }
  | {
      /**
       * The two lineages resolved solc settings to different objects. Carries no
       * payload for the same reason `chain-handle-conflict` does not: the
       * disagreeing values are host objects, and INV-41's discipline is that
       * nothing rendered verbatim may be anything but an allow-listed scalar.
       * `compiler.settingsSource` is the scalar that names *where* the settings
       * came from, so the legible half of the disagreement is already reported.
       */
      readonly kind: 'compiler-settings-conflict';
    };
