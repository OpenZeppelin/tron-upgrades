/**
 * The plugin's output and warning channel: the structural minima it needs from a
 * host, the enumerated degraded-mode registry, and the channel's own surface.
 *
 * `src/output/**` imports **nothing** — not `src/environment/**`, not
 * another sub-feature's module, not a package. Everything this channel needs from
 * the environment seam is declared here as a structural minimum and satisfied by
 * assignability. The duplication is deliberate and is what makes the
 * option/result surface a dependency root in the code and not only in the
 * plan; it is kept from drifting by a type-level assignment in the **test**
 * suite, which creates no import edge in either direction.
 */

/**
 * The guaranteed method surface of a host-injected logger — exactly `log`.
 *
 * Four of TronBox's five logger-injection paths supply a
 * single-method object (`migrate --quiet`, `lib/test.js`'s migration phase,
 * `Config`'s own default, and the `Deployer`'s fallback); only the un-quieted CLI
 * path supplies `console`. Declaring one method is what makes `sink.warn(...)`
 * **unwritable** anywhere in the package: an unprobed `warn` call is a
 * `TypeError` for exactly the users who asked for less output, which turns
 * the required degraded-mode statement into a crash. Richer capability is
 * discovered by a `typeof` probe at the emitter, never assumed here.
 */
export interface LogSink {
  log(...args: unknown[]): void;
}

/**
 * The structural minimum the channel needs from a host.
 * `src/environment/types.ts:OutputChannelSlot` is assignable to this with no
 * import and no source change; a second host supplies the same three facts from
 * wherever it keeps them.
 */
export interface HostChannelFacts {
  readonly logger: LogSink;
  /**
   * Which lineage supplied the sink. **Provenance for diagnostics only — not a
   * delivery signal, in either value.** `'deployer'` discards under
   * `tronbox migrate --quiet` and under every `tronbox test` run;
   * `'config-lineage'` discards in the one context it occurs, because TronBox's
   * `Config` defaults `logger` to `{ log(){} }`. Only the un-quieted CLI path is
   * live. No branch anywhere in the plugin reads this to decide whether to write.
   */
  readonly origin: 'deployer' | 'config-lineage';
  /**
   * Reported for diagnostics. `false` does **not** mean output is visible: under
   * `tronbox test` the injected logger is a noop that no flag produced, and a
   * config-file `quiet: true` yields `config.quiet === true` alongside
   * `config.logger === console`. Never read in a conditional.
   */
  readonly hostQuietRequested: boolean;
}

/**
 * Every reduced-fidelity or fallback behaviour anywhere in the plugin has exactly
 * one member here. One enumerated list is what makes the disclosure
 * requirement's *"zero silent degraded paths"* checkable in one place instead
 * of by grep, and no sub-feature may invent an out-of-band degraded signal —
 * not a boolean on a result, not a magic string, not a log line.
 *
 * Adding a member is a minor change; removing or renaming one is major.
 */
export type DegradedCode =
  /** The namespaced/base-slot follow-on: slot-level namespace checking unavailable; names only. */
  | 'namespaced-ast-only'
  /** The validation ladder: `storageLayout` absent from TronBox's compiler `outputSelection`. */
  | 'storage-layout-unavailable'
  /** The proxy operations: the build-info index could not be built, so artifact naming is not decidable. */
  | 'artifact-name-indeterminate'
  /** `upgrades-core` emitted a `Warning` that the plugin relayed verbatim. */
  | 'engine-warning'
  /**
   * `upgrades-core` emitted a `Note` that the plugin relayed verbatim.
   * A note is a *reduced-fidelity validation statement* — upstream's
   * `dist/validate/run/initializer.js` reports *"Reinitializers are not included
   * in validations by default"* through it — so dropping it is a disclosure hole
   * and recording it as a warning would mislabel it.
   */
  | 'engine-note'
  /**
   * The channel reached its documented `recorded` cap and stopped appending.
   * Added while implementing: the truncation note is itself a
   * `DegradedNote`, so under the per-member coverage requirement it needs its
   * own member — reusing any of the five above would mislabel it, and
   * dropping it would make truncation silent.
   */
  | 'notes-truncated';

/**
 * The runtime enumeration of {@link DegradedCode}, proved complete in both
 * directions by the compiler: `satisfies` rejects a member the union does not
 * have, and `_DegradedCodesComplete` rejects a union member this list omits.
 * The per-member coverage requirement's *"each member is covered by at least
 * one test"* can therefore iterate data instead of a hand-written list that
 * silently falls behind.
 */
export const degradedCodes = [
  'namespaced-ast-only',
  'storage-layout-unavailable',
  'artifact-name-indeterminate',
  'engine-warning',
  'engine-note',
  'notes-truncated',
] as const satisfies readonly DegradedCode[];

/** Compile error naming any member the list above omits. No runtime emission. */
type NoMissingMembers<Missing extends never> = Missing;
type _DegradedCodesComplete = NoMissingMembers<
  Exclude<DegradedCode, (typeof degradedCodes)[number]>
>;

/**
 * One reduced-fidelity statement. Every field is required and every one is
 * meaningful: a note that says a path degraded but not what to do about
 * it satisfies the disclosure requirement's letter and defeats its purpose.
 *
 * The note **rides the operation's returned result** (`OperationResult.notes`).
 * The advisory write to the host sink is a courtesy — under `tronbox test`, the
 * command that forces a full replay of every migration on every run, no advisory
 * output survives at all, so a design that discharged the disclosure requirement
 * through the log would be broken for every test run.
 */
export interface DegradedNote {
  readonly code: DegradedCode;
  /** One line naming the actual state. Never empty. */
  readonly summary: string;
  /** Supporting lines. May be empty; never absent. */
  readonly detail: readonly string[];
  /** What the user can do about it. Never empty. */
  readonly remedy: string;
}

/** The plugin's output channel over one host sink, for the life of one operation. */
export interface OutputChannel {
  /**
   * Advisory. Suppressed by `silenceWarnings()`; discarded by the host under
   * `--quiet` and under `tronbox test`. Never load-bearing.
   */
  warn(title: string, detail?: readonly string[]): void;
  /** Advisory, informational. Same suppression as {@link warn}. */
  note(title: string, detail?: readonly string[]): void;
  /**
   * Records a degraded-mode statement and returns it.
   *
   * **The record is the guarantee; the write is a courtesy.** The append
   * happens before any write is attempted and happens when the plugin's silence
   * flag is set, when the host sink discards, and when the write itself throws.
   * Silencing never suppresses a record.
   */
  degraded(note: DegradedNote): DegradedNote;
  /**
   * Everything {@link degraded} recorded, in call order, frozen. Goes onto the
   * operation's result as `notes`. Bounded.
   */
  readonly recorded: readonly DegradedNote[];
  /** Provenance for a failure message the actionable-diagnosis requirement demands. Never a liveness test. */
  readonly origin: HostChannelFacts['origin'];
  /**
   * The channel's self-description, naming which lineage supplied the sink and
   * whether the host asked to be quiet. This is the **only** place either fact is
   * read — it exists so a failure can say where the channel came from
   * without any branch depending on it.
   */
  describe(): string;
}
