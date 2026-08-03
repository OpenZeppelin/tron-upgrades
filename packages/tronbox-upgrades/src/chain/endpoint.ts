/**
 * Endpoint resolution, normalization, scrubbing, and the choice of transport.
 *
 * **INV-29: this is the only module in `src/chain/**` that reads a property off
 * the chain handle, and it reads exactly two paths — `fullNode.host` and
 * `fullNode.request`.** Not `networkConfig`, not `send`, not `request`, not
 * `trx`, not `defaultPrivateKey`, not `utils`. Its typed view
 * {@link TronWrapRpcView} is module-private and **not exported**, so no module
 * outside this file holds a typed view of the handle.
 *
 * That access discipline is the load-bearing half of SF-1's credential story.
 * SF-0 measured that a configured `privateKey` is reachable from the handles it
 * seals — three own-enumerable routes at shallowest depth 4 — and its durable
 * rule is that *all five sealed handles are unsafe to log*. SF-1 inherits the
 * handle **without** the sealing, because its own composite holds no handle in a
 * field (INV-3), so a second module reading `tronWrap.networkConfig` "just for
 * the fee limit" would both cross SF-0's INV-28 boundary and put a
 * credential-reachable object into a second scope in the one sub-feature that
 * was proven not to need `sealSlot`.
 *
 * INV-28: the host is imported by no path. Every reach goes through the handle
 * SF-0 hands over.
 */

import type { ChainHandleSlot } from '../environment';
import {
  ChainEndpointRefusedError,
  chainHandleMalformedError,
  chainHandleWrongTypeError,
} from './errors';

/**
 * SF-1's private view of the chain handle.
 *
 * SF-0's `TronWrapHandle` is `{ trx: object }` and **stays that way**: widening
 * it to expose `send` would make `Manifest.forNetwork(env.chain.tronWrap)`
 * type-check, and `tronWrap.send` POSTs to `this.networkConfig.fullNode + '/tre'`
 * with `default: return _send()` (verified at `tronbox` `v4.9.0`,
 * `src/components/TronWrap/index.js:475`). On any public network that returns
 * HTTP 405 with an HTML body, which the host rewrites into
 * `TRE RPC 'eth_chainId': Request failed with status code 405` — an error naming
 * the wrong capability, which spec scenario 3 forbids in those terms. So SF-1
 * declares its own view, privately.
 *
 * `method` is widened from Design's `'post'` to `'get' | 'post'` because Design's
 * own default native-API refinement probe is a **GET** of
 * `wallet/getnowblock`.
 */
interface TronWrapRpcView {
  readonly fullNode: {
    /** TronWeb's `HttpProvider.host` — the axios `baseURL`. Verified at tronweb 6.3.0/6.4.0. */
    readonly host: string;
    /** `HttpProvider.request(url, payload, method)`; a *relative* url resolves against `baseURL`. */
    request(
      url: string,
      payload: unknown,
      method: 'get' | 'post',
    ): Promise<unknown>;
  };
}

type HandleRequest = TronWrapRpcView['fullNode']['request'];

/** Which of the three sources supplied the endpoint. Reported, never inferred (INV-9). */
export type EndpointOrigin = 'argument' | 'environment' | 'derived';

/**
 * The renderable description of where SF-1 talks to. There is deliberately **no
 * `url` field**, no `host` field, and no field from which the raw endpoint can be
 * reconstructed.
 *
 * INV-9 / INV-42. The raw URL is credential-bearing, and the chain of custody is
 * verified rather than assumed: `filterNetworkConfig` is
 * `fullNode: options.fullNode || options.fullHost` with **no normalization**
 * (`v4.9.0`, verbatim), `tronweb`'s `isValidURL('http://u:p@node:8545')` returns
 * **true** (executed), and `HttpProvider` strips only trailing slashes. So HTTP
 * Basic userinfo and query-string API keys reach `fullNode.host` untouched, and
 * an override certainly can carry both.
 *
 * INV-40's guarantee is met here by there being **no field to leak**, not by
 * redacting one — which is why `sealSlot` is unnecessary. The raw URL exists only
 * in the transport's closure.
 */
export interface EndpointDescriptor {
  /** `<scheme>://<host>[:<port>]<path>` — userinfo stripped, query and fragment dropped. */
  readonly describe: string;
  readonly origin: EndpointOrigin;
}

/** Injectable so tests and a consumer with its own HTTP stack can substitute the round-trip. */
export type JsonRpcPost = (payload: unknown) => Promise<unknown>;

export interface ResolvedEndpoint {
  readonly descriptor: EndpointDescriptor;
  readonly post: JsonRpcPost;
  /**
   * Best-effort native-API reachability check. INV-32: consulted **only** to
   * choose between two wordings of an unavailable-capability message, and its own
   * failure never changes the diagnosis.
   */
  probeNativeApi(): Promise<boolean>;
}

/** The environment variable that overrides the derived endpoint (INV-27). */
export const RPC_URL_ENV_VAR = 'TRONBOX_UPGRADES_RPC_URL';

/** The path appended to `fullNode.host` to derive the endpoint. */
export const DERIVED_RPC_PATH = 'jsonrpc';

/** The host's native-API path the refinement probe reads. */
const NATIVE_API_PROBE_PATH = 'wallet/getnowblock';

/**
 * The host's cheatcode namespace. Refusing an endpoint whose path is this is the
 * **fourth** defence against the `/tre` trap, after type, reach and affordance —
 * and it is the only one that catches an override typo'd or copy-pasted from the
 * host's cheatcode documentation (INV-30).
 */
const CHEATCODE_PATH_SEGMENT = 'tre';

const sourceLabels: Readonly<Record<EndpointOrigin, string>> = Object.freeze({
  argument: 'the endpointOverride argument',
  environment: `the ${RPC_URL_ENV_VAR} environment variable`,
  derived: "the network's configured fullHost/fullNode",
});

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
}

/**
 * Reads one property off a host object, preserving SF-0's INV-17
 * `'missing'`/`'threw'` distinction.
 *
 * A raising host getter and an absent property are different states, and the
 * seam's rendered message says which — so collapsing them here would throw away
 * a distinction SF-0 built its handle diagnosis around. `undefined` counts as
 * missing: a property present with the value `undefined` is not a property SF-1
 * can read the endpoint from, and the two are indistinguishable to a caller.
 */
function readHandlePath(
  owner: unknown,
  key: string,
  path: string,
): unknown {
  if (!isObjectLike(owner)) {
    throw chainHandleMalformedError(path, 'missing');
  }
  let value: unknown;
  try {
    value = owner[key];
  } catch (cause) {
    // A host accessor raised. Reported as `'threw'` rather than swallowed —
    // `build/components/Config.js`'s `network_config` getter is a real specimen
    // of a host getter that raises.
    void cause;
    throw chainHandleMalformedError(path, 'threw');
  }
  if (value === undefined) {
    throw chainHandleMalformedError(path, 'missing');
  }
  return value;
}

/**
 * INV-29's two property paths, read once each and never again.
 *
 * `resolve.ts` validates only that the handle and its `trx` are object-like, so
 * SF-1 supplies its own shape guard over the two paths it actually uses.
 */
function readRpcHandle(chain: ChainHandleSlot): {
  readonly host: string;
  readonly request: HandleRequest;
} {
  // The seam's `TronWrapHandle` deliberately does not declare `fullNode` — that
  // narrowness is INV-30's first defence — so the widening happens here, once,
  // through `unknown`, and every field is validated before it is used.
  const fullNode = readHandlePath(
    chain.tronWrap as unknown,
    'fullNode',
    'tronWrap.fullNode',
  );
  if (!isObjectLike(fullNode)) {
    throw chainHandleWrongTypeError(
      'tronWrap.fullNode',
      "TronWeb's HttpProvider object",
      fullNode,
    );
  }

  const host = readHandlePath(fullNode, 'host', 'tronWrap.fullNode.host');
  if (typeof host !== 'string' || host.length === 0) {
    throw chainHandleWrongTypeError(
      'tronWrap.fullNode.host',
      'a non-empty endpoint URL string',
      host,
    );
  }

  const request = readHandlePath(
    fullNode,
    'request',
    'tronWrap.fullNode.request',
  );
  if (typeof request !== 'function') {
    throw chainHandleWrongTypeError(
      'tronWrap.fullNode.request',
      'a request function',
      request,
    );
  }

  return Object.freeze({
    host,
    // `HttpProvider.request` reads `this.instance`, and TronBox's own override
    // reads `this` too, so the binding is required rather than defensive. This is
    // the one cast in the module, and it is immediately after the `typeof`
    // narrowing that makes it sound.
    request: (request as HandleRequest).bind(fullNode) as HandleRequest,
  });
}

/**
 * INV-42's scrubber: strips **userinfo**, drops the **query** and the
 * **fragment**, keeps scheme, host, port and path.
 *
 * Idempotent — scrubbing its own output re-parses to the same value — and total:
 * it cannot throw for an input that reached it, because only an already-parsed
 * `URL` does.
 */
export function scrubEndpoint(url: URL): string {
  const port = url.port === '' ? '' : `:${url.port}`;
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.protocol}//${url.hostname}${port}${path}`;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function parseEndpoint(raw: string, source: string): URL {
  try {
    return new URL(raw);
  } catch (cause) {
    // `new URL` throws `TypeError` per spec and nothing else can throw here, so
    // the predicate is exact: anything other than a parse failure propagates
    // rather than being reported as a bad endpoint (INV-14).
    if (cause instanceof TypeError) {
      throw new ChainEndpointRefusedError(
        source,
        'it is not an absolute URL. An endpoint must include a scheme, as in ' +
          'http://127.0.0.1:8545/jsonrpc',
      );
    }
    throw cause;
  }
}

/**
 * INV-31 and INV-30, in that order.
 *
 * The scheme check is cheap and catches a class of typo that otherwise surfaces
 * four layers down: `HttpProvider` is an axios instance and cannot speak any
 * other scheme, so a `ws://` override fails with an adapter-level message naming
 * axios rather than the endpoint the user configured. `tronweb`'s own
 * `isValidURL` accepts userinfo, paths, queries and fragments (executed), so
 * upstream validation is not a substitute.
 */
function validateEndpoint(raw: string, source: string): URL {
  const url = parseEndpoint(raw, source);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ChainEndpointRefusedError(
      source,
      `its scheme is "${url.protocol}", and only http and https can carry ` +
        'JSON-RPC to this node',
    );
  }

  const path = stripTrailingSlashes(url.pathname);
  if (path === `/${CHEATCODE_PATH_SEGMENT}` || path.endsWith(`/${CHEATCODE_PATH_SEGMENT}`)) {
    throw new ChainEndpointRefusedError(
      source,
      `its path ends in "/${CHEATCODE_PATH_SEGMENT}", which is TronBox's own ` +
        'cheatcode namespace and not an Ethereum-compatible JSON-RPC endpoint. ' +
        'On a public network it answers HTTP 405; on a local TRE it answers, ' +
        'which makes the mistake work on one machine and fail on another. Use ' +
        `the node's JSON-RPC path — normally /${DERIVED_RPC_PATH}`,
    );
  }

  return url;
}

interface EndpointChoice {
  readonly raw: string;
  readonly origin: EndpointOrigin;
}

/**
 * INV-27: the endpoint is chosen **once**, by a fixed precedence, with **no
 * fallback** between sources.
 *
 * A value that is present but unusable is refused rather than skipped — a user
 * who sets `TRONBOX_UPGRADES_RPC_URL` and typos it must be told so, not silently
 * served from the derived endpoint of a node that happens to answer. The failure
 * this rule prevents is concrete, and shipped: the sibling's `getSlot` reroutes on
 * a blanket catch to `hre.network.config.url ?? process.env.TRE_URL ??
 * 'http://127.0.0.1:9090/jsonrpc'`, so on a public network with `url` unset a
 * transient failure reads ERC-1967 slots **from a local dev chain**. Only
 * `undefined` counts as absent here; an empty string is a mistake worth naming.
 */
function chooseEndpoint(
  host: string,
  endpointOverride: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): EndpointChoice {
  if (endpointOverride !== undefined) {
    return { raw: endpointOverride, origin: 'argument' };
  }
  const fromEnv = env[RPC_URL_ENV_VAR];
  if (fromEnv !== undefined) {
    return { raw: fromEnv, origin: 'environment' };
  }
  return {
    raw: `${stripTrailingSlashes(host)}/${DERIVED_RPC_PATH}`,
    origin: 'derived',
  };
}

/**
 * The origin comparison INV-43 keys to.
 *
 * A handle host that does not parse is treated as a **different** origin, which
 * is the safe direction: the rule's whole purpose is to keep the handle's
 * credentials off a host SF-1 cannot prove is the handle's own.
 */
function isSameOriginAsHandle(target: URL, host: string): boolean {
  try {
    return new URL(host).origin === target.origin;
  } catch (cause) {
    if (cause instanceof TypeError) {
      return false;
    }
    throw cause;
  }
}

/** The minimal structural shape of a `fetch` implementation SF-1 uses. */
type FetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
};
type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
) => Promise<FetchResponse>;

/**
 * Read at **factory time, never at module load** (INV-24), so a process that
 * polyfills or replaces `fetch` between requires is not baked in.
 *
 * Reading a platform global is permitted here under the ratified reading of
 * INV-46: it bars ambient *configuration* and singletons, not platform builtins —
 * a literal reading is unsatisfiable, because INV-31 mandates `new URL(...)` and
 * `URL` is a platform global too.
 */
function globalFetch(): FetchLike | undefined {
  const candidate = (globalThis as Record<string, unknown>)['fetch'];
  return typeof candidate === 'function'
    ? (candidate as FetchLike)
    : undefined;
}

/** Mirrors axios's `transformResponse[0]`: parse JSON, and on failure resolve the raw text. */
function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    // INV-1 / finding 7: a non-JSON 2xx body must **resolve as a string** rather
    // than reject, because that is what axios does — `'<html>oops</html>'` in,
    // the same string out, executed at `axios@1.18.0`. `transport.ts` detects
    // `non-json-body` on the resolved value's *type*, so this poster has to
    // behave the same way or the two transports would disagree about what a
    // reverse proxy's error page is.
    if (cause instanceof SyntaxError) {
      return text;
    }
    throw cause;
  }
}

/**
 * The different-origin transport: carries **only** the payload and the one header
 * SF-1 constructs (INV-43).
 *
 * No timeout is set, because SF-1 never sets one (INV-41). The handle's
 * configured timeout genuinely does not apply across origins, and that is the
 * trade INV-43 accepts — a credential reaching a host the user named in an
 * environment variable is the worse outcome.
 */
function fetchPoster(target: string, fetchImpl: FetchLike): JsonRpcPost {
  return async (payload: unknown): Promise<unknown> => {
    const response = await fetchImpl(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      // Rejecting with the status attached is what lets `transport.ts` keep one
      // rejection classifier for both transports; axios reports the same fact as
      // `error.response.status`.
      throw Object.assign(
        new Error(`HTTP ${String(response.status)}`),
        { status: response.status },
      );
    }
    return parseBody(await response.text());
  };
}

/**
 * Resolves the endpoint and selects the transport.
 *
 * @throws {EnvironmentIncompleteError} the handle does not expose
 *   `fullNode.host` / `fullNode.request`, or exposes them with the wrong type.
 * @throws {ChainEndpointRefusedError} the resolved endpoint is not an absolute
 *   http(s) URL, points at the host's `/tre` cheatcode path, or is a
 *   different-origin override on a runtime with no transport SF-1 can use
 *   without lending it the handle's credentials.
 */
export function resolveEndpoint(
  chain: ChainHandleSlot,
  endpointOverride: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  explicitPost?: JsonRpcPost,
): ResolvedEndpoint {
  const handle = readRpcHandle(chain);
  const choice = chooseEndpoint(handle.host, endpointOverride, env);
  const source = sourceLabels[choice.origin];
  const url = validateEndpoint(choice.raw, source);

  const descriptor: EndpointDescriptor = Object.freeze({
    describe: scrubEndpoint(url),
    origin: choice.origin,
  });

  const post = selectPost(choice, url, handle, source, explicitPost);

  return Object.freeze({
    descriptor,
    post,
    probeNativeApi: async (): Promise<boolean> => {
      const answer = await handle.request(NATIVE_API_PROBE_PATH, {}, 'get');
      return isObjectLike(answer) && answer['blockID'] !== undefined;
    },
  });
}

/**
 * INV-43, and INV-41's other half.
 *
 * When the resolved endpoint's origin **is** the handle's own, inheriting the
 * handle's HTTP client is permitted and preferred, because that client carries
 * the timeout the user configured and SF-1 must neither lengthen nor shorten it.
 * When the origin differs, the request goes through a transport carrying nothing
 * SF-1 did not construct.
 *
 * The rule is keyed to SF-1's own origin check rather than to a measurement,
 * and the reason is that the measurement expires. `HttpProvider`'s constructor is
 * `axios.create({ baseURL, timeout, headers, auth: user ? {username: user,
 * password} : undefined })`, and axios applies an instance's headers and auth to
 * an **absolute** request URL while ignoring `baseURL` — so handing the absolute
 * override to `fullNode.request` (the cheapest implementation, and the one that
 * preserves the timeout) would send whatever the instance carries to a host named
 * in an environment variable. *Today* nothing travels: TronBox constructs TronWeb
 * positionally as `new TronWebProxy(fullNode, solidityNode, eventServer,
 * privateKey)` and passes no `headers`, no `user` and no `password` (verified at
 * `v4.9.0`). But `headers` is precisely the parameter a TronGrid API key is
 * configured through, so a rule keyed to that fact expires silently at the next
 * minor. This is the framing SF-0 adopted for its all-five sealing rule.
 */
function selectPost(
  choice: EndpointChoice,
  url: URL,
  handle: { readonly host: string; readonly request: HandleRequest },
  source: string,
  explicitPost: JsonRpcPost | undefined,
): JsonRpcPost {
  // **An injected dependency outranks a platform default.** Found by SF-1 Tests:
  // the different-origin refusal below names `deps.post` as its remedy, and
  // consulting `globalThis.fetch` first made that remedy unreachable — supplying
  // `deps.post` could not resolve a refusal raised before it was ever consulted.
  // An error that states a fix the code forbids is worse than one that states
  // none. Precedence is therefore `deps.post` → `globalThis.fetch` (read at
  // factory time, never module load — INV-24) → refuse, and the refusal still
  // fires when there is neither. This also matches `createChainAccess`'s own
  // `deps.post ?? resolved.post`, which already gave the injected seam
  // precedence on the same-origin path.
  if (explicitPost !== undefined) {
    return explicitPost;
  }

  const sameOrigin =
    choice.origin === 'derived' || isSameOriginAsHandle(url, handle.host);

  if (sameOrigin) {
    // A *relative* url for the derived endpoint, so axios resolves it against
    // the handle's `baseURL` — and so INV-36 can assert the request url is
    // exactly `jsonrpc`, which is not in `_getConsoleLog`'s three-path
    // allow-list (`wallet/triggerconstantcontract`,
    // `walletsolidity/triggerconstantcontract`, `wallet/broadcasttransaction`),
    // so no host-side console-log extraction occurs on any read SF-1 performs.
    const target = choice.origin === 'derived' ? DERIVED_RPC_PATH : choice.raw;
    return (payload: unknown): Promise<unknown> =>
      handle.request(target, payload, 'post');
  }

  const fetchImpl = globalFetch();
  if (fetchImpl === undefined) {
    throw new ChainEndpointRefusedError(
      source,
      "it names a different origin than the network's own node, and this " +
        'runtime provides no global fetch to reach it with. The only other ' +
        "transport available here is the node's own HTTP client, and this " +
        'plugin will not send that client\'s headers or credentials to a ' +
        'different host. Run on a runtime with fetch, or supply your own ' +
        'transport as the `post` dependency',
    );
  }
  return fetchPoster(choice.raw, fetchImpl);
}
