/**
 * The deployment seam's own types. No imports (INV-19's module rule): every type
 * here is structural, so the seam's contracts are readable without following an
 * import chain, and nothing below it can create a cycle.
 *
 * The one deliberate repetition: `transactionHash` fields are `string` here even
 * though `record/address.ts` brands addresses, because a transaction hash has no
 * canonical-form problem — TRON renders it one way — and importing a brand would
 * break the no-imports rule for zero safety.
 */

/**
 * What the confirmation gate returns, and the only thing it can return (INV-7):
 * three disjoint outcomes, none representable as another. `success: boolean` is
 * deliberately not expressible — a boolean collapses *reverted* and
 * *indeterminate*, whose remedies point opposite directions.
 */
export type ConfirmationVerdict =
  | ConfirmedSuccessful
  | ConfirmedReverted
  | ConfirmationIndeterminate;

/**
 * The transaction is on-chain and its own receipt affirms success.
 *
 * Measured against real mainnet transactions (block 85064760, three
 * transaction types): the affirmation lives at `info.receipt.result ===
 * 'SUCCESS'`. The top-level `info.result` key exists **only on failure**
 * (`'FAILED'`), and a plain TRX transfer carries no `receipt.result` at all —
 * so a gate keyed on `info.result !== 'FAILED'` passes everything, which is the
 * vacuous predicate INV-8 exists to ban.
 */
export interface ConfirmedSuccessful {
  readonly kind: 'confirmed-successful';
  readonly transactionHash: string;
  /** The raw info object the wait handle resolved with, frozen, for provenance. */
  readonly receipt: Readonly<Record<string, unknown>>;
}

/**
 * The transaction is on-chain and executed with a failure. `vmResult` is the
 * receipt's own verdict string (`'REVERT'`, `'OUT_OF_ENERGY'`, …) and
 * `vmMessage` is the decoded `resMessage` when the node supplied one — the
 * TVM's error preserved verbatim per acceptance scenario 3, because the node's
 * words are the only diagnostic the user gets.
 */
export interface ConfirmedReverted {
  readonly kind: 'reverted';
  readonly transactionHash: string;
  readonly vmResult: string;
  readonly vmMessage: string | null;
  readonly receipt: Readonly<Record<string, unknown>>;
}

/**
 * The gate could not decide — and says why, because the two ways of not
 * deciding have different remedies. `wait-exhausted`: the polling bound ran out
 * (the transaction may still land; check the hash). `receipt-field-absent`: a
 * receipt arrived without the one field that affirms success, so treating it as
 * success would be the exact vacuity INV-8 bans; treating it as reverted would
 * invent a failure the chain never reported.
 */
export interface ConfirmationIndeterminate {
  readonly kind: 'indeterminate';
  readonly transactionHash: string;
  readonly because: 'wait-exhausted' | 'receipt-field-absent';
  /** The bound that was exhausted, so the refusal can state what was tried. */
  readonly waitedMs: number | null;
}

/** The polling bound, stated rather than assumed (host default: 500 ms × 240). */
export interface ConfirmationBounds {
  readonly intervalMs: number;
  readonly maxRetries: number;
}

/**
 * The resolved effective sender (INV-12). Resolved exactly once per operation,
 * before any authority preflight, and threaded by value to both the preflight
 * and the send — never re-derived between them. `unconfigured` is a state, not
 * an error: the host will fall back to its own default account, and whether
 * that is acceptable is the operation's call, made against a named state
 * instead of a `null` it would have to interpret.
 */
export type EffectiveSender =
  | { readonly kind: 'resolved'; readonly address: string }
  | { readonly kind: 'unconfigured' };

/**
 * The host deployer as the seam exposes it: the queue-registration face and
 * nothing else. `queue.ts` is the only module that touches it (INV-19).
 */
export interface QueueHost {
  then(step: (...args: unknown[]) => unknown): unknown;
}

/**
 * What a queued step produced, read from the abstraction write-back — never
 * from the awaited chain value, which pre-start does not exist per step (the
 * chain settles once, with the last step's value) and post-start belongs to the
 * host (INV-4).
 */
export interface WriteBack {
  readonly address: string;
  readonly transactionHash: string;
}
