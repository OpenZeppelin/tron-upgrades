/**
 * The TVM-vs-EVM error vocabulary: what a node error *means*.
 *
 * **This module has zero imports.** `JsonRpcErrorPayload` is declared
 * here rather than in `transport.ts` for that reason — it is this function's
 * input type, and importing it would make the pure classifier depend on the
 * module that performs I/O. `transport.ts` imports it from here, which is the
 * direction that keeps the graph acyclic and this file extraction-ready.
 */

/**
 * A **validated** node error. `code` is a number and `message` is a string *by
 * the time this type exists* — `transport.ts` refuses anything else as
 * `malformed-envelope`.
 *
 * That single validation is the structural fix for a predicate that read only
 * `error.message`: a nested `error.error.message`, or a thrown string, yielded `''`
 * and so classified as "not a revert" and rethrew. The riskiest consumer of that
 * miss silently disables a safety check.
 * The measured diagnosis: the sibling reads only `error.message`, so a nested
 * `error.error.message` or a thrown string yields `''`. The fix is not a deeper
 * walk at the classification site (a nested walk through the error shape is
 * not allowed); it is that
 * classification never sees an unvalidated shape, so there is nothing to walk.
 */
export interface JsonRpcErrorPayload {
  readonly code: number;
  readonly message: string;
  /**
   * java-tron carries revert data here only from v4.8.1; below that there is a
   * message and no payload (`tronbox/tre:1.0.4` = v4.7.3). When there is no
   * payload it is the **literal string `"{}"`**, not absent — confirmed live on
   * 4.8.2, where *non-revert* errors carry `"{}"` too. So `data`'s presence
   * proves nothing and any decoding is gated on a `0x` prefix.
   */
  readonly data?: unknown;
}

/**
 * What a node error means. Two of the five members are normal control flow for a
 * probe; three are failures.
 *
 * Keeping `no-contract-at-address` distinct from `reverted` matters because a
 * predicate matching the node's "smart contract is not exist" as a revert tells a
 * user their address "is not an upgradeable beacon" when in fact nothing is deployed
 * there at all. The two conditions must stay distinguishable even though the node
 * reports them identically. The
 * sibling tells a user their address "is not an upgradeable beacon: its
 * `implementation()` getter did not return an address" when in fact nothing is
 * deployed there at all.
 */
export type TvmDiagnosis =
  /** `-32600` + "Smart contract is not exist." — nothing deployed at the target. */
  | { readonly kind: 'no-contract-at-address' }
  /** `-32000` + a message naming the REVERT opcode — the call reverted. */
  | { readonly kind: 'reverted'; readonly revertData?: string }
  /** `-32601`, either message shape — the node does not serve this method. */
  | { readonly kind: 'method-unsupported' }
  /** `-32602` — the node rejected an argument. A plugin defect, or a bad tag. */
  | { readonly kind: 'argument-rejected' }
  /** Anything else. Never silently treated as a probe outcome. */
  | { readonly kind: 'unclassified' };

/** The two members that are a normal outcome of a probe. Named once. */
export type ProbeDiagnosis = Extract<
  TvmDiagnosis,
  { readonly kind: 'no-contract-at-address' | 'reverted' }
>;

/** Exhaustiveness check: a sixth member becomes a compile error. */
function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}

/**
 * The four JSON-RPC / TVM codes measured live against java-tron 4.8.2. Named
 * constants rather than inline literals so a code appears once.
 */
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const TVM_EXECUTION_ERROR = -32000;

/**
 * Measured: `-32600` + `"Smart contract is not exist."`. Matched as two
 * independent substrings rather than the whole sentence, so a wording change
 * ("does not exist", a dropped "Smart") still classifies — but *positively*,
 * never as a `-32600` catch-all, because an unrecognized `-32600` must reach
 * `unclassified` rather than become "nothing is deployed here".
 */
function saysNoContract(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('contract') &&
    (text.includes('not exist') || text.includes("doesn't exist"))
  );
}

/**
 * Measured: `-32000` + `"REVERT opcode executed"`.
 *
 * This is a positive match on `-32000` rather than a `default:
 * reverted` arm, because a catch-all must never be mistaken for a normal
 * probe outcome: **"out of energy" arrives on the same `-32000`**, and it is a
 * real failure with a real remedy (raise the fee limit, or fund the account).
 * Classified as a revert it would make `looksLikeProxyAdmin` return `false` and
 * skip a transparent-proxy admin check because the account ran out of a resource
 * the user could have topped up in a second.
 */
function saysReverted(message: string): boolean {
  return message.toLowerCase().includes('revert');
}

/**
 * Revert data exists only from java-tron v4.8.1, and below that `data` is the
 * literal string `"{}"`. Decoding is gated on the `0x` prefix, so `"{}"` — which
 * arrives on non-revert errors too — is never mistaken for a payload.
 */
function revertData(data: unknown): string | undefined {
  return typeof data === 'string' && data.startsWith('0x') ? data : undefined;
}

/**
 * Keys on JSON-RPC `code` **first** and message only to disambiguate within a
 * code — never message alone.
 *
 * The sibling's predicate matches a bare `revert` case-insensitively anywhere in
 * any message, which also matches a contract-authored or node-authored string
 * containing the word, and its riskiest consumer (`inferProxyAdmin`) turns a
 * false positive into a **silently disabled safety check**.
 *
 * Performs no nested traversal of `error.error`, `error.cause` or `error.data`
 * — by the time this is callable, `transport.ts` has already refused
 * anything that would need one.
 */
export function classifyNodeError(error: JsonRpcErrorPayload): TvmDiagnosis {
  switch (error.code) {
    case JSONRPC_INVALID_REQUEST:
      return saysNoContract(error.message)
        ? { kind: 'no-contract-at-address' }
        : { kind: 'unclassified' };
    case TVM_EXECUTION_ERROR: {
      if (!saysReverted(error.message)) {
        return { kind: 'unclassified' };
      }
      const data = revertData(error.data);
      // `exactOptionalPropertyTypes` is on: an explicit `undefined` is not
      // assignable to `revertData?: string`, so the key is spread or absent.
      return data === undefined
        ? { kind: 'reverted' }
        : { kind: 'reverted', revertData: data };
    }
    case JSONRPC_METHOD_NOT_FOUND:
      return { kind: 'method-unsupported' };
    case JSONRPC_INVALID_PARAMS:
      return { kind: 'argument-rejected' };
    default:
      return { kind: 'unclassified' };
  }
}

/**
 * `true` iff the diagnosis is a normal outcome of a probe. Exactly two members,
 * named once.
 *
 * Written as an exhaustive `switch` so a sixth `TvmDiagnosis` member forces a
 * decision at compile time rather than falling into a permissive default — the
 * `default: return true` arm is the natural way to write this function and is
 * the reason the two-member rule is stated rather than implied.
 *
 * The return type narrows to {@link ProbeDiagnosis} so a caller that has checked
 * this cannot then read a `because` from a non-probe member: the narrowing is
 * what makes `read.ts`'s two no-answer reasons exhaustive without a cast.
 */
export function isProbeOutcome(
  diagnosis: TvmDiagnosis,
): diagnosis is ProbeDiagnosis {
  switch (diagnosis.kind) {
    case 'no-contract-at-address':
      return true;
    case 'reverted':
      return true;
    case 'method-unsupported':
      return false;
    case 'argument-rejected':
      return false;
    case 'unclassified':
      return false;
    default:
      return assertNever(diagnosis, 'TvmDiagnosis');
  }
}
