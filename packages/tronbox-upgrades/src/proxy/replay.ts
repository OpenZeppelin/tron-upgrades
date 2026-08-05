/**
 * Replay recognition for the two operations — pure decisions
 * over facts the caller already holds, so every disposition is testable
 * without a chain or a record on disk.
 *
 * ## The recognition key, and why it is the artifact write-back
 *
 * A fresh deploy does not know its address in advance, so "was this proxy
 * already deployed by this migration?" needs a key — and TronBox already
 * keeps one: the deploy action writes the deployed address back onto the
 * contract abstraction, persisted in the artifact's per-network entry. That
 * write-back is the tool's own replay memory (`overwrite: false` reads it),
 * so it is the key a TronBox user's mental model already contains. The record
 * layer then says whether the address is still authoritative for THIS chain
 * identity — which the artifact alone cannot, because a wiped node keeps the
 * artifact and loses the chain.
 */

import { canonicalizeAddress, type CanonicalAddress } from '../record';
import type { ProxyRecordVerdict } from '../record';

/** What `deployProxy` does about a prior deployment, decided before any spend. */
export type DeployReplayDecision =
  /** No prior address for this network: a first deployment. */
  | { readonly kind: 'fresh' }
  /**
   * A prior address whose record is authoritative for this chain identity:
   * reconcile — return the recorded proxy, deploy nothing, append nothing.
   */
  | { readonly kind: 'reuse'; readonly address: CanonicalAddress }
  /**
   * A prior address the record layer cannot vouch for. Refused rather than
   * redeployed: deploying beside a stale record leaves two proxies answering
   * one name, and the record says which investigation comes first.
   */
  | {
      readonly kind: 'refuse';
      readonly address: CanonicalAddress;
      readonly because: 'no-code-at-address' | 'unrecorded' | 'no-verdict';
    };

/**
 * Decides the deploy replay disposition. `priorAddress` is the artifact's
 * per-network address (any encoding, canonicalized here) or `null` on a
 * first run; `verdicts` is the record session's per-entry reconciliation
 * report.
 */
export function decideDeployReplay(
  priorAddress: string | null,
  verdicts: readonly ProxyRecordVerdict[],
): DeployReplayDecision {
  if (priorAddress === null) {
    return { kind: 'fresh' };
  }
  const address = canonicalizeAddress(priorAddress);
  const verdict = verdicts.find(entry => entry.address === address);
  if (verdict === undefined) {
    // The artifact remembers a deployment the record layer never saw — an
    // out-of-band deploy, a deleted manifest, or another tool's write. Not a
    // state to silently re-deploy over, and not one to trust either.
    return { kind: 'refuse', address, because: 'no-verdict' };
  }
  if (verdict.status === 'authoritative') {
    return { kind: 'reuse', address };
  }
  return { kind: 'refuse', address, because: verdict.status };
}

/**
 * The already-current recognition: the upgrade target is already the live
 * implementation. Canonical on both sides — a spelling variant of the same
 * address must be recognized, or every replayed migration re-upgrades and
 * pays for it.
 */
export function isAlreadyCurrent(
  liveImplementation: string,
  targetImplementation: string,
): boolean {
  return (
    canonicalizeAddress(liveImplementation) ===
    canonicalizeAddress(targetImplementation)
  );
}
