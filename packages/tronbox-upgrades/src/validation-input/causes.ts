import { ValidationInputInvariantError } from './errors';

/**
 * The closed union of the seven reasons the validation pipeline cannot produce
 * a validation input, and nothing else. Pure data: no policy, no rendering, no
 * I/O.
 *
 * **Closed is the property that matters.** It is what makes one
 * `could not validate` covering seven different situations unrepresentable —
 * the actionable-diagnosis failure the enumeration exists to prevent — and it
 * is what makes *"any obligation the validation pipeline owes a diagnosis for
 * has a member"* checkable rather than aspirational. Adding an obligation adds
 * a member; there is no `throw` at a call site for a condition that lacks one.
 *
 * **Every payload field is a scalar, a closed union, or a list of records made
 * of exactly those — the scalars-only rule.** That is not a convention asking
 * politely: there is no field on any member that a Solidity source string, a
 * settings object, a host handle or an upstream `Error` could be assigned to,
 * so the leak is unrepresentable rather than filtered. The one non-scalar
 * payload, cause 6's `rejected` list, is a `readonly` array of
 * {@link BuildRecordRejection} — a file path plus a closed-union reason — and
 * carries the same property member-wise. The source-confinement rule confines
 * source text to `solcInput.sources[key].content` elsewhere, and this type is
 * half of why that holds.
 *
 * ── The Foundry-model cause-set change (review decision, 2026-08-07) ─────────
 *
 * This union used to have eleven members, four of them about the plugin's own
 * embedded compiler. The maintainer decision to adopt the Foundry model —
 * validate from the build record TronBox already wrote, never compile —
 * changed the set as follows:
 *
 * | cause | fate |
 * |---|---|
 * | `compiler-absent`, `compiler-mismatched`, `compiler-resource-exhausted`, `sources-do-not-compile` | DELETED — no plugin compile exists |
 * | `artifact-stale` | ABSORBED into `build-record-stale` — the recompiled-vs-artifact comparison is gone; record-vs-artifact bytecode freshness is what remains, and its refusal names the rejected records per file |
 * | `layout-vacuous` | DELETED — its only producer was the compile arm; on the record path the same hazard is decided per candidate at the gate (`target-definition-absent`) and flows into `build-record-stale` |
 * | `build-record-absent`, `build-record-stale` | NEW — the two Foundry-model refusals, both remedied by `tronbox compile --all` |
 * | `compiler-unsupported`, `source-unreadable`, `import-unresolvable`, `artifact-shape-unsupported`, `library-name-unsupported` | KEPT unchanged |
 */
export type Cause =
  /**
   * 1 — the project's compiler version is outside `SUPPORTED_SOLC`.
   *
   * No compiler is ever loaded, but the range still gates which solc *output*
   * this plugin interprets: the build record the pipeline validates from was
   * produced by the project's compiler, and this plugin is verified only
   * across the declared range. The gate is on the *version* rather than on
   * the output because measurement showed a sub-0.5.13 compiler accepting a
   * `storageLayout` request with zero diagnostics of any severity and simply
   * omitting the key.
   */
  | {
      readonly kind: 'compiler-unsupported';
      readonly resolvedVersion: string;
      readonly viaLegacyFlag?: 'useZeroFourCompiler' | 'useZeroFiveCompiler';
    }
  /**
   * 2 — a source in the closure is missing or unreadable.
   *
   * The **path**, never the bytes — the scalars-only and source-confinement
   * rules together. `because` separates the two remedies: a file that is gone
   * is restored, a file that is present and unreadable is a permission or
   * encoding problem.
   */
  | {
      readonly kind: 'source-unreadable';
      readonly sourceKey: string;
      readonly path: string;
      readonly because: 'missing' | 'unreadable';
    }
  /**
   * 3 — an import cannot be resolved to a source the host could have compiled.
   *
   * Both halves are needed: the specifier alone does not say which file to
   * edit. The walk that discovers this is also what derives the target's
   * source key — the key the build record's `contracts` map is indexed by —
   * so an unresolvable reference stops the validation before any record is
   * consulted.
   */
  | {
      readonly kind: 'import-unresolvable';
      readonly importedBy: string;
      readonly specifier: string;
    }
  /**
   * 4 — the artifact lacks a field the validation pipeline requires.
   *
   * `missingField` is a closed union rather than a free string, so a new
   * requirement cannot be reported as a generic absence. Its five
   * members are exactly the seam's `ArtifactRecordField`, which is TronBox's own
   * artifact allow-list minus what nothing needs — so a field can be absent only
   * because the host version predates it, which is precisely what the remedy
   * says.
   */
  | {
      readonly kind: 'artifact-shape-unsupported';
      readonly contract: string;
      readonly missingField:
        | 'compiler.version'
        | 'source'
        | 'sourcePath'
        | 'bytecode'
        | 'deployedBytecode';
      readonly providedSince: string;
    }
  /**
   * 5 — no build record exists for this contract at all.
   *
   * `because` separates three situations with one remedy: the build-info
   * directory is not there, it could not be read, or it is there and readable
   * and simply holds no record naming this source-key/contract pair. All
   * three mean the same thing to the Foundry model — there is nothing to
   * validate from — and `tronbox compile --all` regenerates the record
   * unconditionally, because the `--all` flag forces recompilation of
   * unchanged sources, so the remedy always works.
   */
  | {
      readonly kind: 'build-record-absent';
      readonly because:
        | 'directory-absent'
        | 'directory-unreadable'
        | 'no-record-for-target';
    }
  /**
   * 6 — records were located for this pair and every candidate was rejected.
   *
   * The payload is the gate's own per-file evidence: which record failed and
   * why, one {@link BuildRecordRejection} per candidate examined. The common
   * single-candidate case is `deployed-bytecode-differs` — the record TronBox
   * wrote no longer describes the compiled artifact, i.e. one of the two is
   * stale — and the remedy is the same `tronbox compile --all`, which
   * regenerates both sides of the comparison at once.
   *
   * This member absorbs the old `artifact-stale` cause: the recompiled-vs-
   * artifact comparison it reported is gone with the embedded compiler, and
   * the record-vs-artifact freshness comparison that remains is decided here,
   * per candidate, with the file named.
   */
  | {
      readonly kind: 'build-record-stale';
      readonly rejected: readonly BuildRecordRejection[];
    }
  /**
   * 7 — a linked library's name is past the length the host can encode.
   *
   * Measured directly: `Compile/index.js:replaceLinkReferences` builds
   * `'__' + name`, pads with `_` while shorter than 40 and splices over a
   * 40-character window without ever truncating, while upgrades-core
   * normalizes on `/__\w{36}__/g`. So 37–38
   * characters leaves the artifact intact and makes `hashBytecode` throw, and
   * ≥ 39 lengthens the artifact's bytecode and shifts every following byte. The
   * message names the library and the band because upgrades-core's own
   * `Bytecode is not a valid hex string` names neither.
   */
  | {
      readonly kind: 'library-name-unsupported';
      readonly libraryName: string;
      readonly length: number;
      readonly band: '37-38' | '>=39';
    };

/**
 * One located build record, with the reason it could not be used.
 *
 * Declared here rather than in `pipeline.ts` because it is cause 6's payload
 * vocabulary — pure data, closed, and importable by `diagnose.ts` without a
 * second module specifier. The pipeline's gate constructs it and re-exports
 * the type for provenance consumers.
 *
 * The reasons, in the order the gate decides them per candidate:
 *
 * - `'nothing-to-compare'` — the record or the artifact carries no deployed
 *   bytecode to verify (an abstract contract or interface is the honest case:
 *   `'0x'` against `''` is a match of two absences, not evidence).
 * - `'deployed-bytecode-differs'` — the record's deployed bytecode is not the
 *   artifact's, so the record describes some other compile.
 * - `'ast-closure-incomplete'` — the record verified but does not carry an AST
 *   for every source in the target's import closure, so the layout the engine
 *   reconstructs from it would be built on missing sources.
 * - `'target-definition-absent'` — the record verified but its AST for the
 *   target source declares no contract of this name, so the reconstructed
 *   reference layout would be empty against a contract that is not.
 * - `'input-pair-absent'` — the record verified but its paired `<hash>.json`
 *   compiler input, which the Foundry model hands to consumers as the
 *   validation's `solcInput`, does not exist next to it.
 * - `'input-pair-unparseable'` — the pair exists and is not valid JSON.
 * - `'input-pair-unusable'` — the pair parses but is not the solc
 *   standard-JSON input of this output: wrong shape, or missing a source the
 *   record's own output covers.
 */
export interface BuildRecordRejection {
  readonly file: string;
  readonly reason:
    | 'deployed-bytecode-differs'
    | 'nothing-to-compare'
    | 'ast-closure-incomplete'
    | 'target-definition-absent'
    | 'input-pair-absent'
    | 'input-pair-unparseable'
    | 'input-pair-unusable';
}

/**
 * The oldest TronBox *verified* to carry all five artifact fields cause 4 can
 * name.
 *
 * Read from the host's own hard-coded artifact literal at both supported minors:
 * `src/components/Compile/index.js:165-179` at `v4.9.0` and
 * `:166-180` at `v4.8.0` in the TronBox **clone** — the host's own repository at
 * those tags, not the installed package, whose `build/` is one physical line per
 * file. Byte-identical in the fields that matter —
 * `contract_name, sourcePath, source, sourceMap, deployedSourceMap,
 * abi, bytecode, deployedBytecode, unlinked_binary, compiler`. Deliberately
 * *not* the package's declared peer range (`>=4.0.0`): nothing measured says
 * these fields were present at 4.0.0, and cause 4's whole job is to name a
 * version a user can act on.
 */
export const ARTIFACT_FIELDS_VERIFIED_SINCE = '4.8.0';

/**
 * The runtime enumeration of {@link Cause}, proved complete in both directions by
 * the compiler.
 *
 * `satisfies` rejects a kind the union does not have;
 * {@link _CauseKindsComplete} rejects a union member this list omits. The idiom is
 * the package's own — `src/output/types.ts:97-110` and
 * `src/environment/compiler.ts:88` — and the reason for preferring it to a
 * runtime `switch` default is that a default only fires when a new member is
 * *reached*, while the alias fails when the member is *added*. So an eighth
 * obligation that arrives without a diagnosis, a remedy and a policy entry is a
 * compile error and not a review finding.
 */
export const causeKinds = [
  'compiler-unsupported',
  'source-unreadable',
  'import-unresolvable',
  'artifact-shape-unsupported',
  'build-record-absent',
  'build-record-stale',
  'library-name-unsupported',
] as const satisfies readonly Cause['kind'][];

/** Compile error naming any member the list above omits. No runtime emission. */
type NoMissingMembers<Missing extends never> = Missing;
type _CauseKindsComplete = NoMissingMembers<
  Exclude<Cause['kind'], (typeof causeKinds)[number]>
>;

/**
 * The exhaustiveness guard for the seven, and the reason `policy.ts` needs no
 * second import.
 *
 * It lives here rather than in `errors.ts` because it is a fact about *this*
 * union, and because an instrument pins `policy.ts` to exactly one module
 * specifier — `./causes`. A guard reachable only from `errors.ts` would make that
 * two.
 */
export function unreachableCause(value: never, consumer: string): never {
  throw new ValidationInputInvariantError(
    `${consumer} reached a branch its types make unreachable, on ` +
      `${describeUnreachable(value)}.`,
  );
}

/**
 * The value is `never` to the compiler and arbitrary at runtime, so nothing may
 * be assumed about its shape — including that it has a discriminant, or that
 * `JSON.stringify` will not throw on it.
 */
function describeUnreachable(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return `the ${typeof value} value ${String(value)}`;
  }
  try {
    return JSON.stringify(value) ?? 'an unserializable object';
  } catch {
    return 'an unserializable object';
  }
}
