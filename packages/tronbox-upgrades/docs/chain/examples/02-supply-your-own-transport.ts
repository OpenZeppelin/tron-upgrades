/**
 * The four injectable seams, and the one you may be *required* to supply.
 *
 * `ChainAccessDependencies` is the complete set of things SF-1 takes from its
 * environment (`src/chain/index.ts:117`). Every one has a stated default, so the
 * common case passes nothing.
 *
 * The seam that matters is `post`. When the endpoint you resolve is a **different
 * origin** than the network's own node, SF-1 will not route the request through the
 * node's HTTP client — that client is an axios instance carrying whatever `headers`
 * and `auth` it was created with, and axios applies both to an *absolute* request
 * URL while ignoring `baseURL` (`src/chain/endpoint.ts:467-489`). `headers` is
 * exactly where a TronGrid API key is configured. So the precedence is:
 *
 *     deps.post  →  globalThis.fetch (read at factory time)  →  refuse
 *
 * and the refusal names `deps.post` as its remedy, which is only honest because
 * supplying it resolves the refusal (`src/chain/endpoint.ts:490-539`).
 */
import {
  DERIVED_RPC_PATH,
  RPC_URL_ENV_VAR,
  createChainAccess,
  type ChainAccess,
  type ChainAccessDependencies,
  type JsonRpcPost,
} from '../../../src/chain';
import { resolveEnvironment, type RawMigrationHandles } from '../../../src/environment';

// ---------------------------------------------------------------------------
// 1. A `JsonRpcPost` over any HTTP client you already have
// ---------------------------------------------------------------------------

/**
 * The whole contract: take a payload, return the parsed body.
 *
 * Two rules, both of which SF-1's own transports follow:
 *
 *  - **Reject on a non-2xx status, with the status attached** as `status` or
 *    `response.status`. `transport.ts` reads either structurally and reports
 *    `http-status` (`src/chain/transport.ts:108`).
 *  - **Resolve a non-JSON 2xx body as a `string`**, do not reject. That is what
 *    axios does — a reverse proxy's HTML error page comes back as the raw string —
 *    and `transport.ts` detects `non-json-body` on the resolved value's *type*
 *    (`src/chain/transport.ts:153-165`). A poster that rejected instead would make
 *    the two transports disagree about what a proxy error page is.
 *
 * Do not add a retry and do not set a timeout: SF-1 makes exactly one round-trip
 * per `send` and inherits the timeout the user configured
 * (`src/chain/transport.ts:245`).
 */
type MinimalResponse = {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
};

export function postThrough(
  url: string,
  request: (
    target: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => Promise<MinimalResponse>,
): JsonRpcPost {
  return async (payload: unknown): Promise<unknown> => {
    const response = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${String(response.status)}`), {
        status: response.status,
      });
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      // Mirror axios: a body that is not JSON resolves as the raw string.
      if (cause instanceof SyntaxError) {
        return text;
      }
      throw cause;
    }
  };
}

// ---------------------------------------------------------------------------
// 2. Each seam, with the reason you would reach for it
// ---------------------------------------------------------------------------

/**
 * `endpointOverride` is SF-1's own DI seam and outranks the environment variable.
 * It is **not** a user-facing option: a per-network key in `tronbox-config.js` was
 * rejected because reading `networks[<name>].<key>` is a TronBox-internal property
 * path, which only `src/environment/**` may do (`src/chain/index.ts:118-125`).
 *
 * Precedence is fixed and there is **no fallback between sources**
 * (`src/chain/endpoint.ts:315`): a present-but-unusable value is refused, never
 * skipped in favour of the next source. Only `undefined` counts as absent — an
 * empty string is a mistake worth naming.
 */
export const precedence = [
  'deps.endpointOverride',
  `deps.env.${RPC_URL_ENV_VAR}`,
  `the network's fullHost/fullNode + "/${DERIVED_RPC_PATH}"`,
] as const;

/**
 * `env` is injected rather than read from the global at module load, and SF-1 reads
 * it **once, at factory time** (`src/chain/index.ts:207`). A module-load read would
 * bake the endpoint into the process, so under `tronbox console` — where switching
 * network mid-session is legitimate — the override would silently keep pointing at
 * the first network.
 */
export function withExplicitEnvironment(
  rpcUrl: string,
): ChainAccessDependencies {
  return { env: { [RPC_URL_ENV_VAR]: rpcUrl } };
}

/**
 * `probeNativeApi` is consulted for **one** purpose: choosing between two wordings
 * of the unavailable-capability message. Its own failure never changes the
 * diagnosis — `true`, `false` and "it threw" all produce the same `code` and the
 * same `cause.kind` (`src/chain/index.ts:261-276`).
 */
export function withNativeApiProbe(
  probe: () => Promise<boolean>,
): ChainAccessDependencies {
  return { probeNativeApi: probe };
}

// ---------------------------------------------------------------------------
// 3. The different-origin case, end to end
// ---------------------------------------------------------------------------

/**
 * A TronGrid-style override on a runtime with no global `fetch`.
 *
 * Without `post` this refuses with `ChainEndpointRefusedError`, and the refusal is
 * correct rather than conservative: the only other transport available is the
 * node's own client, and lending it to a host named in an environment variable is
 * the credential leak the rule exists to prevent.
 *
 * With `post` supplied it proceeds, and the request carries **only** the payload
 * and the one header you construct. Nothing from the node's client travels.
 */
export async function openAcrossOrigins(
  handles: RawMigrationHandles,
  endpoint: string,
  post: JsonRpcPost,
): Promise<ChainAccess> {
  const env = resolveEnvironment(handles, { require: ['chain'] });
  return createChainAccess(env.chain, {
    endpointOverride: endpoint,
    post,
  });
}

/**
 * All four seams at once — which is also how SF-1's own test suite drives it. The
 * suite is the first consumer that is not TronBox, so a reached-for dependency
 * would mean a live node were needed to test a pure classification.
 *
 * There is deliberately **no fifth seam**, no `createChainAccessUnchecked` and no
 * `skipProbe` (`src/chain/index.ts:180-184`): an escape hatch is worse than no
 * probe, because the diagnosis's main failure mode is a caller who skipped it — and
 * it would be skipped in exactly the harness where the endpoint is least standard.
 */
export function allFourSeams(
  endpoint: string,
  post: JsonRpcPost,
): ChainAccessDependencies {
  return {
    endpointOverride: endpoint,
    env: { [RPC_URL_ENV_VAR]: 'ignored — endpointOverride outranks it' },
    post,
    probeNativeApi: async () => false,
  };
}
