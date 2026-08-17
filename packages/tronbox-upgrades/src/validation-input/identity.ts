import {
  extractLinkReferences,
  unlinkBytecode,
  type SolcBytecode,
} from '@openzeppelin/upgrades-core';

import type { Cause } from './causes';

/**
 * Contract identity at the record boundary: the library-name band, and the
 * record-vs-artifact freshness comparison the whole Foundry model gates on.
 *
 * This module used to also hold the recompiled-vs-artifact identity (two link
 * forms, two hashes, `getVersion`) — that comparison left with the embedded
 * compiler, because there is no recompile to compare against. What remains is
 * everything the record path needs, and each value here is one a wrong answer
 * would make *silently* wrong, so each has an assertion or a stated reason
 * rather than a comment alone.
 */

/**
 * The longest library name TronBox can encode, and the field it encodes into.
 *
 * Measured end to end: clone `src/components/Compile/index.js:227-242` at
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
 * nor the cause, which is why the `library-name-unsupported` cause exists.
 *
 * An explicit exception permits these measured numeric literals in this file
 * and nowhere else. Only two of the four it names are reachable as *code* —
 * `36` and `39`; the 40-character field and the 37–38 band appear in this
 * comment because they are the measurement, not a branch.
 */
export const MAX_LIBRARY_NAME_LENGTH = 36;
const CORRUPTING_NAME_LENGTH = 39;

/**
 * The library-name cause, decided from a compile's own link references.
 *
 * The bands are checked against the library *name*, which is the inner key of
 * `evm.bytecode.linkReferences[file]` and is exactly what the host passes to
 * `replaceLinkReferences` as `library_name` (clone
 * `src/components/Compile/index.js:188-195` at `v4.9.0`). The pipeline reads
 * the references off the **verified build record's** creation bytecode — the
 * same object whose deployed bytecode content-verified — because a name past
 * the band corrupts the *artifact's* bytecode, and that is a property of the
 * project, not of which path validated it.
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
 * needs no additional read on its own account: `evm.deployedBytecode.object`
 * and its `.linkReferences` are both in the host's own `outputSelection`, in
 * the `*.output.json` file the build-info reader already reads. The paired
 * compiler-*input* file `<hash>.json` **is** read now — the reader surfaces it
 * because the Foundry-model fresh path hands its content to consumers as the
 * validation's `solcInput` — but this comparison never consults it: freshness
 * is decided from the output side alone.
 *
 * **Why not simply `===`.** TronBox rewrites the artifact's placeholders for every
 * linked library, so a linked contract's artifact bytes differ from solc's raw
 * object even when the two describe the same compile. The normalisation is
 * upstream's own — take the link offsets from the reference side, rewrite the
 * *artifact* side into the compiler's canonical placeholder. The reference
 * side here is the build record.
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
 * form. Sound in the safe direction either way — a mismatch rejects the
 * record, and under the Foundry model a project whose every record is rejected
 * is refused with `tronbox compile --all` as the remedy, never validated
 * against the wrong compile.
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
