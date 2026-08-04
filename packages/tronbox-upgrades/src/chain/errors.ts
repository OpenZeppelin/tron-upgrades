/**
 * SF-1's error classes and the `TRON_CHAIN_*` code namespace.
 *
 * **Four categories, and the category boundary is the design decision.** The
 * seam's `TronBoxEnvironmentError` family is reused for exactly the one category
 * it fits — the `chain` slot cannot supply chain-state access — and the other
 * three are SF-1's own, in the seam's *idiom*, each documenting why it is not in
 * the family. That is what SF-0 itself does twice (`ArtifactNameAmbiguousError`,
 * `HostInstanceSharedError`).
 *
 * INV-19: eleven codes, closed and enumerable from this module, no two sharing a
 * code, each with one condition and one remedy. **Nine are declared here and two
 * are re-exported from `slots.ts`** — which INV-45 forces, because a module with
 * zero imports cannot throw a class defined elsewhere. `import * as errors` sees
 * a re-export, so the enumeration and the instantiate-all-eleven check both
 * still run against this module.
 *
 * INV-19 also states the negative: SF-1 adds **no** subclass of
 * `TronBoxEnvironmentError` and **no** member to `EnvironmentDiagnosis` or
 * `UnsatisfiedSlot.cause`. `error-semantics.test.ts:84-101` enumerates
 * `src/environment/errors.ts` and asserts that family is exactly three, and
 * `code` there is a template-literal type over `EnvironmentDiagnosis` — so a
 * fourth member fails the baseline, which is the condition attached to reusing the
 * seam's error family: the reuse holds only while the family stays at three members.
 *
 * INV-13: every value SF-1 throws is an `Error` with a non-empty string
 * `message`, and that is load-bearing rather than tidy —
 * `call-optional-signature.js:12` reads `e.message` **unguarded** inside its
 * catch, so a thrown string or a message-less object raises a secondary
 * `TypeError` *inside upstream's error handler*, replacing SF-1's diagnosis with
 * a stack trace from a module the user has never heard of.
 *
 * INV-42 / INV-9: no message, and no enumerable property, carries the raw
 * endpoint URL. Every `endpoint` parameter below is the **scrubbed** form
 * produced by `endpoint.ts`, and each site says so.
 */

import { EnvironmentIncompleteError, unsatisfiedSlot } from '../environment';
import {
  classifyNodeError,
  type JsonRpcErrorPayload,
  type TvmDiagnosis,
} from './classify';

export {
  ChainAddressUnusableError,
  ChainSlotMalformedError,
} from './slots';

/**
 * INV-44: the budget for any node- or network-supplied text in a message.
 *
 * The bound is not hygiene. The measured transport failure a reverse proxy
 * produces is an HTML error page, and axios resolves a non-JSON 2xx body as a
 * **string** rather than rejecting (executed at `axios@1.18.0`) — so the whole
 * page is in hand at the moment the failure is described. A message that embeds
 * it is unreadable, and if the proxy echoes request headers, which error pages
 * do, it is also a leak of whatever INV-43 was keeping out.
 */
const RENDERED_MAX_CHARS = 200;

function bounded(text: string): string {
  return text.length <= RENDERED_MAX_CHARS
    ? text
    : `${text.slice(0, RENDERED_MAX_CHARS)}… ` +
        `(${String(text.length)} characters total)`;
}

/** A caller-supplied or node-supplied value, rendered as a type and a bounded form. */
function renderValue(value: unknown): string {
  if (typeof value === 'string') {
    return `a string ${bounded(JSON.stringify(value))}`;
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `an array of ${String(value.length)} element(s)`;
  }
  return `a ${typeof value}`;
}

/** INV-5-style exhaustiveness: a new failure kind becomes a compile error. */
function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}

/**
 * Why a round-trip produced no JSON-RPC answer at all.
 *
 * Declared here rather than in `transport.ts` because {@link ChainTransportError}
 * is what carries it and `errors.ts` sits below `transport.ts` in the import
 * graph — the alternative direction would make `errors.ts` depend on the module
 * that performs I/O and close a cycle through `endpoint.ts`.
 */
export type TransportFailure =
  /**
   * The socket never connected. On a stock java-tron this is what a *disabled*
   * eth-compat service looks like, because the gate
   * (`node.jsonrpc.httpFullNodeEnable`) is at the service level and port 8545
   * never binds — so the symptom is `ECONNREFUSED`, not `-32601`.
   */
  | { readonly kind: 'unreachable'; readonly detail: string }
  /** A response arrived with a non-2xx status. */
  | { readonly kind: 'http-status'; readonly status: number }
  /**
   * 2xx with a body that is not JSON — typically an HTML error page from a
   * reverse proxy. `detail` carries a bounded excerpt: Design declared this
   * member shapeless, and INV-44 requires the message to state a truncated
   * excerpt, which is only possible if the excerpt is carried.
   */
  | { readonly kind: 'non-json-body'; readonly detail: string }
  /** JSON that is not a JSON-RPC response: no `result` and no well-formed `error`. */
  | { readonly kind: 'malformed-envelope'; readonly detail: string }
  | { readonly kind: 'timeout' };

/**
 * The one `InstanceComparison` member that carries a disagreement.
 *
 * Declared here for the same reason as {@link TransportFailure}:
 * {@link ChainInstanceChangedError} carries it, and `instance.ts` imports
 * `errors.ts` in order to raise a transport-level inconsistency, so the
 * dependency has to run this way to stay acyclic.
 */
export interface ChainInstanceChange {
  readonly kind: 'changed';
  /** Which signal disagreed. The message differs by signal (INV-26). */
  readonly signal: 'chain-id' | 'genesis-hash' | 'first-block-hash';
  readonly recorded: string | null;
  readonly observed: string | null;
}

// ── Category 2 — the adapter's declared refusals ─────────────────────────────
//
// Deliberately **not** `TronBoxEnvironmentError`s. INV-10 fixes that family at
// three, and none of these is a diagnosis of the user's environment.

/**
 * Thrown for `anvil_metadata` and `hardhat_metadata`, from a table, before any
 * request (INV-12).
 *
 * INV-35: this **reaches no user**, and the claim is an enumeration rather than a
 * hope — `getAnvilMetadata` and `getHardhatMetadata` have exactly two call sites
 * in `@openzeppelin/upgrades-core@1.46.0`, both inside
 * `getDevInstanceMetadata`'s nested try/catch. So the message is deliberately
 * terse: rendering a multi-line `EnvironmentIncompleteError` here — naming the
 * peer-dependency range and the invocation-context matrix — twice per
 * `Manifest.forNetwork` for a condition nobody sees is the cost that buys
 * nothing. Both functions are *exported*, so the licence is version-scoped and a
 * test pins the enumeration.
 */
export class ChainMethodRefusedError extends Error {
  readonly code = 'TRON_CHAIN_METHOD_REFUSED' as const;

  constructor(
    readonly method: string,
    readonly because: string,
  ) {
    super(`This plugin does not answer "${method}": ${because}.`);
    this.name = 'ChainMethodRefusedError';
  }
}

/** A block tag or block object the node cannot honour, refused rather than forwarded (INV-20). */
export class ChainBlockTagRefusedError extends Error {
  readonly code = 'TRON_CHAIN_BLOCK_TAG_REFUSED' as const;

  constructor(
    readonly method: string,
    readonly because: string,
  ) {
    super(`"${method}" cannot be served as requested: ${because}.`);
    this.name = 'ChainBlockTagRefusedError';
  }
}

/**
 * The resolved endpoint is structurally unusable.
 *
 * Three conditions reach here, and none of them echoes the URL — INV-42 keeps
 * the raw endpoint out of every message, so the refusal names the **source** that
 * supplied it and the structural fault, which is what the user has to go and fix:
 *
 * - not `http`/`https`, or not an absolute URL at all (INV-31);
 * - a path of `/tre` — the host's cheatcode namespace, which is the fourth and
 *   last defence against the trap `TronWrap.send` sets (INV-30);
 * - a different-origin override on a runtime with no global `fetch`, where the
 *   only remaining transport would be the handle's own HTTP client — and routing
 *   through it is precisely the credential leak INV-43 exists to prevent, so this
 *   refuses instead of falling back.
 */
export class ChainEndpointRefusedError extends Error {
  readonly code = 'TRON_CHAIN_ENDPOINT_REFUSED' as const;

  constructor(
    readonly source: string,
    readonly because: string,
  ) {
    super(`The JSON-RPC endpoint from ${source} cannot be used: ${because}.`);
    this.name = 'ChainEndpointRefusedError';
  }
}

/**
 * A node error that is not a probe outcome. Carries the JSON-RPC code and the
 * node's **verbatim** text.
 *
 * INV-44: the text is unedited and untranslated. Editing it is how INV-22's
 * forbidden translation re-enters through the back door — an appended
 * clarification is a translation with a friendlier name — and it destroys the one
 * artifact a user can search a java-tron issue tracker for.
 *
 * INV-22 also constrains SF-1's *own* framing text around it, which is why the
 * diagnosis is a **field and not part of the message**:
 * `'REVERT opcode executed'.includes('revert')` is `false`, so upstream's four
 * case-sensitive substrings miss both of TRON's probe outcomes — but the string
 * `'reverted'` *does* contain `revert`, so interpolating the diagnosis kind would
 * silently perform exactly the translation INV-22 forbids.
 *
 * The diagnosis is derived here rather than passed in, so there is one
 * classification site and two callers cannot disagree about the same payload.
 */
export class ChainRpcError extends Error {
  readonly code = 'TRON_CHAIN_RPC_ERROR' as const;
  readonly rpcCode: number;
  readonly rpcMessage: string;
  readonly rpcData: unknown;
  readonly diagnosis: TvmDiagnosis;

  constructor(
    readonly method: string,
    payload: JsonRpcErrorPayload,
    /** Scrubbed (INV-42). Never the raw URL. */
    readonly endpoint: string,
  ) {
    super(
      `The node at ${endpoint} refused "${method}" with JSON-RPC code ` +
        `${String(payload.code)}: ${bounded(payload.message)}`,
    );
    this.name = 'ChainRpcError';
    this.rpcCode = payload.code;
    this.rpcMessage = payload.message;
    this.rpcData = payload.data;
    this.diagnosis = classifyNodeError(payload);
  }
}

function renderTransportFailure(cause: TransportFailure): string {
  switch (cause.kind) {
    case 'unreachable':
      return `the endpoint did not accept a connection (${bounded(cause.detail)})`;
    case 'http-status':
      return (
        `the endpoint answered HTTP ${String(cause.status)}, which is not a ` +
        'JSON-RPC response'
      );
    case 'non-json-body':
      return (
        'the endpoint answered successfully with a body that is not JSON, which ' +
        'is what a reverse proxy or a web server in front of the node produces ' +
        `rather than the node itself (body: ${bounded(cause.detail)})`
      );
    case 'malformed-envelope':
      return `the response was not a JSON-RPC envelope (${bounded(cause.detail)})`;
    case 'timeout':
      return (
        'the request timed out. The timeout is the one configured for this ' +
        'network — this plugin sets none of its own'
      );
    default:
      return assertNever(cause, 'TransportFailure');
  }
}

/**
 * A transport failure. **Never** classified as a probe outcome and never
 * swallowed (INV-14).
 *
 * The specimen is the sibling plugin's `slots.ts:getSlot`, which wraps its read
 * in `catch (_)` and reroutes to
 * `hre.network.config.url ?? process.env.TRE_URL ?? 'http://127.0.0.1:9090/jsonrpc'`
 * — so on a public network with `url` unset a **transient** failure silently
 * reads ERC-1967 slots from a local dev chain, and every ERC-1967 read in that
 * plugin rides it. The severity is not "a read failed"; it is that the read
 * *succeeded* against the wrong chain and the answer is plausible.
 */
export class ChainTransportError extends Error {
  readonly code = 'TRON_CHAIN_TRANSPORT' as const;

  constructor(
    readonly method: string,
    readonly cause: TransportFailure,
    /** Scrubbed (INV-42). */
    readonly endpoint: string,
  ) {
    super(
      `"${method}" could not be completed against ${endpoint}: ` +
        `${renderTransportFailure(cause)}.`,
    );
    this.name = 'ChainTransportError';
  }
}

/**
 * A method whose result upgrades-core reads unguarded resolved a value of the
 * wrong shape (INV-4).
 *
 * Without this the failure is a `TypeError` thrown from *inside* the engine,
 * naming nothing — or, for `eth_chainId`, no failure at all and a manifest keyed
 * to a network that does not exist.
 */
export class ChainResultShapeError extends Error {
  readonly code = 'TRON_CHAIN_RESULT_SHAPE' as const;

  constructor(
    readonly method: string,
    readonly expected: string,
    readonly observed: unknown,
  ) {
    super(
      `"${method}" resolved a value this plugin cannot use: expected ` +
        `${expected}, received ${renderValue(observed)}. The endpoint may not ` +
        'be an Ethereum-compatible JSON-RPC service for this chain.',
    );
    this.name = 'ChainResultShapeError';
  }
}

// ── Category 3 — reader-surface refusals ─────────────────────────────────────
//
// Mirror the engine per slot; do not unify. There is deliberately **no**
// `ChainAdminNotFoundError`, and its absence is the design: `getAdminAddress`
// returns the zero address for an empty slot while `getImplementationAddress`
// and `getBeaconAddress` throw. `eip-1967-type.js:isTransparentProxy` is
// `!isEmptySlot(adminAddress)`, so a reader that threw there would make that
// predicate throw instead of returning `false` — and the plugin would disagree
// with the engine about whether an address is a proxy. The sibling returns a
// checksummed zero address for an empty slot, which reads as an answer rather than
// an absence; upstream itself diverges per slot, throwing for beacon while returning
// zero for admin, so matching it per slot is the only way not to invent a third
// convention.

/** Mirrors `EIP1967ImplementationNotFound`, which **throws**. */
export class ChainImplementationNotFoundError extends Error {
  readonly code = 'TRON_CHAIN_IMPLEMENTATION_NOT_FOUND' as const;

  constructor(readonly address: string) {
    super(
      `The contract at ${address} has no ERC-1967 implementation address: ` +
        'both the modern and the legacy implementation slots are empty, so it ' +
        'does not look like an ERC-1967 proxy.',
    );
    this.name = 'ChainImplementationNotFoundError';
  }
}

/** Mirrors `EIP1967BeaconNotFound`. No legacy fallback slot exists for a beacon. */
export class ChainBeaconNotFoundError extends Error {
  readonly code = 'TRON_CHAIN_BEACON_NOT_FOUND' as const;

  constructor(readonly address: string) {
    super(
      `The contract at ${address} has no ERC-1967 beacon address: its beacon ` +
        'slot is empty, so it does not look like a beacon proxy. (A beacon has ' +
        'no legacy fallback slot, so there is no second place to look.)',
    );
    this.name = 'ChainBeaconNotFoundError';
  }
}

// ── Category 4 — the instance-change refusal ─────────────────────────────────

const signalLabels: Readonly<
  Record<ChainInstanceChange['signal'], string>
> = Object.freeze({
  'chain-id': 'chain id',
  'genesis-hash': "genesis block's hash",
  'first-block-hash': "first block's hash",
});

function renderSignalValue(value: string | null): string {
  return value === null ? 'none' : bounded(value);
}

/**
 * The clause that names the **second** file, added additively by SF-3.
 *
 * Empty when no fingerprint path is supplied, which is what keeps every existing
 * construction of {@link ChainInstanceChangedError} rendering byte-identical text.
 *
 * **Why the message needs it at all, and why it sits *before* the remedy.** SF-3
 * persists the chain fingerprint in a file beside the manifest, so a user reading this
 * refusal sees two files and — without this clause — is told to delete one. Deleting
 * the *unfamiliar* one is the natural reading, and it is the one that fails silently:
 * manifest present with no fingerprint is "no recorded identity", which must never
 * refuse, so the next run proceeds and writes the current chain's fingerprint over
 * records written against a different one. The user dismisses the guard permanently by
 * following the message. The same silent pass is reachable a second way — by removing a
 * single *field* from the file rather than the file itself — so both prohibitions are
 * stated as one clause, because they are one hazard.
 *
 * Placed ahead of the remedy paragraph deliberately: a clause appended *after* "delete
 * X and run again" is read by a user who has already decided what to do.
 */
function renderFingerprintClause(sidecarFile: string | undefined): string {
  if (sidecarFile === undefined) {
    return '';
  }
  return (
    `The chain fingerprint these records were checked against is kept in ` +
    `${sidecarFile}, beside the manifest. Deleting that file — or removing a ` +
    'field from it — resets nothing: nothing can tell a cleared fingerprint ' +
    'from a first run, so the next run would accept these records and write ' +
    'this chain fingerprint over them. Whatever you delete, do not delete the ' +
    'fingerprint on its own.\n\n'
  );
}

function renderInstanceChange(
  comparison: ChainInstanceChange,
  context: ChainInstanceChangedError['context'],
): string {
  const records = `${String(context.recordCount)} deployment record(s) in ${context.manifestFile}`;
  const fingerprint = renderFingerprintClause(context.sidecarFile);

  if (comparison.signal === 'chain-id') {
    return (
      `The chain at ${context.endpoint} is a different network than the ` +
      `${records} were written against: they record chain id ` +
      `${renderSignalValue(comparison.recorded)} and it reports ` +
      `${renderSignalValue(comparison.observed)}.\n\n` +
      fingerprint +
      'Nothing has been changed or removed. Check that the network you ' +
      'selected is the one you meant. If you did intend to switch networks, the ' +
      "records for the new one belong in that network's own manifest file — " +
      `${context.manifestFile} describes the old one, and deleting it would ` +
      'lose the record of proxies that are still live.'
    );
  }

  return (
    `The chain at ${context.endpoint} reports the same chain id as the ` +
    `${records}, but its ${signalLabels[comparison.signal]} differs from the ` +
    `one they were written against (recorded ` +
    `${renderSignalValue(comparison.recorded)}, observed ` +
    `${renderSignalValue(comparison.observed)}). This is a different instance ` +
    'of the same chain, so those records do not describe it.\n\n' +
    fingerprint +
    'Nothing has been changed or removed. If this is a disposable local node ' +
    `that has been restarted, delete ${context.manifestFile} and run again. If ` +
    'you did not expect a restart, the node may be serving a different chain ' +
    'than intended — check the endpoint before deleting anything.'
  );
}

/**
 * The chain reports a different instance than the one the records were written
 * against.
 *
 * Refuses, names the remedy, and **discards nothing**. The reason is the failure mode: *a discarded manifest entry is a lost record of
 * a live proxy if the detection is ever wrong.* Detection can be wrong in one
 * direction — a node behind a load balancer serving two forks reports a change
 * that is true about what it observed but not about the user's intent — so the
 * silent-discard branch destroys the only record of a live production proxy on
 * the basis of an observation with a legitimate false-positive path.
 *
 * "Discards nothing" is **structural, not a promise**: SF-1 has no filesystem
 * access at all (INV-33), so it is incapable of modifying the file this message
 * names.
 *
 * Silently *reusing* is the failure that exists today: both of upstream's
 * dev-node accommodations are off on TRON (`isDevelopmentNetwork` false,
 * `getDevInstanceMetadata` undefined, both re-verified at `1.46.0`), so a wiped
 * TRE inherits the previous run's records and the user gets a
 * `checkForAddressClash` error with no named remedy.
 *
 * Follows `ArtifactNameAmbiguousError`'s precedent exactly: **SF-1 owns the text
 * because it holds the comparison, and never throws it.** SF-3 decides that
 * refusal is the policy.
 */
export class ChainInstanceChangedError extends Error {
  readonly code = 'TRON_CHAIN_INSTANCE_CHANGED' as const;

  constructor(
    readonly comparison: ChainInstanceChange,
    readonly context: {
      /** From `manifestPathFor` — a name no user would guess unaided. */
      readonly manifestFile: string;
      readonly recordCount: number;
      /** Scrubbed (INV-42). */
      readonly endpoint: string;
      /**
       * The chain fingerprint file that sits beside the manifest, when the caller has
       * one — **added additively by SF-3.**
       *
       * Optional, and that is what makes the addition additive under
       * `exactOptionalPropertyTypes`: every existing construction omits it and renders
       * byte-identical text, so this file's pinned message tests are the instrument
       * that proves the change was additive rather than a second set of tests written
       * to accommodate it. A *required* field here would have been a compile error at
       * every existing call site, which is the fail-loud signal rather than a problem
       * to work around.
       *
       * Deliberately **not** folded into `manifestFile`. That field's own contract says
       * it is the manifest path from `manifestPathFor`, and this file's tests pin it as
       * *the file*; two paths joined into it would be a lie about a documented field.
       */
      readonly sidecarFile?: string;
    },
  ) {
    super(renderInstanceChange(comparison, context));
    this.name = 'ChainInstanceChangedError';
  }
}

// ── Category 1 — the `chain` slot cannot supply chain-state access ───────────
//
// The seam's family, reused for the one category it fits. `unsatisfiedSlot` is
// the only route to an `UnsatisfiedSlot` (SF-0's INV-14), so `providedIn` and
// `absentIn` are read from `src/environment/slots.ts` and cannot contradict the
// table. This module is the only one in `src/chain/**` that imports the seam's
// error family (INV-48).

/**
 * Structural: the handle does not expose what SF-1 needs.
 *
 * `handle-malformed` fits exactly, and SF-0's INV-17 `'missing'`/`'threw'`
 * distinction is preserved rather than collapsed — a raising host getter and an
 * absent property are different states, and the rendered message says which.
 */
export function chainHandleMalformedError(
  expectedPath: string,
  because: 'missing' | 'threw',
): EnvironmentIncompleteError {
  return new EnvironmentIncompleteError([
    unsatisfiedSlot('chain', {
      kind: 'handle-malformed',
      handle: 'tronWrap',
      expectedPath,
      because,
    }),
  ]);
}

/**
 * INV-18: the appended invocation-context text is why every `detail` below is
 * written as a **non-terminal clause**.
 *
 * `src/environment/errors.ts:renderUnsatisfiedSlot` produces
 * `slot "chain" violates an environment invariant: ${cause.detail} (${context})`,
 * where `context` is `provided in …; absent in …` read from the slot table. For
 * the `chain` slot that renders *"provided in tronbox migrate, tronbox test
 * migration phase, tronbox test mocha files, tronbox console; absent in plain
 * node"* — a statement about which invocation contexts inject the handle, which
 * is true, irrelevant, and actively misdirecting for a live-capability failure:
 * the user's context *did* provide the handle; their node did not serve the RPC.
 *
 * So a `detail` must not assume it terminates the message and must not end in
 * sentence-final punctuation the append would orphan. Each one below instead
 * *names* the parenthetical and disowns it, which is the whole cost of reusing
 * the seam's family and is payable entirely inside this text — asking SF-0 to
 * change the renderer would be a larger change to a closed sub-feature than the
 * one authorized, for a cosmetic gain.
 */
const contextDisclaimer =
  'The chain handle itself was supplied and is well-formed, so the invocation ' +
  'contexts listed at the end of this line are not the cause';

/**
 * Live capability: the handle is sound and the endpoint cannot serve eth-compat
 * JSON-RPC.
 *
 * Spec scenario 3 requires the failure to name the missing network **capability**
 * rather than a generic transport failure, and to do so before an operation
 * starts. The condition is ordinary, not exotic: on a stock self-hosted java-tron
 * the eth-compat service is gated by `node.jsonrpc.httpFullNodeEnable`, default
 * **false**, and when enabled binds port **8545** while the wallet API a
 * `fullHost` names is on **8090** — so the derived endpoint is wrong for a
 * supported configuration, and because the gate is at the service level the
 * symptom is `ECONNREFUSED` rather than `-32601`.
 *
 * @param endpoint scrubbed (INV-42) — never the raw URL.
 * @param nativeApiReachable the best-effort native-API probe's answer, or
 *   `undefined` when it was not run or answered nothing. INV-32: it changes only
 *   the wording, never the diagnosis, so all three values produce the same
 *   `code` and the same `cause.kind`.
 */
export function chainJsonRpcUnavailableError(
  endpoint: string,
  nativeApiReachable: boolean | undefined,
  because: string,
): EnvironmentIncompleteError {
  const lead =
    nativeApiReachable === true
      ? 'the node answered on its native wallet API, but its ' +
        'Ethereum-compatible JSON-RPC service did not answer at ' +
        `${endpoint}`
      : nativeApiReachable === false
        ? 'the node answered neither on its native wallet API nor on its ' +
          `Ethereum-compatible JSON-RPC service at ${endpoint}`
        : 'the Ethereum-compatible JSON-RPC service did not answer at ' +
          `${endpoint}`;

  return new EnvironmentIncompleteError([
    unsatisfiedSlot('chain', {
      kind: 'invariant-violated',
      detail:
        // The reason is normally a `ChainTransportError` message, which ends in a
        // period of its own; stripping it keeps the composed sentence from ending
        // in two.
        `${lead} — ${because.replace(/\.$/, '')}. ${contextDisclaimer}. On a self-hosted ` +
        'java-tron node this service is disabled by default ' +
        '(node.jsonrpc.httpFullNodeEnable) and, when enabled, listens on port ' +
        '8545 while the wallet API listens on 8090, so a fullHost naming 8090 ' +
        'yields no JSON-RPC. Enable the service, or set ' +
        'TRONBOX_UPGRADES_RPC_URL to its URL',
    }),
  ]);
}

/**
 * The handle exposes the property path but its value is not the type SF-1 reads.
 *
 * A third structural state INV-18's two named cases do not cover:
 * `handle-malformed` renders as *"is absent"* or *"threw when read"*, and
 * neither is true of a `fullNode.host` that is present and numeric. Reporting
 * `'missing'` for it would be the wrong message about the right problem, which is
 * the class of failure SF-1 exists to remove — so it goes through
 * `invariant-violated`, where the detail can say what was actually found.
 */
export function chainHandleWrongTypeError(
  expectedPath: string,
  expected: string,
  observed: unknown,
): EnvironmentIncompleteError {
  return new EnvironmentIncompleteError([
    unsatisfiedSlot('chain', {
      kind: 'invariant-violated',
      detail:
        `the chain handle's "${expectedPath}" is ${renderValue(observed)} ` +
        `rather than ${expected}, so this plugin cannot reach the node through ` +
        'it. That is a mismatch between this plugin and the TronBox version ' +
        'that supplied the handle, not something a project setting controls',
    }),
  ]);
}
