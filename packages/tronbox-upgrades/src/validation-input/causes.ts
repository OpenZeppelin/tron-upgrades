import { ValidationInputInvariantError } from './errors';

/**
 * The closed union of the eleven reasons the validation ladder cannot produce a
 * validation input, and nothing else. Pure data: no policy, no rendering, no I/O.
 *
 * **Closed is the property that matters.** It is what makes one
 * `could not validate` covering eleven different situations unrepresentable —
 * the actionable-diagnosis failure the enumeration exists to prevent — and it
 * is what makes *"any obligation the validation ladder owes a diagnosis for
 * has a member"* checkable rather than aspirational. Adding an obligation adds
 * a member; there is no `throw` at a call site for a condition that lacks one.
 *
 * **Every payload field is a scalar or a closed union — the scalars-only
 * rule.** That is not a convention asking politely: there is no field on any
 * member that a Solidity source string, a settings object, a host handle or an
 * upstream `Error` could be assigned to, so the leak is unrepresentable rather
 * than filtered. The source-confinement rule confines source text to
 * `solcInput.sources[key].content` elsewhere, and this type is half of why
 * that holds.
 */
export type Cause =
  /**
   * 1 — the compiler the project resolves to is not in `~/.tronbox`.
   *
   * Detectable before any work: an existence check on the derived path. The path
   * is carried so the remedy names *which* file was looked for, which is the only
   * way a user can tell a missing download from a moved cache.
   */
  | {
      readonly kind: 'compiler-absent';
      readonly requestedVersion: string;
      readonly soljsonPath: string;
      readonly family: 'tvm' | 'evm';
    }
  /**
   * 2 — the compiler is outside `SUPPORTED_SOLC`.
   *
   * A distinct cause from 1 and 3: the compiler may be present, loadable and
   * matching, and still outside the range this plugin has verified. The declared floor, and the
   * gate is on the *version* rather than on the output because measurement
   * showed a sub-0.5.13 compiler accepting a `storageLayout` request with zero
   * diagnostics of any severity and simply omitting the key.
   */
  | {
      readonly kind: 'compiler-unsupported';
      readonly resolvedVersion: string;
      readonly viaLegacyFlag?: 'useZeroFourCompiler' | 'useZeroFiveCompiler';
    }
  /**
   * 3 — the loaded compiler is not the build that produced the artifact.
   *
   * Compared as the **long** version. A measurement showed why a triple cannot
   * work: `~/.tronbox/solc/soljson_v0.8.26.js` reports
   * `0.8.26+commit.733b4d28.Emscripten.clang` and
   * `~/.tronbox/evm-solc/soljson_v0.8.26.js` reports
   * `0.8.26+commit.8a97fa7a.Emscripten.clang` — same filename, different
   * compilers, different bytecode. `family` is carried for the remedy, not for
   * the comparison.
   */
  | {
      readonly kind: 'compiler-mismatched';
      readonly loadedLongVersion: string;
      readonly artifactLongVersion: string;
      readonly family: 'tvm' | 'evm';
    }
  /**
   * 4 — a source in the closure is missing or unreadable.
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
   * 5 — an import cannot be resolved to a source the plugin may supply.
   *
   * Both halves are needed: the specifier alone does not say which file to edit.
   * Decided *before* solc runs, because measurement showed what happens
   * otherwise — `ParserError: Source "Nope.sol" not found: File not supplied
   * initially`, a message about the plugin's own input assembly that a user
   * cannot act on.
   */
  | {
      readonly kind: 'import-unresolvable';
      readonly importedBy: string;
      readonly specifier: string;
    }
  /**
   * 6 — the artifact lacks a field the validation ladder requires.
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
   * 7 — the artifact does not correspond to the sources on disk.
   *
   * **The payload is the contract name and nothing else, corrected from an
   * originally specified `identity: ArtifactIdentityComparison`.**
   * Two reasons that field cannot stay, and the second is the substantive one:
   *
   * - It is an object, so it fails the type-level instrument that checks
   *   *"every `Cause` member's payload fields extend
   *   `string | number | boolean`"*.
   * - **It is constant on this path, so it carries no information a message could
   *   name.** This cause fires *iff* `withoutMetadataMatches` is `false`;
   *   a differing trimmed hash implies a differing full hash, so
   *   `withMetadataMatches` is `false` too; and `metadataOnlyDifference` is
   *   present *iff*
   *   `withoutMetadataMatches && !withMetadataMatches`, so it is absent. The
   *   record is always `{ false, false }` here.
   *
   * The full comparison record still exists and is still reported — on
   * `InputProvenance.identity` for the success path, where it is *not*
   * constant and where the metadata-only row lives.
   */
  | { readonly kind: 'artifact-stale'; readonly contract: string }
  /**
   * 8 — the compiler exhausted its own memory on this closure.
   *
   * Fires by **catching**, not by timing: the TVM wasm reports
   * its ceiling as a `WebAssembly.RuntimeError`, measured verbatim as
   * `RuntimeError: memory access out of bounds`
   * (measured with a live compile probe). Terminal — one contract's closure
   * is the smallest partition there is.
   *
   * **`raised` is a closed union, corrected from the originally specified
   * `raised: string`.** The scalars-only rule's violation scenario names
   * quoting the wasm's `RuntimeError` into this message as the violation, so
   * the field cannot hold the throw's text. A classification keeps the
   * distinction the probe measured —
   * the ceiling has one verbatim string, and any other wasm abort is a different
   * event — while quoting nothing.
   */
  | {
      readonly kind: 'compiler-resource-exhausted';
      readonly target: string;
      readonly closureSize: number;
      readonly raised: WasmAbort;
    }
  /**
   * 9 — the layout for the contract under validation is empty or absent.
   *
   * A cause and not an invariant throw, even though it means the plugin has a
   * bug, because measurement showed the consequence of letting it through:
   * `getStorageUpgradeErrors(EMPTY_original, real_updated)` returns **no
   * errors** and `assertStorageUpgradeSafe(EMPTY, real)` does not throw — an
   * empty reference layout classifies every variable as a safe append. A silent
   * accept is the worst outcome in this sub-feature, so the condition goes
   * through the same enumerated, rendered, tested path as everything else rather
   * than depending on an exception reaching a handler.
   */
  | {
      readonly kind: 'layout-vacuous';
      readonly contract: string;
      readonly declaredStateVariables: number;
    }
  /**
   * 10 — a linked library's name is past the length the host can encode.
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
    }
  /**
   * 11 — the sources on disk do not compile.
   *
   * It is not cause 7: cause 7 fires *iff*
   * `withoutMetadataMatches` is `false`, which is a **comparison result**, and a
   * compile that fails produces no artifact to compare — so overloading cause 7
   * would not merely name the wrong state, it would make that biconditional
   * false as written.
   *
   * **The count, never the text.** solc's error strings are unbounded and
   * routinely carry absolute filesystem paths; rendering them is the
   * option/result surface's territory and the scalars-only and
   * source-confinement rules' prohibition here. A `number` fits the
   * scalars-only rule and a diagnostic array does not, so the type enforces the
   * condition. The host already owns that rendering —
   * `Compile/index.js:111`, `:116`, `:120` and `:141` at `v4.9.0` take
   * `standardOutput.errors`, partition them by `severity` and print each
   * `formattedMessage` — which is
   * why the remedy points the user at it instead of reproducing it.
   */
  | {
      readonly kind: 'sources-do-not-compile';
      readonly target: string;
      readonly errorCount: number;
    };

/** How the wasm aborted. Closed, so nothing quotes the abort's own text. */
export type WasmAbort = 'memory-access-out-of-bounds' | 'other-wasm-abort';

/**
 * The oldest TronBox *verified* to carry all five artifact fields cause 6 can
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
 * these fields were present at 4.0.0, and cause 6's whole job is to name a
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
 * *reached*, while the alias fails when the member is *added*. So a twelfth
 * obligation that arrives without a diagnosis, a remedy and a policy entry is a
 * compile error and not a review finding.
 */
export const causeKinds = [
  'compiler-absent',
  'compiler-unsupported',
  'compiler-mismatched',
  'source-unreadable',
  'import-unresolvable',
  'artifact-shape-unsupported',
  'artifact-stale',
  'compiler-resource-exhausted',
  'layout-vacuous',
  'library-name-unsupported',
  'sources-do-not-compile',
] as const satisfies readonly Cause['kind'][];

/** Compile error naming any member the list above omits. No runtime emission. */
type NoMissingMembers<Missing extends never> = Missing;
type _CauseKindsComplete = NoMissingMembers<
  Exclude<Cause['kind'], (typeof causeKinds)[number]>
>;

/**
 * The exhaustiveness guard for the eleven, and the reason `policy.ts` needs no
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
