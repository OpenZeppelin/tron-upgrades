/**
 * The two-predicate confirmation gate: *confirmed* means the
 * transaction is on-chain, and *succeeded* means its own receipt affirms it —
 * two different predicates, and the wait handle answers only the first, because
 * it resolves with the receipt without inspecting it.
 *
 * ## The field, measured — not read from a type declaration
 *
 * Against real mainnet transactions (block 85064760; the capture is persisted
 * with the plugin's development evidence):
 *
 * - successful contract execution: `info.receipt.result === 'SUCCESS'`, and the
 *   top-level `info.result` key is **absent**;
 * - reverted execution: `info.receipt.result === 'REVERT'`, top-level
 *   `info.result === 'FAILED'`, `info.resMessage` hex-encodes
 *   `"REVERT opcode executed"`;
 * - plain TRX transfer: **no `receipt.result` at all** — the receipt is
 *   `{ net_fee }` alone.
 *
 * So the two obvious predicates are both measured wrong: `info.result !==
 * 'FAILED'` passes transfers and successes alike (the key is absent on both),
 * and a truthiness read of `receipt.result` passes `'REVERT'`. The gate reads
 * `receipt.result === 'SUCCESS'` exactly, and classifies **absence as
 * indeterminate** — never success (the vacuity ban: a field that is
 * `undefined` on every receipt must not make every transaction "successful"),
 * and never reverted (that would invent a failure the chain never reported).
 *
 * No path here re-sends anything: polling retries *reads*, exhaustion
 * is terminal, and the verdict carries the hash so the user can check what the
 * plugin could not.
 */

import type {
  ConfirmationBounds,
  ConfirmationVerdict,
} from './types';

/** The host's own defaults: positional `(txHash, interval = 500, maxRetries = 240)`. */
export const HOST_CONFIRMATION_BOUNDS: ConfirmationBounds = Object.freeze({
  intervalMs: 500,
  maxRetries: 240,
});

/**
 * The wait dependency as this gate consumes it: the seam's
 * `receipts.waitForTransactionReceipt`, already bound to its chain handle.
 * Injected rather than imported, so the gate is testable against fixture
 * receipts with no host present (and so this module touches no host).
 */
export type BoundWait = (
  transactionHash: string,
  intervalMs: number,
  maxRetries: number,
) => Promise<unknown>;

function decodeHexMessage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  if (!/^[0-9a-fA-F]+$/.test(value)) {
    // Some nodes hand the message back already decoded; pass it through.
    return value;
  }
  try {
    return Buffer.from(value, 'hex').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Awaits the receipt and classifies it into exactly one of the three verdicts.
 * Never throws for an on-chain failure — a revert is a *verdict*, and turning
 * it into a refusal (with the TVM's error preserved) is the caller's move, so
 * that the classification stays testable as data.
 */
export async function confirmTransaction(
  transactionHash: string,
  wait: BoundWait,
  bounds: ConfirmationBounds = HOST_CONFIRMATION_BOUNDS,
): Promise<ConfirmationVerdict> {
  let info: unknown;
  try {
    info = await wait(transactionHash, bounds.intervalMs, bounds.maxRetries);
  } catch {
    // The handle rejects on exhaustion ("Transaction receipt not found").
    // Terminal for this operation: the transaction may still land, so the
    // verdict carries the bound and the hash, and nothing is re-sent.
    return {
      kind: 'indeterminate',
      transactionHash,
      because: 'wait-exhausted',
      waitedMs: bounds.intervalMs * bounds.maxRetries,
    };
  }

  const record =
    typeof info === 'object' && info !== null
      ? (info as Record<string, unknown>)
      : {};
  const receipt =
    typeof record['receipt'] === 'object' && record['receipt'] !== null
      ? (record['receipt'] as Record<string, unknown>)
      : {};
  const vmResult = receipt['result'];

  if (vmResult === 'SUCCESS') {
    return {
      kind: 'confirmed-successful',
      transactionHash,
      receipt: Object.freeze({ ...record }),
    };
  }

  if (typeof vmResult === 'string' && vmResult.length > 0) {
    // Any named verdict other than SUCCESS is an execution failure: REVERT,
    // OUT_OF_ENERGY, OUT_OF_TIME, … — a closed treatment, so an unfamiliar
    // failure name is still a failure rather than falling through to success.
    return {
      kind: 'reverted',
      transactionHash,
      vmResult,
      vmMessage: decodeHexMessage(record['resMessage']),
      receipt: Object.freeze({ ...record }),
    };
  }

  // A receipt with no execution verdict. For the contract transactions this
  // seam sends, that shape is unexpected — and unexpected must not classify as
  // success (the vacuity ban) nor as a failure the chain never reported.
  return {
    kind: 'indeterminate',
    transactionHash,
    because: 'receipt-field-absent',
    waitedMs: null,
  };
}
