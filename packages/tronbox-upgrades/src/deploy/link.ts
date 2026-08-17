/**
 * Deployment-time library linking: refuse a linked implementation by default,
 * and never take the host linker's silence for consent.
 *
 * ## Why silence proves nothing, measured
 *
 * The host's `linker.link` throws for a library with no name or no address —
 * and returns **silently** in every other case, including the one that
 * matters: when the placeholder it was asked to fill does not exist in the
 * unlinked binary, it does nothing, logs nothing, and returns normally. A
 * caller cannot distinguish *linked* from *no such placeholder*. So this
 * module verifies the outcome on the bytecode itself instead of trusting the
 * flow that produced it.
 *
 * The linker is also the one measured host file that **differs between the
 * two supported minors** (4.8.0 tests address presence by truthiness, 4.9.0
 * by `!= null`), which is why the linking path is asserted per minor in the
 * real-host suite rather than once.
 *
 * ## The opt-out arrives as a resolved boolean, deliberately
 *
 * Which option spells the opt-out (`unsafeAllow: ['external-library-linking']`)
 * is the option surface's contract, already composed from the engine's own
 * types there — re-reading option objects here would be a second resolution
 * site for the same fact. This module receives the resolved answer and owns
 * only the deployment-time consequence.
 */

import {
  LinkedImplementationRefusedError,
  LinkVerificationFailedError,
} from './errors';

/**
 * Solidity link placeholders as they appear in hex bytecode: the
 * `__$<34 hex>$__` form and the legacy `__LibraryName____…` form (a 40-column
 * field padded with underscores). Hex proper cannot contain `_` or `$`, so any
 * occurrence is a placeholder — that absence property is what makes
 * {@link assertFullyLinked}'s check total rather than format-dependent.
 *
 * The two forms are extracted in sequence, with matched spans blanked between
 * passes, because each form's delimiters are the other form's false positives:
 * the `$__` that closes a hashed placeholder reads as the opening of a legacy
 * one, and a legacy field's own padding ends in `__` for the same reason.
 */
const HASHED_PLACEHOLDER = /__\$([0-9a-fA-F]{34})\$__/g;
const LEGACY_PLACEHOLDER = /__([A-Za-z0-9.:/-]+)_*/g;

function stripHexPrefix(bytecode: string): string {
  return bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
}

/**
 * The distinct library names whose placeholders appear in `unlinkedBytecode`.
 * Empty means the implementation links nothing and no refusal applies.
 */
export function linkedLibraryNames(unlinkedBytecode: string): readonly string[] {
  const names: string[] = [];
  const record = (name: string): void => {
    if (!names.includes(name)) {
      names.push(name);
    }
  };
  const withoutHashed = stripHexPrefix(unlinkedBytecode).replace(
    HASHED_PLACEHOLDER,
    (span, hash: string) => {
      record(hash);
      return '0'.repeat(span.length);
    },
  );
  for (const match of withoutHashed.matchAll(LEGACY_PLACEHOLDER)) {
    record(match[1] as string);
  }
  return names;
}

/**
 * A linked implementation refuses by default, naming the libraries and
 * the opt-out — and the opt-out's message states the weaker baseline the user
 * is accepting, because that is a commitment of the opt-in, not politeness.
 */
export function refuseUnlessLinkingAllowed(
  libraries: readonly string[],
  allowedByExpertOptOut: boolean,
): void {
  if (libraries.length > 0 && !allowedByExpertOptOut) {
    throw new LinkedImplementationRefusedError(libraries);
  }
}

/**
 * After the host's linking flow, the bytecode about to deploy must
 * carry no unresolved placeholder. Verified on the bytecode, never inferred
 * from the linker returning — link silence is not consent.
 *
 * This closes the joint obligation with {@link refuseUnlessLinkingAllowed}:
 * that function is the *entry* gate — the expert opt-out
 * (`unsafeAllow: ['external-library-linking']`) that lets a linked
 * implementation past refusal in the first place. This is the *exit* proof —
 * wired into `OperationToolkit.hostDeploy` (`src/proxy/toolkit.ts`),
 * immediately before the bytecode is handed to the host's deploy call, so the
 * opt-out can approve an artifact only if what actually deploys is the fully
 * linked form of it, never an unresolved one that slipped through.
 */
export function assertFullyLinked(deployableBytecode: string): void {
  const remaining = linkedLibraryNames(deployableBytecode);
  if (remaining.length > 0) {
    throw new LinkVerificationFailedError(remaining);
  }
  // Belt over the name extraction: any underscore at all in hex is a
  // placeholder fragment, whatever shape the extractor failed to name.
  if (stripHexPrefix(deployableBytecode).includes('_')) {
    throw new LinkVerificationFailedError(['<unrecognized placeholder form>']);
  }
}
