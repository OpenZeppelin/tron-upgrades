/**
 * Fixtures for the chain layer (`chain-state-access`).
 *
 * Two design rules, both load-bearing rather than stylistic.
 *
 * **1. The handle fixture models axios, not a convenient stub.** The
 * credential-reachability rule's whole risk is a property of `axios.create`:
 * an instance applies its `headers` and `auth` to an **absolute** request URL
 * while ignoring `baseURL`. A fixture that only echoed back the url would
 * pass whether or not the chain layer selected the right transport, so
 * {@link createHandleFixture} reproduces the resolution rule and records the
 * headers and auth that *would* have travelled. That is what makes "the
 * credential did not leak" a measurement instead of an assumption.
 *
 * **2. Nothing here needs a live node, and nothing reaches for a global.**
 * Every dependency this module can substitute — `endpointOverride`, `env`,
 * `post`, `probeNativeApi` — is the complete set, so every fixture in this
 * module is passed *in*. The chain layer's own test suite is the first
 * consumer that is not TronBox, which makes this file the standing evidence
 * that the seam is complete.
 */

import type { ChainHandleSlot } from '../../src/environment';

// ---------------------------------------------------------------------------
// JSON-RPC answers
// ---------------------------------------------------------------------------

/** What a fixture transport does with one request. */
export type RpcAnswer =
  /** A well-formed `{jsonrpc, id, result}` envelope. */
  | { readonly result: unknown }
  /** A well-formed `{jsonrpc, id, error}` envelope. */
  | {
      readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: unknown;
      };
    }
  /**
   * The resolved body, verbatim, with no envelope wrapping — for the
   * malformed-envelope and non-JSON-body cases. A `string` here is the measured
   * axios behaviour for a non-JSON 2xx body — the outcome union's
   * malformed-body member.
   */
  | { readonly body: unknown }
  /** The transport rejects. Anything: an axios-shaped error, a plain `Error`, a string. */
  | { readonly reject: unknown };

export interface RpcTable {
  readonly [method: string]: RpcAnswer;
}

/** Mainnet's chain id, minimal `0x` form — the value `eth_chainId` must return. */
export const MAINNET_CHAIN_ID = '0x2b6653dc';

/**
 * The default answer table: enough for `createChainAccess` to complete its
 * single construction-time probe and nothing more, so a test that needs
 * another method has to say so.
 */
export const defaultRpcTable: RpcTable = {
  eth_chainId: { result: MAINNET_CHAIN_ID },
};

interface RequestEnvelope {
  readonly id: unknown;
  readonly method: string;
  readonly params: readonly unknown[];
}

function readEnvelope(payload: unknown): RequestEnvelope {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(
      `fixture transport received a ${typeof payload} rather than a JSON-RPC payload`,
    );
  }
  const record: Record<string, unknown> = { ...payload };
  const method = record['method'];
  if (typeof method !== 'string') {
    throw new Error('fixture transport received a payload with no string method');
  }
  const params = record['params'];
  return {
    id: record['id'],
    method,
    params: Array.isArray(params) ? params : [],
  };
}

/**
 * Applies one {@link RpcTable} to one payload.
 *
 * An unlisted method throws rather than defaulting, because a silently-defaulted
 * method is how a round-trip-count assertion passes while measuring the
 * wrong thing.
 */
function answer(table: RpcTable, payload: unknown): unknown {
  const envelope = readEnvelope(payload);
  const entry = table[envelope.method];
  if (entry === undefined) {
    throw new Error(
      `fixture transport has no answer for ${envelope.method}; ` +
        `known: ${Object.keys(table).sort().join(', ') || '(none)'}`,
    );
  }
  if ('reject' in entry) {
    throw entry.reject;
  }
  if ('body' in entry) {
    return entry.body;
  }
  if ('error' in entry) {
    return { jsonrpc: '2.0', id: envelope.id, error: entry.error };
  }
  return { jsonrpc: '2.0', id: envelope.id, result: entry.result };
}

// ---------------------------------------------------------------------------
// deps.post — the recording transport
// ---------------------------------------------------------------------------

export interface RecordedCall {
  readonly method: string;
  readonly params: readonly unknown[];
  readonly id: unknown;
}

export interface PostFixture {
  readonly post: (payload: unknown) => Promise<unknown>;
  /** Live view — read it after the call under test. */
  readonly calls: readonly RecordedCall[];
  readonly methods: () => readonly string[];
}

/**
 * A `deps.post` that records every round-trip.
 *
 * The single most reused fixture in the suite: post-count and refusal-timing
 * assertions throughout the chain layer are all assertions about *what was
 * posted and how often*, and none of them can be written against a transport
 * that does not count.
 */
export function createRecordingPost(
  table: RpcTable = defaultRpcTable,
): PostFixture {
  const calls: RecordedCall[] = [];
  return {
    calls,
    methods: (): readonly string[] => calls.map(call => call.method),
    post: async (payload: unknown): Promise<unknown> => {
      const envelope = readEnvelope(payload);
      calls.push({
        method: envelope.method,
        params: envelope.params,
        id: envelope.id,
      });
      return answer(table, payload);
    },
  };
}

// ---------------------------------------------------------------------------
// The chain handle
// ---------------------------------------------------------------------------

/**
 * One request as it would have left the handle's HTTP client, including the
 * credential material the axios instance would have attached.
 */
export interface RecordedHandleRequest {
  /**
   * The url as the chain layer passed it — relative for the derived
   * endpoint's fixed path.
   */
  readonly url: string;
  /** Where axios would actually have sent it, after `baseURL` resolution. */
  readonly resolvedUrl: string;
  readonly httpMethod: 'get' | 'post';
  readonly payload: unknown;
  /** The instance headers axios applies regardless of the url's absoluteness. */
  readonly headers: Readonly<Record<string, string>>;
  readonly auth: { readonly username: string; readonly password: string } | undefined;
  readonly timeout: number;
}

/**
 * Structurally `TronWrapHandle` (`{ trx: object }`) plus the one nested
 * object the handle-sealing rule permits the chain layer to read. Declared as
 * an interface so assigning it into a `ChainHandleSlot` is a plain structural
 * assignment rather than an excess-property error — and so no cast appears
 * anywhere in this suite.
 */
export interface FixtureTronWrap {
  readonly trx: object;
  readonly fullNode: {
    readonly host: string;
    request(url: string, payload: unknown, method: 'get' | 'post'): Promise<unknown>;
  };
}

export interface HandleFixture {
  readonly slot: ChainHandleSlot;
  readonly host: string;
  /**
   * The same handle, typed as the fixture's own shape.
   *
   * `slot.tronWrap` is `TronWrapHandle` — `{ trx: object }` — and
   * deliberately does not declare `fullNode`: that narrowness is the
   * raw-handle boundary's first defence. So a test that needs to drive the
   * handle's client *directly*, which the credential-reachability rule's
   * non-vacuity case does, reaches it here rather than casting.
   */
  readonly raw: FixtureTronWrap;
  /** Live view of everything that went through the handle's own client. */
  readonly requests: readonly RecordedHandleRequest[];
}

export interface HandleFixtureOptions {
  /** `HttpProvider.host` — the axios `baseURL`. */
  readonly host?: string;
  /**
   * Instance headers. `TRON-PRO-API-KEY` is the documented way to configure a
   * TronGrid key, which is precisely why the credential-reachability rule is
   * keyed to an origin check rather than to today's measurement that no
   * credential travels.
   */
  readonly headers?: Readonly<Record<string, string>>;
  readonly auth?: { readonly username: string; readonly password: string };
  /**
   * The user's configured timeout. The chain layer must neither lengthen
   * nor shorten it.
   */
  readonly timeout?: number;
  readonly table?: RpcTable;
  /** Answer for the native-API refinement probe's GET of `wallet/getnowblock`. */
  readonly nativeApi?: RpcAnswer;
}

export const SENTINEL_API_KEY_HEADER = 'tron-pro-api-key';
export const SENTINEL_API_KEY = 'sentinel-api-key-do-not-leak';
export const SENTINEL_BASIC_USER = 'alice';
export const SENTINEL_BASIC_PASSWORD = 's3cr3t';
export const DEFAULT_HANDLE_TIMEOUT = 41_000;

/**
 * A chain handle whose `fullNode.request` behaves the way TronWeb's
 * `HttpProvider` actually does.
 *
 * `HttpProvider`'s constructor is
 * `axios.create({ baseURL, timeout, headers, auth: user ? {username, password} : undefined })`.
 * Two consequences are reproduced here because the credential-reachability
 * rule turns on both:
 *
 * - a **relative** url resolves against `baseURL`;
 * - an **absolute** url does **not**, and yet the instance's `headers` and `auth`
 *   are still applied. That is the leak — the cheapest way to deliver an override
 *   is to hand the absolute URL to this function, and it would carry whatever
 *   credential the instance holds to a host named in an environment variable.
 */
export function createHandleFixture(
  options: HandleFixtureOptions = {},
): HandleFixture {
  const host = options.host ?? 'http://node.internal:8090';
  const headers: Readonly<Record<string, string>> = options.headers ?? {};
  const auth = options.auth;
  const timeout = options.timeout ?? DEFAULT_HANDLE_TIMEOUT;
  const table = options.table ?? defaultRpcTable;
  const requests: RecordedHandleRequest[] = [];

  const tronWrap: FixtureTronWrap = {
    trx: {},
    fullNode: {
      host,
      request: async (
        url: string,
        payload: unknown,
        httpMethod: 'get' | 'post',
      ): Promise<unknown> => {
        const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
        requests.push({
          url,
          resolvedUrl: absolute
            ? url
            : `${host.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`,
          httpMethod,
          payload,
          headers,
          auth,
          timeout,
        });
        if (httpMethod === 'get') {
          const native = options.nativeApi ?? { result: {} };
          if ('reject' in native) {
            throw native.reject;
          }
          if ('body' in native) {
            return native.body;
          }
          if ('error' in native) {
            return native.error;
          }
          return native.result;
        }
        return answer(table, payload);
      },
    },
  };

  return { slot: { tronWrap }, raw: tronWrap, host, requests };
}

/**
 * A handle whose `fullNode.request` carries both credential channels — the header
 * a TronGrid key is configured through and HTTP Basic auth.
 */
export function createCredentialBearingHandle(
  options: HandleFixtureOptions = {},
): HandleFixture {
  return createHandleFixture({
    ...options,
    headers: {
      [SENTINEL_API_KEY_HEADER]: SENTINEL_API_KEY,
      ...(options.headers ?? {}),
    },
    auth: options.auth ?? {
      username: SENTINEL_BASIC_USER,
      password: SENTINEL_BASIC_PASSWORD,
    },
  });
}

/** A handle whose `fullNode` is missing entirely. */
export function createHandleWithoutFullNode(): ChainHandleSlot {
  const tronWrap: { readonly trx: object } = { trx: {} };
  return { tronWrap };
}

/**
 * A handle whose `fullNode.host` getter raises — the environment seam's
 * `'threw'` state.
 */
export function createHandleWithThrowingHost(): ChainHandleSlot {
  const fullNode = {
    get host(): string {
      throw new Error('host getter raised');
    },
    request: async (): Promise<unknown> => ({}),
  };
  const tronWrap: { readonly trx: object; readonly fullNode: object } = {
    trx: {},
    fullNode,
  };
  return { tronWrap };
}

// ---------------------------------------------------------------------------
// fetch — the different-origin transport
// ---------------------------------------------------------------------------

export interface RecordedFetch {
  readonly url: string;
  readonly httpMethod: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FetchFixture {
  readonly impl: (
    url: string,
    init: {
      readonly method: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    },
  ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  readonly calls: readonly RecordedFetch[];
  /** Every header name any recorded call carried, lowercased and sorted. */
  readonly headerNames: () => readonly string[];
}

/**
 * A `fetch` that records the outbound request and answers from a table.
 *
 * `status` is settable so a `http-status` transport failure has a driver.
 */
export function createFetchFixture(
  table: RpcTable = defaultRpcTable,
  status = 200,
): FetchFixture {
  const calls: RecordedFetch[] = [];
  return {
    calls,
    headerNames: (): readonly string[] =>
      [
        ...new Set(
          calls.flatMap(call => Object.keys(call.headers).map(name => name.toLowerCase())),
        ),
      ].sort(),
    impl: async (url, init) => {
      calls.push({
        url,
        httpMethod: init.method,
        headers: init.headers,
        body: init.body,
      });
      const payload: unknown = JSON.parse(init.body);
      const text =
        status >= 200 && status < 300
          ? JSON.stringify(answer(table, payload))
          : '<html>error</html>';
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async (): Promise<string> => text,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Small conveniences
// ---------------------------------------------------------------------------

/**
 * A bare `{ send }` — the reader contract's subject: every reader must work
 * with only this.
 */
export function bareProvider(table: RpcTable): {
  send(method: string, params: readonly unknown[]): Promise<unknown>;
  readonly calls: readonly RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    send: async (method: string, params: readonly unknown[]): Promise<unknown> => {
      calls.push({ method, params, id: calls.length + 1 });
      const body = answer(table, { jsonrpc: '2.0', id: calls.length, method, params });
      if (typeof body !== 'object' || body === null) {
        throw new Error('fixture bareProvider requires an envelope answer');
      }
      const record: Record<string, unknown> = { ...body };
      if (record['error'] !== undefined) {
        throw new Error(`node error: ${JSON.stringify(record['error'])}`);
      }
      return record['result'];
    },
  };
}

/** A 32-byte storage word holding one address, in the layout java-tron returns. */
export function slotWordFor(address: string): string {
  const bare = address.replace(/^0x/, '').toLowerCase();
  return `0x${'0'.repeat(64 - bare.length)}${bare}`;
}

/**
 * Mainnet's real block-0 and block-1 hashes, measured live — the fixture for
 * the hash-prefix-collision check.
 */
export const mainnetGenesisHash =
  '0x00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc';
export const mainnetFirstBlockHash =
  '0x00000000000000010ff5414c5cfbe9eae982e8cef7eb2399a39118e1206c8247';
