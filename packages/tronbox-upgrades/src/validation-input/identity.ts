import {
  extractLinkReferences,
  getVersion,
  unlinkBytecode,
  type SolcBytecode,
} from '@openzeppelin/upgrades-core';

import type { Cause } from './causes';
import { ValidationInputInvariantError } from './errors';

/**
 * Contract identity: the two link forms, the two hashes, and the staleness
 * comparison.
 *
 * Every value here is one a wrong answer would make *silently* wrong, so each has
 * an assertion rather than a comment.
 */

/**
 * The longest library name TronBox can encode, and the field it encodes into.
 *
 * F-9, measured end to end: clone `src/components/Compile/index.js:227-242` at
 * `v4.9.0` builds `'__' + libraryName`, pads with `_` **while shorter than 40**,
 * and splices the result over a 40-character window — it never truncates. Combined
 * with upgrades-core's normalisation `/__\w{36}__/g` (`dist/version.js:26`), which
 * needs at least two trailing underscores inside that field:
 *
 * | name length | placeholder | matches | artifact bytecode | `hashBytecode` |
 * |---|---|---|---|---|
 * | ≤ 36 | 40 chars | yes | intact | correct |
 * | 37–38 | 40 chars | **no** | intact | **throws** |
 * | ≥ 39 | 41+ chars | no | **corrupted** | throws |
 *
 * Reproduced through the host with a 45-character name: the persisted artifact's
 * `bytecode` had an **odd** hex digit count, and `hashBytecode` threw
 * `Bytecode is not a valid hex string` — a message that names neither the library
 * nor the cause, which is why cause 10 exists (INV-14, INV-42).
 *
 * INV-35 allows F-9's numeric literals in this file and nowhere else. Only two
 * of the four it names are reachable as *code* — `36` and `39`; the 40-character
 * field and the 37–38 band appear in this comment because they are the
 * measurement, not a branch.
 */
export const MAX_LIBRARY_NAME_LENGTH = 36;
const CORRUPTING_NAME_LENGTH = 39;

/**
 * `withoutMetadata` is the gate; `withMetadata` is diagnosis only.
 *
 * Both booleans are required, so **both comparisons must be performed** to
 * construct the record — the absence of `metadataOnlyDifference` therefore means
 * the two agreed, never that nobody looked (INV-31).
 */
export interface ArtifactIdentityComparison {
  readonly withoutMetadataMatches: boolean;
  readonly withMetadataMatches: boolean;
  /** Present iff the two disagree: the code is identical, the metadata is not. */
  readonly metadataOnlyDifference?: true;
}

/**
 * The **one** `getVersion` call site, behind a wrapper whose signature requires
 * both bytecodes (C4, INV-33).
 *
 * Upstream is `getVersion(bytecode, linkedBytecode?, constructorArgs = '')` and its
 * body is `linkedWithoutMetadata: hashBytecodeWithoutMetadata(linkedBytecode ??
 * bytecode, constructorArgs)` — measured at
 * `@openzeppelin/upgrades-core@1.46.0`, `dist/version.js:11-20`, in `dist/` and
 * **not** `dist/validate/version.js`, which does not exist. So a one-argument call
 * makes `linkedWithoutMetadata` identical to `withoutMetadata`: the two identities
 * scenario 6 requires to be distinct collapse into one, silently, with no error.
 * *That bug passes every test that does not specifically look for it*, which is
 * why the arity is enforced by a wrapper rather than by review.
 *
 * INV-42: exactly one upstream error is relayed unwrapped —
 * `Abstract contract not allowed here`, which upgrades-core throws on empty
 * bytecode and which is its own clear message for a real user error (validating an
 * abstract contract). Everything else is wrapped, because the only *measured* way
 * TronBox produces bytecode upstream cannot hash is F-9's library overrun, and that
 * is already cause 10 — so a hex failure that reaches here is unexplained and
 * should say so loudly rather than be reported as somebody's project problem.
 */
const ABSTRACT_CONTRACT_MESSAGE = 'Abstract contract not allowed here';

function bytecodeIdentity(
  placeholderForm: string,
  linkedForm: string,
): { readonly withMetadata: string; readonly withoutMetadata: string } {
  try {
    return getVersion(placeholderForm, linkedForm);
  } catch (thrown) {
    if (thrown instanceof Error && thrown.message === ABSTRACT_CONTRACT_MESSAGE) {
      throw thrown;
    }
    throw new ValidationInputInvariantError(
      `upgrades-core could not compute a contract identity from the bytecode ` +
        `this validation assembled: ` +
        `${thrown instanceof Error ? thrown.name : typeof thrown}.`,
    );
  }
}

/**
 * Cause 10, decided **before** any identity work, from the recompile's own link
 * references.
 *
 * The bands are checked against the library *name*, which is the inner key of
 * `evm.bytecode.linkReferences[file]` and is exactly what the host passes to
 * `replaceLinkReferences` as `library_name` (clone
 * `src/components/Compile/index.js:188-195` at `v4.9.0`).
 */
export function libraryNameBand(
  bytecode: SolcBytecode,
): Cause | undefined {
  for (const file of Object.keys(bytecode.linkReferences)) {
    for (const libraryName of Object.keys(bytecode.linkReferences[file] ?? {})) {
      const { length } = libraryName;
      if (length <= MAX_LIBRARY_NAME_LENGTH) {
        continue;
      }
      return {
        kind: 'library-name-unsupported',
        libraryName,
        length,
        band: length >= CORRUPTING_NAME_LENGTH ? '>=39' : '37-38',
      };
    }
  }
  return undefined;
}

export interface IdentityRequest {
  /** `evm.bytecode` from **SF-2's own recompile** — never from the artifact. */
  readonly recompiled: SolcBytecode;
  /** `ArtifactRecord.bytecode`, in TronBox's legacy-placeholder form. */
  readonly artifactBytecode: string;
}

export interface IdentityResult {
  readonly comparison: ArtifactIdentityComparison;
  /**
   * The artifact's two-form identity. `withoutMetadata` is the validation
   * identity (from the placeholder form); `linkedWithoutMetadata` binds deployment
   * and version identity (from the linked form). No path substitutes one for the
   * other (INV-33).
   */
  readonly artifactVersion: {
    readonly withMetadata: string;
    readonly withoutMetadata: string;
  };
}

/**
 * Normalises the artifact into the compiler's own placeholder form and compares.
 *
 * **`getUnlinkedBytecode` is not used, and that is a correction to Design with a
 * measurement behind it.** Its signature at
 * `@openzeppelin/upgrades-core@1.46.0` is
 * `getUnlinkedBytecode(data: ValidationData, bytecode: string)`
 * (`dist/validate/query.d.ts:28`) — its first parameter is the accumulated
 * *validation log*, which SF-2 does not have and could only obtain by running
 * `validate()` itself, i.e. by doing the consumer's work twice. What it does
 * internally is exactly the two steps below, plus a version check against the log:
 * the check INV-34 forbids relying on, because its two measured mismatch
 * behaviours are a throw from three frames deep and a silent fall-through
 * returning the input unchanged (`dist/validate/query.js:130` is
 * `return bytecode;`), neither of which is a staleness report.
 *
 * So the transform is taken directly from the two public primitives —
 * `extractLinkReferences` and `unlinkBytecode`, both on the package's face via
 * `dist/index.d.ts`'s `export * from './link-refs'`, declared at
 * `dist/link-refs.d.ts:9-10` — driven by **SF-2's own recompile's**
 * `linkReferences`. That is INV-34's statement satisfied more directly than
 * through the wrapper: link-ness comes from our own compile, and upstream is used
 * as a transform and never as a check.
 *
 * **The gate is `withoutMetadata`** (INV-32). It is what the manifest keys on, via
 * `linkedWithoutMetadata`, so the gate and the record agree by construction; and it
 * is the only comparison immune to the one property this design depends on and did
 * not measure — whether solc's metadata `sources` map lists the sources *supplied
 * to the invocation* or the ones the contract *uses*. If it is the former, a
 * partitioned compile's metadata differs from the host's whole-project compile by
 * construction, and a `withMetadata` gate would report every correctly built
 * project stale with a remedy that cannot help. Gating on the trimmed hash is
 * correct either way, and the metadata-only row is where the answer becomes
 * observable instead of silent.
 */
export function compareArtifactIdentity(
  request: IdentityRequest,
): IdentityResult {
  const linkReferences = extractLinkReferences(request.recompiled);
  const unlinkedArtifact = unlinkBytecode(
    request.artifactBytecode,
    linkReferences,
  );

  /**
   * INV-34: a normalisation that did not happen is a broken invariant, not a
   * pass. `evidence/probe-recompile-fidelity.js` §4 measured the shape this
   * asserts — solc-native `__$8a08b1729c508fc3c9a7a1592748312f2d$__` in the
   * recompile against TronBox's legacy
   * `__MathLib_______________________________` in the artifact, with the returned
   * value carrying the solc-native form.
   */
  for (const reference of linkReferences) {
    if (!unlinkedArtifact.includes(reference.placeholder)) {
      throw new ValidationInputInvariantError(
        `normalising the artifact's library placeholders did not take: the ` +
          `compiler's own placeholder for "${reference.name}" is absent from ` +
          `the ${unlinkedArtifact.length}-character result, so the identity ` +
          `computed from it would key a different implementation.`,
      );
    }
  }

  const artifactVersion = bytecodeIdentity(
    unlinkedArtifact,
    request.artifactBytecode,
  );
  /**
   * The recompile has no separate linked form — solc's own output *is* the
   * placeholder form — so both arguments are the same string, and this value's
   * `linkedWithoutMetadata` is deliberately never read. Reading it would be
   * exactly C4's collapse.
   */
  const recompiledVersion = bytecodeIdentity(
    request.recompiled.object,
    request.recompiled.object,
  );

  const withoutMetadataMatches =
    artifactVersion.withoutMetadata === recompiledVersion.withoutMetadata;
  const withMetadataMatches =
    artifactVersion.withMetadata === recompiledVersion.withMetadata;

  return {
    comparison: Object.freeze({
      withoutMetadataMatches,
      withMetadataMatches,
      // Present *iff* the two disagree. `?: true` makes a falsy value
      // unrepresentable, so the field is a pure signal (INV-31).
      ...(withoutMetadataMatches && !withMetadataMatches
        ? { metadataOnlyDifference: true as const }
        : {}),
    }),
    artifactVersion,
  };
}

/**
 * The comparison for a successful compile whose output does not contain the
 * target contract at all.
 *
 * **Reachable, and it belongs to cause 7 rather than to a twelfth member.** The
 * case is a contract renamed in its source after `tronbox compile`: the sources
 * resolve and compile cleanly, so this is not cause 11, and the artifact is
 * well-shaped, so it is not cause 6 — but the recompile produces no code for that
 * name. Unlike a *failed* compile, which produces no output to compare and
 * therefore cannot honestly reach INV-32's gate at all, here the compile succeeded
 * and its complete output demonstrably lacks the contract. "No bytecode" does not
 * equal the artifact's bytecode, so `withoutMetadataMatches` is a truthful
 * `false`, INV-32's biconditional holds, and `tronbox compile` is exactly the
 * remedy.
 */
export function absentFromRecompile(): ArtifactIdentityComparison {
  return Object.freeze({
    withoutMetadataMatches: false,
    withMetadataMatches: false,
  });
}

export interface BuildRecordFreshnessRequest {
  /**
   * `evm.deployedBytecode` out of the host's own build record.
   *
   * `.object` is **unprefixed** — it is raw solc standard-JSON output — and it
   * must stay that way for this call: `dist/link-refs.js:extractLinkReferences`
   * indexes `bytecode.object.substr(start * 2, …)` with no prefix strip, so
   * handing it a `0x`-prefixed string reads every placeholder two characters off.
   */
  readonly buildRecordDeployed: SolcBytecode;
  /**
   * `ArtifactRecord.deployedBytecode`, which TronBox writes as
   * `'0x' + contract.evm.deployedBytecode.object` and then rewrites per linked
   * library into its own legacy placeholder form — `'__' + libraryName` padded
   * with underscores to 40 characters, where solc writes `__$<34-hex>$__`.
   */
  readonly artifactDeployedBytecode: string;
}

export type BuildRecordFreshness =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'deployed-bytecode-differs' | 'nothing-to-compare';
    };

/**
 * Whether a build record describes the very compile that produced this artifact,
 * decided by **content** and by the compiled result rather than by the source
 * text.
 *
 * **Why the compiled result.** Solc's deployed bytecode ends in a CBOR metadata
 * section whose hash covers the sources *and the settings*, so a source-text
 * comparison could match while settings differed and this one cannot. It also
 * needs no additional read: `evm.deployedBytecode.object` and its
 * `.linkReferences` are both in the host's own `outputSelection`, in the
 * `*.output.json` file the build-info reader already reads — so the paired
 * compiler-*input* file stays unread and the reader's one-listing-plus-one-parse
 * budget is untouched. The source-text formulation would have amended it.
 *
 * **Why not simply `===`.** TronBox rewrites the artifact's placeholders for every
 * linked library, so a linked contract's artifact bytes differ from solc's raw
 * object even when the two describe the same compile. The normalisation is
 * upstream's own and is used here exactly as {@link compareArtifactIdentity} uses
 * it — take the link offsets from the reference side, rewrite the *artifact* side
 * into the compiler's canonical placeholder. The only change is that the
 * reference side is the build record instead of a fresh recompile.
 *
 * **The `0x` is added explicitly on the solc side.** `unlinkBytecode` is
 * prefix-tolerant and returns a `0x`-prefixed string (`dist/link-refs.js`);
 * `.object` is unprefixed. The asymmetry is real, there is no off-by-two, and
 * both sides are lower-cased because a placeholder is substituted verbatim, so
 * case can only diverge upstream of this comparison.
 *
 * **Equality means the same compiled output.** It means the same sources *and*
 * settings only while the CBOR tail is present; a project setting
 * `metadata.bytecodeHash: "none"` strips it and the claim weakens to the first
 * form. Sound in the safe direction either way — a mismatch sends the caller
 * down the compile path, never past a check.
 *
 * **The empty-versus-empty case is refused rather than passed**, and it is the
 * one vacuity trap this comparison has: an abstract contract or an interface has
 * `deployedBytecode` of `'0x'` against a record `.object` of `''`, which compare
 * equal and would report "verified" having compared nothing. There is no evidence
 * in that pair, so it is `'nothing-to-compare'`.
 */
export function verifyBuildRecordFreshness(
  request: BuildRecordFreshnessRequest,
): BuildRecordFreshness {
  const reference = request.buildRecordDeployed.object;
  const artifact = request.artifactDeployedBytecode;
  if (reference === '' || artifact === '' || artifact === '0x') {
    return { ok: false, reason: 'nothing-to-compare' };
  }

  const linkReferences = extractLinkReferences(request.buildRecordDeployed);
  const unlinkedArtifact = unlinkBytecode(artifact, linkReferences);

  return unlinkedArtifact.toLowerCase() === `0x${reference}`.toLowerCase()
    ? { ok: true }
    : { ok: false, reason: 'deployed-bytecode-differs' };
}
