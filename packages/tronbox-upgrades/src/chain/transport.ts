/**
 * One JSON-RPC round-trip. The **only** module that ever sees a
 * `{jsonrpc, id, result|error}` envelope.
 *
 * **This module never throws for a node error.** It returns
 * {@link JsonRpcOutcome}, and `provider.ts` switches on it with `assertNever`.
 * That split — the function that returns a result is a different function from
 * the one that inspects the envelope — is what makes upstream's
 * `Broken invariant: … chainId undefined does not match eth_chainId 728126428`
 * abort **structurally unreachable** rather than avoided by convention (INV-1).
 *
 * The abort is not hypothetical; it is the measured default outcome of the obvious
 * implementation. `manifest.js:getDevInstanceMetadata` distinguishes a dev
 * instance from a persistent one by *catching*, and its throw sits **outside both
 * catch blocks**. An adapter that resolves `{jsonrpc, id, error}` for
 * `anvil_metadata` therefore aborts `Manifest.forNetwork` — on the path of every
 * deploy and every upgrade — with a message naming neither TRON nor the adapter.
 * An adapter that resolves `null` instead raises an uncaught `TypeError` on
 * `networkMetadata.chainId` at the same place. The plugin would not be subtly
 * degraded; it would not work at all, and the diagnosis would point at Hardhat.
 *
 * A `try/catch` inside a single `send` — the shape `tronWrap.send` has, and the
 * shape that produces the trap — cannot express this union, so it cannot be
 * reached by "simplifying" the transport.
 */

import type { EndpointDescriptor, JsonRpcPost } from './endpoint';
import type { JsonRpcErrorPayload } from './classify';
import type { TransportFailure } from './errors';

export interface JsonRpcRequest {
  readonly method: string;
  readonly params: readonly unknown[];
}

/**
 * **No member carries both a result and an error.**
 *
 * `outcome.result` is only reachable inside the `'result'` branch, so a
 * passthrough returning the envelope instead of `envelope.result`, or one that
 * resolves `{error}` instead of raising, cannot be written without changing this
 * type. Mirrors SF-0's `PropertyRead` / `GroupOutcome` idiom.
 */
export type JsonRpcOutcome =
  | { readonly kind: 'result'; readonly result: unknown }
  | { readonly kind: 'node-error'; readonly error: JsonRpcErrorPayload }
  | { readonly kind: 'transport-failure'; readonly cause: TransportFailure };

export interface RpcChannel {
  readonly endpoint: EndpointDescriptor;
  post(request: JsonRpcRequest): Promise<JsonRpcOutcome>;
}

const JSONRPC_VERSION = '2.0';

/**
 * INV-44: the excerpt budget for a body or a rejection message. The 1 MB HTML
 * error page a reverse proxy serves arrives here whole.
 */
const EXCERPT_MAX_CHARS = 200;

function excerpt(text: string): string {
  return text.length <= EXCERPT_MAX_CHARS
    ? text
    : `${text.slice(0, EXCERPT_MAX_CHARS)}… (${String(text.length)} characters total)`;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
}

/**
 * A defensive read with **no** `try/catch`.
 *
 * INV-14 forbids an unpredicated catch anywhere in `src/chain/**`, and there is
 * nothing to predicate on here: a rejection value whose property access throws is
 * pathological, and letting that throw propagate is strictly better than
 * misclassifying it as a transport failure. What must never happen is a real
 * failure being *reported as something else*, which is what a catch here would do.
 */
function peek(owner: unknown, key: string): unknown {
  return isObjectLike(owner) ? owner[key] : undefined;
}

function renderRejection(cause: unknown): string {
  const message = peek(cause, 'message');
  if (typeof message === 'string' && message.length > 0) {
    return excerpt(message);
  }
  const code = peek(cause, 'code');
  if (typeof code === 'string' && code.length > 0) {
    return excerpt(code);
  }
  return `a ${typeof cause} with no message`;
}

/**
 * Turns a rejected round-trip into a {@link TransportFailure}.
 *
 * Reads a small set of well-known shapes structurally rather than importing an
 * HTTP client: `error.response.status` is axios's, `error.status` is what
 * `endpoint.ts`'s fetch poster attaches, and the timeout codes are axios's and
 * undici's. Anything unrecognized is `unreachable` **with its text preserved** —
 * never a probe outcome, never a benign value (INV-14).
 */
function classifyRejection(cause: unknown): TransportFailure {
  const status =
    peek(peek(cause, 'response'), 'status') ?? peek(cause, 'status');
  if (typeof status === 'number') {
    return { kind: 'http-status', status };
  }

  const code = peek(cause, 'code');
  if (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ERR_CANCELED' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return { kind: 'timeout' };
  }

  return { kind: 'unreachable', detail: renderRejection(cause) };
}

function renderId(id: unknown): string {
  return typeof id === 'string' || typeof id === 'number'
    ? JSON.stringify(id)
    : `a ${typeof id}`;
}

/**
 * Validates the resolved body into exactly one {@link JsonRpcOutcome} member.
 *
 * **INV-21: the `id` is diagnostic only and never a discriminator.** A response
 * whose id does not match the request's is classified exactly as if it had
 * matched, on the basis of its `result`/`error` content alone — which **corrects**
 * Design, whose `malformed-envelope` trigger list included "a mismatched id".
 * Measured live: java-tron answers a request carrying `"id": 7` with
 * `"id": "null"` — the JSON **string** — whenever it returns `-32700`, which is
 * exactly what an EIP-1898 block object on a state method produces. Under
 * Design's rule that real, well-formed node error would be reported as "the
 * response was not JSON-RPC", discarding the code and the message. Correlation
 * buys nothing to offset it: SF-1 issues one request per round-trip and never
 * batches, so a response cannot be confused with another request's.
 *
 * The id is still useful *as* a diagnostic, so it is named in a
 * `malformed-envelope` detail produced for some other reason.
 */
function validateEnvelope(body: unknown, requestId: number): JsonRpcOutcome {
  // INV-1 / finding 7: **a non-JSON 2xx body resolves as a `string`, it does not
  // reject** — axios's default `transformResponse[0]` attempts `JSON.parse` and
  // returns the raw input on failure, executed at `axios@1.18.0`:
  // `'<html>oops</html>'` in, the same string out. So this is detected on the
  // resolved value's **type**, not in a catch. An implementation that only guards
  // the reject path hands an HTML error page to the engine as a result.
  if (typeof body === 'string') {
    return {
      kind: 'transport-failure',
      cause: { kind: 'non-json-body', detail: excerpt(body) },
    };
  }

  if (!isObjectLike(body)) {
    return {
      kind: 'transport-failure',
      cause: {
        kind: 'malformed-envelope',
        detail:
          `the response was a ${typeof body} rather than a JSON-RPC object ` +
          `(request id ${String(requestId)})`,
      },
    };
  }

  const observedId = renderId(body['id']);
  const error = body['error'];

  // `error` is checked before `result` so that a reply carrying `error: null`
  // alongside a real `result` — which some proxies emit — is read as a result
  // rather than as a malformed envelope.
  if (error !== undefined && error !== null) {
    const code = peek(error, 'code');
    const message = peek(error, 'message');
    if (typeof code === 'number' && typeof message === 'string') {
      const data = peek(error, 'data');
      // `exactOptionalPropertyTypes` is on, so the key is spread or absent
      // rather than explicitly `undefined`.
      const payload: JsonRpcErrorPayload =
        data === undefined ? { code, message } : { code, message, data };
      return { kind: 'node-error', error: payload };
    }
    return {
      kind: 'transport-failure',
      cause: {
        kind: 'malformed-envelope',
        detail:
          'the response carried an "error" that is not a JSON-RPC error ' +
          `object with a numeric code and a string message (response id ` +
          `${observedId}, request id ${String(requestId)})`,
      },
    };
  }

  if ('result' in body) {
    // `result: null` is a legitimate **result**, not a failure: measured live,
    // `eth_getBlockByNumber('0xfffffffff')` returns `{"result":null}`, so "there
    // is no such block" is an answer and INV-8 forbids collapsing it into the
    // same value as "the read failed".
    return { kind: 'result', result: body['result'] };
  }

  return {
    kind: 'transport-failure',
    cause: {
      kind: 'malformed-envelope',
      detail:
        'the response had neither a "result" nor a well-formed "error" ' +
        `(response id ${observedId}, request id ${String(requestId)})`,
    },
  };
}

/**
 * One channel per {@link import('./index').ChainAccess}.
 *
 * INV-24: the request-id counter lives on the **instance**, in this closure,
 * never at module scope. A module-scope counter shared across two `ChainAccess`
 * instances would make the ids of one channel depend on the traffic of another,
 * turning a diagnostic into noise.
 *
 * INV-39: exactly one HTTP round-trip per `post`. No retry, no backoff, no timer,
 * no queue, no rate limiter. A retry here would make a transport failure look
 * like a slow success, and a transport failure absorbed — by a blanket catch, or
 * by a retry that eventually succeeds — silently disables the safety check that
 * depended on the read. It would also break INV-1's contract in a way the type
 * cannot catch, since two attempts can produce two different outcomes and the
 * second would be returned as if it were the first. `HttpProvider` already
 * carries the user's configured timeout, so a retry is not filling a gap; it is
 * overriding a decision the user made.
 *
 * INV-41: nothing accumulates. The only retained state is a number.
 */
export function createRpcChannel(
  endpoint: EndpointDescriptor,
  post: JsonRpcPost,
): RpcChannel {
  let nextId = 1;

  return Object.freeze({
    endpoint,
    async post(request: JsonRpcRequest): Promise<JsonRpcOutcome> {
      const id = nextId;
      nextId += 1;

      let body: unknown;
      try {
        body = await post({
          jsonrpc: JSONRPC_VERSION,
          id,
          method: request.method,
          params: request.params,
        });
      } catch (cause) {
        // The one catch on this path, and it is not a swallow: the rejection is
        // *classified* into a named `TransportFailure` and returned as a union
        // member the caller must handle. INV-14's prohibition is on converting a
        // transport failure into a no-answer or a benign value, which is exactly
        // what the three-member union makes unrepresentable here.
        return { kind: 'transport-failure', cause: classifyRejection(cause) };
      }

      return validateEnvelope(body, id);
    },
  });
}
