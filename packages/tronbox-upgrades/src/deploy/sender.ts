/**
 * The single effective-sender algorithm (INV-12, INV-13): one resolution site,
 * called once per operation before any authority preflight, its value threaded
 * to both the preflight and the send — and then *verified* after the fact,
 * because the host chooses the signer at send time and threading alone is a
 * promise, not a check.
 *
 * Identity is an **address, everywhere** (INV-14). This module reads the seam's
 * non-authoritative configured sender — an address or `null` — and never
 * touches, stores, or renders key material. The reachable-key hazard is real
 * and measured (a configured `privateKey` sits at depth 4 from the deployer
 * handle), which is why the input type here is the seam's projected slot and
 * never the handle itself.
 */

import type { EffectiveSender } from './types';
import { SenderMismatchError } from './errors';
// Through the record layer's face, never a deep import — the face is the one
// route its boundary scan permits consumers, and this module is the package's
// first consumer of it.
import { canonicalizeAddress, type CanonicalAddress } from '../record';

/**
 * The seam's sender projection, as `environment/types.ts` declares it:
 * configured, not authoritative, `null` when the network entry names no `from`.
 */
export interface ConfiguredSenderSlot {
  readonly address: string | null;
}

/**
 * Resolves the effective sender exactly once. `unconfigured` is a named state,
 * not an error: the host will use its own default account, and whether an
 * operation accepts that is its decision to make against a name rather than a
 * `null` it would have to interpret. A configured address that does not
 * canonicalize refuses here — through the mint's own five named causes — rather
 * than flowing onward as a string nothing downstream can compare.
 */
export function resolveEffectiveSender(
  configured: ConfiguredSenderSlot,
): EffectiveSender {
  if (configured.address === null) {
    return { kind: 'unconfigured' };
  }
  return {
    kind: 'resolved',
    address: canonicalizeAddress(configured.address),
  };
}

/**
 * The after-the-fact comparison (INV-13). `signedBy` is whatever identity the
 * transaction reports having signed it, in any of the three encodings — it is
 * canonicalized here, so the comparison is on identity and never on spelling.
 * A mismatch refuses naming both, because the pair is the evidence.
 *
 * When the resolution was `unconfigured` there is nothing to compare against:
 * the host's default account signed, that is the configured behaviour, and the
 * signer is returned canonicalized for the result surface.
 */
export function assertSignerMatches(
  resolved: EffectiveSender,
  signedBy: string,
): CanonicalAddress {
  const signer = canonicalizeAddress(signedBy);
  if (resolved.kind === 'resolved') {
    const expected = canonicalizeAddress(resolved.address);
    if (signer !== expected) {
      throw new SenderMismatchError(expected, signer);
    }
  }
  return signer;
}
