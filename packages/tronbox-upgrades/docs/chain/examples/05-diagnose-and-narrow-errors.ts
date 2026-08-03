/**
 * Narrowing the error family, and asking a node what it can actually serve.
 *
 * Two rules for consumers:
 *
 *  1. **Narrow on the class, or on `code` — never on the message.** Every class
 *     carries a `readonly code` in the closed `TRON_CHAIN_*` namespace, and every
 *     fact in a message is also reachable as a field.
 *  2. **The diagnosis kind is a field, deliberately absent from the message.**
 *     `ChainRpcError.diagnosis` tells you what the node error *means*;
 *     `ChainRpcError.message` carries the node's verbatim text and SF-1's framing
 *     around it, and never the kind (`src/chain/errors.ts:204-222`). The reason is
 *     measurable: upstream's `callOptionalSignature` matches four case-sensitive
 *     substrings, `'REVERT opcode executed'.includes('revert')` is `false` — but the
 *     string `'reverted'` *does* contain `revert`, so interpolating the kind into the
 *     message would silently perform the translation the design forbids.
 */
import {
  ChainAddressUnusableError,
  ChainBeaconNotFoundError,
  ChainBlockTagRefusedError,
  ChainEndpointRefusedError,
  ChainImplementationNotFoundError,
  ChainInstanceChangedError,
  ChainMethodRefusedError,
  ChainResultShapeError,
  ChainRpcError,
  ChainSlotMalformedError,
  ChainTransportError,
  blockTagVerdict,
  classifyNodeError,
  isProbeOutcome,
  policyFor,
  refusedMethods,
  requiredMethods,
  verifyCapabilities,
  type ChainAccess,
  type CapabilityReport,
  type JsonRpcErrorPayload,
  type TvmDiagnosis,
} from '../../../src/chain';

// ---------------------------------------------------------------------------
// 1. The closed code namespace — eleven, and behaviour is what to rely on
// ---------------------------------------------------------------------------

/**
 * Eleven classes, closed and enumerable from the error module. Two of them —
 * `ChainSlotMalformedError` and `ChainAddressUnusableError` — are declared in
 * `src/chain/slots.ts` and re-exported, because that module must import nothing and
 * an `Error` subclass needs no import. **Rely on the behaviour, not the file
 * layout**: class identity is the same object on both import routes, so `instanceof`
 * does not depend on which one you used, and this arrangement is a recorded
 * unratified default whose reversal is a file move.
 */
export const chainErrorCodes = [
  'TRON_CHAIN_ADDRESS_UNUSABLE',
  'TRON_CHAIN_BEACON_NOT_FOUND',
  'TRON_CHAIN_BLOCK_TAG_REFUSED',
  'TRON_CHAIN_ENDPOINT_REFUSED',
  'TRON_CHAIN_IMPLEMENTATION_NOT_FOUND',
  'TRON_CHAIN_INSTANCE_CHANGED',
  'TRON_CHAIN_METHOD_REFUSED',
  'TRON_CHAIN_RESULT_SHAPE',
  'TRON_CHAIN_RPC_ERROR',
  'TRON_CHAIN_SLOT_MALFORMED',
  'TRON_CHAIN_TRANSPORT',
] as const;

/**
 * Structural narrowing over the whole family. Note that a **twelfth** category
 * exists and is *not* in this namespace: a `chain` slot that cannot supply
 * chain-state access is reported through the seam's own
 * `EnvironmentIncompleteError` (`TRONBOX_ENV_INCOMPLETE`), reusing that family
 * rather than starting a second error path.
 */
export function classifyChainError(cause: unknown): string {
  if (cause instanceof ChainRpcError) {
    // The kind lives here, not in the message.
    return `${cause.code} ${cause.diagnosis.kind} (JSON-RPC ${String(cause.rpcCode)}) on ${cause.method}`;
  }
  if (cause instanceof ChainTransportError) {
    return `${cause.code} ${cause.cause.kind} on ${cause.method}`;
  }
  if (cause instanceof ChainResultShapeError) {
    return `${cause.code} on ${cause.method}: expected ${cause.expected}`;
  }
  if (cause instanceof ChainMethodRefusedError) {
    return `${cause.code} ${cause.method} — refused by this plugin, no request sent`;
  }
  if (cause instanceof ChainBlockTagRefusedError) {
    return `${cause.code} ${cause.method} — ${cause.because}`;
  }
  if (cause instanceof ChainEndpointRefusedError) {
    return `${cause.code} from ${cause.source} — ${cause.because}`;
  }
  if (cause instanceof ChainImplementationNotFoundError) {
    return `${cause.code} at ${cause.address}`;
  }
  if (cause instanceof ChainBeaconNotFoundError) {
    return `${cause.code} at ${cause.address}`;
  }
  if (cause instanceof ChainInstanceChangedError) {
    return `${cause.code} ${cause.comparison.signal} — ${cause.context.manifestFile}`;
  }
  if (cause instanceof ChainSlotMalformedError) {
    return `${cause.code} — ${cause.because}`;
  }
  if (cause instanceof ChainAddressUnusableError) {
    return `${cause.code} — ${cause.because}`;
  }
  // Not SF-1's. Let it propagate as itself rather than relabelling it.
  throw cause;
}

// ---------------------------------------------------------------------------
// 2. `TvmDiagnosis` — five members, two of them normal control flow
// ---------------------------------------------------------------------------

/**
 * `classifyNodeError` keys on the JSON-RPC `code` **first** and on the message only
 * to disambiguate within a code (`src/chain/classify.ts:127`). It performs no nested
 * traversal of `error.error`, `error.cause` or `error.data`, because by the time it
 * is callable the transport has already refused anything that would need one.
 */
export function diagnose(payload: JsonRpcErrorPayload): TvmDiagnosis {
  return classifyNodeError(payload);
}

/**
 * `isProbeOutcome` is the only sanctioned test for "this is a normal outcome of a
 * probe" (`src/chain/classify.ts:166`). Exactly two members qualify.
 *
 * `unclassified` is **not** one of them, and that is the guard that matters: "out of
 * energy" arrives on the same `-32000` as a revert, and it is a real failure with a
 * real remedy — raise the fee limit, or fund the account. Absorbed as a revert it
 * would make `looksLikeProxyAdmin` return `false` and skip a transparent-proxy admin
 * check.
 */
export function describeDiagnosis(diagnosis: TvmDiagnosis): string {
  if (isProbeOutcome(diagnosis)) {
    return diagnosis.kind === 'reverted'
      ? `the call reverted${diagnosis.revertData === undefined ? '' : ` (data ${diagnosis.revertData})`}`
      : 'nothing is deployed at the target address';
  }
  switch (diagnosis.kind) {
    case 'method-unsupported':
      return 'the node does not serve this method';
    case 'argument-rejected':
      return 'the node rejected an argument — a plugin defect, or a bad block tag';
    case 'unclassified':
      return 'an unrecognized node error — never absorbed as a probe outcome';
  }
}

// ---------------------------------------------------------------------------
// 3. The policy tables, read rather than restated
// ---------------------------------------------------------------------------

/**
 * The method sets are **data**, not `switch` statements, so a consumer can read them
 * and a test can assert them (`src/chain/policy.ts:1-20`). Eight required plus two
 * refused; the eighth, `eth_getBlockByNumber`, is SF-1's own and upgrades-core never
 * calls it — which is precisely why removing it as "unused" would silently disable
 * the instance fingerprint while every engine-facing test still passed.
 */
export function methodSets(): {
  readonly required: readonly string[];
  readonly refused: readonly string[];
} {
  return { required: requiredMethods, refused: refusedMethods };
}

/** Ask the table, do not hardcode the answer. */
export function isRefused(method: string): boolean {
  return policyFor(method).kind === 'refuse';
}

/**
 * Block tags are refused **uniformly** for every method carrying one, even though
 * the node's own handling is not uniform (`src/chain/policy.ts:212-236`). Measured:
 * an EIP-1898 block object on `eth_call` is validated and then silently answered
 * from present state, while `eth_getCode` and `eth_getStorageAt` reject the same
 * object as `-32700 "JSON parse error"`. One method answers a question it was not
 * asked and two refuse for the wrong stated reason; a per-method policy would encode
 * that inconsistency into the plugin.
 */
export function blockTagIsAccepted(
  method: string,
  params: readonly unknown[],
): boolean {
  return blockTagVerdict(method, params).kind === 'accept';
}

// ---------------------------------------------------------------------------
// 4. `verifyCapabilities` — the complete answer, off the hot path
// ---------------------------------------------------------------------------

/**
 * `createChainAccess` probes one method; this probes all eight and reports both
 * refusals (`src/chain/index.ts:379`). Eight round-trips, so it is for a harness or
 * a diagnostics command, not for an operation. It performs no writes and leaves
 * `identity()`'s memo untouched.
 *
 * **`ok` means the node served the method**, not "the probe succeeded". A node error
 * about the probe arguments is evidence the method exists — `eth_call` against the
 * zero address returns `-32600 "Smart contract is not exist."` on every TRON network
 * — and only `-32601` is evidence it does not.
 *
 * **`refusedLocally` is measured, not restated.** The refusal is driven through
 * `send` and the resulting `ChainMethodRefusedError` is what sets the flag, so a
 * report claiming a local refusal cannot be produced by a build in which the refusal
 * was softened.
 */
export async function report(access: ChainAccess): Promise<CapabilityReport> {
  return verifyCapabilities(access);
}

export function renderReport(report: CapabilityReport): string {
  const served = report.resolved.map(
    verdict =>
      `  ${verdict.ok ? 'served    ' : 'unavailable'} ${verdict.method}` +
      (verdict.detail === undefined ? '' : ` — ${verdict.detail}`),
  );
  const refused = report.refused.map(
    verdict =>
      `  ${verdict.refusedLocally ? 'refused by this plugin' : 'NOT refused — a defect'} ${verdict.method}`,
  );
  return [`endpoint: ${report.endpoint.describe}`, ...served, ...refused].join(
    '\n',
  );
}
