/**
 * The deploy-replay refusal — a pure decision over facts the caller already
 * holds, so it is testable without a chain or a record on disk.
 *
 * `deployProxy` always deploys a fresh proxy — Hardhat parity: the removed
 * Truffle plugin and Hardhat's own `deployProxy` both deploy unconditionally,
 * so a prior recorded address is never reused here either. The only question
 * left is whether it is safe to leave that prior address alone while a new
 * one gets deployed and recorded beside it.
 *
 * ## The key, and why it is the artifact write-back
 *
 * TronBox already keeps a key for "did this migration deploy here before?":
 * the deploy action writes the deployed address back onto the contract
 * abstraction, persisted in the artifact's per-network entry. That
 * write-back is the tool's own memory (`overwrite: false` reads it), so it
 * is the key a TronBox user's mental model already contains — this module
 * reads the SAME key, but only to ask whether the record can vouch for it.
 * The record layer says whether the address is still authoritative for THIS
 * chain identity — which the artifact alone cannot, because a wiped node
 * keeps the artifact and loses the chain. An address the record cannot vouch
 * for refuses, rather than letting a new, correctly-recorded deploy get
 * layered beside one the tooling can no longer account for.
 */

import { canonicalizeAddress, type CanonicalAddress } from '../record';
import type { ProxyRecordVerdict } from '../record';

/**
 * Whether a prior recorded address refuses this deploy, decided before any
 * spend. `deployProxy` never reuses a prior proxy, so the only dispositions
 * left are proceeding (no prior address, or the record vouches for the one
 * there is) and refusing (the record cannot).
 */
export type DeployReplayDecision =
  /** No prior address, or the prior address is authoritative: deploy fresh. */
  | { readonly kind: 'proceed' }
  /**
   * A prior address the record layer cannot vouch for. Refused rather than
   * built beside silently: the record says which investigation comes first.
   */
  | {
      readonly kind: 'refuse';
      readonly address: CanonicalAddress;
      readonly because: 'no-code-at-address' | 'unrecorded' | 'no-verdict';
    };

/**
 * Decides the deploy replay disposition. `priorAddress` is the artifact's
 * per-network address (any encoding, canonicalized here) or `null` when
 * none is recorded; `verdicts` is the record session's per-entry
 * reconciliation report.
 */
export function decideDeployReplay(
  priorAddress: string | null,
  verdicts: readonly ProxyRecordVerdict[],
): DeployReplayDecision {
  if (priorAddress === null) {
    return { kind: 'proceed' };
  }
  const address = canonicalizeAddress(priorAddress);
  const verdict = verdicts.find(entry => entry.address === address);
  if (verdict === undefined) {
    // The artifact remembers a deployment the record layer never saw — an
    // out-of-band deploy, a deleted manifest, or another tool's write. Not a
    // state to build a new deploy beside silently, and not one to trust
    // either.
    return { kind: 'refuse', address, because: 'no-verdict' };
  }
  if (verdict.status === 'authoritative') {
    return { kind: 'proceed' };
  }
  return { kind: 'refuse', address, because: verdict.status };
}

/**
 * Canonical implementation identity comparison. Post-dispatch verification
 * must accept spelling variants of the same address.
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
