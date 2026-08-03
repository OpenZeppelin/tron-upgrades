/**
 * SF-1 — INV-43 (Critical), with INV-41's half that depends on it.
 *
 * **The highest-stakes row in the sub-feature**, and the only one whose violation
 * sends a secret to a third party rather than merely producing a wrong answer.
 *
 * The mechanism is a property of axios, not of SF-1: `HttpProvider`'s constructor is
 * `axios.create({ baseURL, timeout, headers, auth: user ? {username, password} : undefined })`,
 * and an axios instance applies its `headers` and `auth` to an **absolute** request
 * URL while ignoring `baseURL`. So the cheapest way to deliver an endpoint override —
 * hand the absolute URL to the handle's own `fullNode.request`, which also preserves
 * the user's timeout — would send whatever credential the instance carries to a host
 * the user named in an environment variable.
 *
 * *Today* nothing travels: TronBox constructs TronWeb positionally as
 * `new TronWebProxy(fullNode, solidityNode, eventServer, privateKey)` and passes no
 * `headers`, no `user` and no `password` (verified at `tronbox` `v4.9.0`). But
 * `headers` is precisely the parameter a TronGrid `TRON-PRO-API-KEY` is configured
 * through, so a rule keyed to that measurement expires silently at the next minor.
 * INV-43 is keyed to SF-1's own origin comparison instead, and **both halves are
 * probed here** — the different-origin case for the refusal to lend the client, and
 * the same-origin case because a rule that simply never used the handle would break
 * INV-41 instead.
 *
 * Non-vacuity is § 4: the fixture is shown to *detect* the leak when the leaking
 * implementation is performed against it. Without that case, the assertions above
 * would pass against a fixture incapable of recording a credential at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChainAccess } from '../src/chain';
import { ChainEndpointRefusedError } from '../src/chain/errors';
import {
  DEFAULT_HANDLE_TIMEOUT,
  MAINNET_CHAIN_ID,
  SENTINEL_API_KEY,
  SENTINEL_API_KEY_HEADER,
  SENTINEL_BASIC_PASSWORD,
  SENTINEL_BASIC_USER,
  createCredentialBearingHandle,
  createFetchFixture,
  defaultRpcTable,
} from './helpers/sf-1-chain';

const HANDLE_HOST = 'http://node.internal:8090';
const SAME_ORIGIN_OVERRIDE = 'http://node.internal:8090/some/other/rpc';
const DIFFERENT_ORIGIN_OVERRIDE = 'http://someone-elses-node.example:8545/jsonrpc';

/** No `deps.env` key set, so the override precedence under test is the argument's. */
const noEnv: Readonly<Record<string, string | undefined>> = {};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. The derived endpoint: inheriting the handle's client is correct
// ---------------------------------------------------------------------------

describe('INV-43 / INV-41: the derived endpoint goes through the handle\'s own client', () => {
  it('sends through fullNode.request, carrying the user\'s timeout and the instance credential', async () => {
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });

    const access = await createChainAccess(handle.slot, { env: noEnv });

    expect(access.endpoint.origin).toBe('derived');
    // Inheriting here is not a tolerated leak — it is the same origin the user
    // configured, and it is what preserves INV-41's timeout.
    expect(handle.requests).toHaveLength(1);
    const [request] = handle.requests;
    expect(request?.timeout).toBe(DEFAULT_HANDLE_TIMEOUT);
    expect(request?.headers[SENTINEL_API_KEY_HEADER]).toBe(SENTINEL_API_KEY);
    expect(request?.auth?.username).toBe(SENTINEL_BASIC_USER);
  });

  it('addresses the derived endpoint relatively, so INV-36\'s url claim is the same measurement', async () => {
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });

    await createChainAccess(handle.slot, { env: noEnv });

    // A *relative* url is what lets axios resolve against `baseURL` — and it is
    // also exactly the string INV-36 needs, since `jsonrpc` is not in
    // `_getConsoleLog`'s three-path allow-list.
    expect(handle.requests[0]?.url).toBe('jsonrpc');
    expect(handle.requests[0]?.resolvedUrl).toBe(`${HANDLE_HOST}/jsonrpc`);
    expect(handle.requests[0]?.httpMethod).toBe('post');
  });
});

// ---------------------------------------------------------------------------
// 2. A same-origin override still inherits — INV-43's second half
// ---------------------------------------------------------------------------

describe('INV-43: a same-origin override still uses the handle, so the timeout survives', () => {
  it('routes an override with the handle\'s own origin through fullNode.request', async () => {
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });

    const access = await createChainAccess(handle.slot, {
      env: noEnv,
      endpointOverride: SAME_ORIGIN_OVERRIDE,
    });

    expect(access.endpoint.origin).toBe('argument');
    expect(handle.requests).toHaveLength(1);
    // The absolute form is passed, which is precisely the axios behaviour INV-43
    // is about — permitted here because the origin *is* the handle's own.
    expect(handle.requests[0]?.url).toBe(SAME_ORIGIN_OVERRIDE);
    expect(handle.requests[0]?.timeout).toBe(DEFAULT_HANDLE_TIMEOUT);
  });

  it('treats a differing path as the same origin and a differing port as a different one', async () => {
    const differentPort = 'http://node.internal:9999/jsonrpc';
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });
    const fetchFixture = createFetchFixture();
    vi.stubGlobal('fetch', fetchFixture.impl);

    await createChainAccess(handle.slot, {
      env: noEnv,
      endpointOverride: differentPort,
    });

    // Origin is scheme + host + **port**. A port change is a different node.
    expect(handle.requests).toHaveLength(0);
    expect(fetchFixture.calls).toHaveLength(1);
  });

  it('treats a differing scheme as a different origin', async () => {
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });
    const fetchFixture = createFetchFixture();
    vi.stubGlobal('fetch', fetchFixture.impl);

    await createChainAccess(handle.slot, {
      env: noEnv,
      endpointOverride: 'https://node.internal:8090/jsonrpc',
    });

    expect(handle.requests).toHaveLength(0);
    expect(fetchFixture.calls).toHaveLength(1);
  });

  it('treats a handle host that does not parse as a different origin — the safe direction', async () => {
    // The rule's purpose is to keep the handle's credentials off a host SF-1
    // cannot *prove* is the handle's own, so an unparseable host must fail closed.
    const handle = createCredentialBearingHandle({ host: 'not-a-url-at-all' });
    const fetchFixture = createFetchFixture();
    vi.stubGlobal('fetch', fetchFixture.impl);

    await createChainAccess(handle.slot, {
      env: noEnv,
      endpointOverride: DIFFERENT_ORIGIN_OVERRIDE,
    });

    expect(handle.requests).toHaveLength(0);
    expect(fetchFixture.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. A different-origin override carries nothing SF-1 did not construct
// ---------------------------------------------------------------------------

describe('INV-43: a different-origin override never touches the handle', () => {
  it('issues zero requests through the handle and exactly one through fetch', async () => {
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });
    const fetchFixture = createFetchFixture();
    vi.stubGlobal('fetch', fetchFixture.impl);

    const access = await createChainAccess(handle.slot, {
      env: noEnv,
      endpointOverride: DIFFERENT_ORIGIN_OVERRIDE,
    });

    expect(access.endpoint.origin).toBe('argument');
    // The strongest single assertion in the file: the handle's client is not
    // merely stripped of its credentials, it is not used at all.
    expect(handle.requests).toEqual([]);
    expect(fetchFixture.calls).toHaveLength(1);
    expect(fetchFixture.calls[0]?.url).toBe(DIFFERENT_ORIGIN_OVERRIDE);
  });

  it('sends exactly one header, and it is the one SF-1 constructed', async () => {
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });
    const fetchFixture = createFetchFixture();
    vi.stubGlobal('fetch', fetchFixture.impl);

    await createChainAccess(handle.slot, {
      env: noEnv,
      endpointOverride: DIFFERENT_ORIGIN_OVERRIDE,
    });

    // An allow-list, not a deny-list: asserting the sentinel is absent would pass
    // for a build that leaked a *differently named* credential. The set of headers
    // is pinned instead, so any addition fails.
    expect(fetchFixture.headerNames()).toEqual(['content-type']);
    expect(fetchFixture.calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('leaks no credential material into the outbound body or url', async () => {
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });
    const fetchFixture = createFetchFixture();
    vi.stubGlobal('fetch', fetchFixture.impl);

    await createChainAccess(handle.slot, {
      env: noEnv,
      endpointOverride: DIFFERENT_ORIGIN_OVERRIDE,
    });

    const serialized = JSON.stringify(fetchFixture.calls);
    for (const secret of [
      SENTINEL_API_KEY,
      SENTINEL_API_KEY_HEADER,
      SENTINEL_BASIC_USER,
      SENTINEL_BASIC_PASSWORD,
    ]) {
      expect(serialized, `the outbound request mentions ${secret}`).not.toContain(
        secret,
      );
    }
  });

  it('carries the same JSON-RPC payload as the same-origin transport, so only the credential differs', async () => {
    const acrossOrigins = createCredentialBearingHandle({ host: HANDLE_HOST });
    const fetchFixture = createFetchFixture();
    vi.stubGlobal('fetch', fetchFixture.impl);
    await createChainAccess(acrossOrigins.slot, {
      env: noEnv,
      endpointOverride: DIFFERENT_ORIGIN_OVERRIDE,
    });

    vi.unstubAllGlobals();
    const sameOrigin = createCredentialBearingHandle({ host: HANDLE_HOST });
    await createChainAccess(sameOrigin.slot, { env: noEnv });

    // INV-43 changes the transport, not the request. If the different-origin path
    // also altered the payload, a caller could not reason about the two the same
    // way — and the divergence would be invisible to every other test here.
    const across: unknown = JSON.parse(fetchFixture.calls[0]?.body ?? 'null');
    expect(across).toEqual(sameOrigin.requests[0]?.payload);
  });

  it('answers correctly through fetch, so the safe transport is a working one', async () => {
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });
    const fetchFixture = createFetchFixture(defaultRpcTable);
    vi.stubGlobal('fetch', fetchFixture.impl);

    const access = await createChainAccess(handle.slot, {
      env: noEnv,
      endpointOverride: DIFFERENT_ORIGIN_OVERRIDE,
    });

    // A refusal that also broke the endpoint would satisfy every assertion above
    // while making the override unusable, so the round-trip is checked end to end.
    await expect(access.provider.send('eth_chainId', [])).resolves.toBe(
      MAINNET_CHAIN_ID,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. NON-VACUITY: the fixture detects the leak when the leak is performed
// ---------------------------------------------------------------------------

describe('INV-43 non-vacuity: the leaking implementation is shown to leak', () => {
  it('records the credential when the absolute override is handed to the handle', async () => {
    // This *is* the forbidden implementation, executed directly against the
    // fixture: hand the absolute different-origin URL to `fullNode.request`. It is
    // the cheapest delivery mechanism and the one that preserves the timeout, which
    // is exactly why INV-43 has to be stated. If this case did not record the
    // secret, every assertion in § 3 would be vacuous.
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });
    // `handle.raw` is the deliberate, typed accessor for the forbidden shape.
    // `handle.slot.tronWrap` is SF-0's `TronWrapHandle` — `{ trx: object }` — which
    // does not surface `fullNode`, and that narrowness is INV-30's first defence. A
    // cast here would make the strongest test in the sub-feature depend on the type
    // system being told to look away, so reaching the shape is explicit instead.
    await handle.raw.fullNode.request(
      DIFFERENT_ORIGIN_OVERRIDE,
      { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
      'post',
    );

    expect(handle.requests).toHaveLength(1);
    // axios ignores `baseURL` for an absolute url — and still applies the headers.
    expect(handle.requests[0]?.resolvedUrl).toBe(DIFFERENT_ORIGIN_OVERRIDE);
    expect(handle.requests[0]?.headers[SENTINEL_API_KEY_HEADER]).toBe(
      SENTINEL_API_KEY,
    );
    expect(handle.requests[0]?.auth).toEqual({
      username: SENTINEL_BASIC_USER,
      password: SENTINEL_BASIC_PASSWORD,
    });
    expect(JSON.stringify(handle.requests)).toContain(SENTINEL_API_KEY);
  });
});

// ---------------------------------------------------------------------------
// 5. No fetch: refuse, never fall back
// ---------------------------------------------------------------------------

describe('INV-43 / INV-46: with no global fetch, a different-origin override is refused', () => {
  it('refuses with ChainEndpointRefusedError naming deps.post as the remedy', async () => {
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });
    vi.stubGlobal('fetch', undefined);

    const failure = await createChainAccess(handle.slot, {
      env: noEnv,
      endpointOverride: DIFFERENT_ORIGIN_OVERRIDE,
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(ChainEndpointRefusedError);
    expect(failure).toBeInstanceOf(Error);
    const error: Error = failure instanceof Error ? failure : new Error('none');
    // The remedy has to be actionable, and `deps.post` is the seam that makes it so.
    expect(error.message).toContain('post');
    expect(error.message).toContain('fetch');
    // It must name *which* source supplied the endpoint (INV-9's origin, rendered).
    expect(error.message).toContain('endpointOverride');
  });

  it('does not fall back to the handle\'s client — zero requests through it', async () => {
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });
    vi.stubGlobal('fetch', undefined);

    await createChainAccess(handle.slot, {
      env: noEnv,
      endpointOverride: DIFFERENT_ORIGIN_OVERRIDE,
    }).catch(() => undefined);

    // The ratified reading of INV-46 is explicit that this fallback "IS the leak
    // INV-43 exists to prevent". A refusal that still issued the probe through the
    // handle would have leaked before it refused.
    expect(handle.requests).toEqual([]);
  });

  it('still accepts an explicit deps.post, which is what makes the refusal a remedy and not a wall', async () => {
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });
    vi.stubGlobal('fetch', undefined);
    const calls: unknown[] = [];

    const access = await createChainAccess(handle.slot, {
      env: noEnv,
      endpointOverride: DIFFERENT_ORIGIN_OVERRIDE,
      post: async (payload: unknown): Promise<unknown> => {
        calls.push(payload);
        return { jsonrpc: '2.0', id: 1, result: MAINNET_CHAIN_ID };
      },
    });

    expect(access.endpoint.origin).toBe('argument');
    expect(calls).toHaveLength(1);
    expect(handle.requests).toEqual([]);
  });

  it('does not refuse a same-origin override when fetch is absent', async () => {
    // The refusal is scoped to the case that would leak. A build that refused
    // whenever `fetch` was missing would break every same-origin override on an
    // older runtime for no safety gain.
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });
    vi.stubGlobal('fetch', undefined);

    const access = await createChainAccess(handle.slot, {
      env: noEnv,
      endpointOverride: SAME_ORIGIN_OVERRIDE,
    });

    expect(access.endpoint.origin).toBe('argument');
    expect(handle.requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. The environment-variable source takes the same path
// ---------------------------------------------------------------------------

describe('INV-43: the rule is keyed to origin, not to which source named it', () => {
  it('applies the different-origin transport to TRONBOX_UPGRADES_RPC_URL too', async () => {
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });
    const fetchFixture = createFetchFixture();
    vi.stubGlobal('fetch', fetchFixture.impl);

    const access = await createChainAccess(handle.slot, {
      env: { TRONBOX_UPGRADES_RPC_URL: DIFFERENT_ORIGIN_OVERRIDE },
    });

    expect(access.endpoint.origin).toBe('environment');
    expect(handle.requests).toEqual([]);
    expect(fetchFixture.headerNames()).toEqual(['content-type']);
  });

  it('names the environment variable in the refusal when fetch is absent', async () => {
    const handle = createCredentialBearingHandle({ host: HANDLE_HOST });
    vi.stubGlobal('fetch', undefined);

    const failure = await createChainAccess(handle.slot, {
      env: { TRONBOX_UPGRADES_RPC_URL: DIFFERENT_ORIGIN_OVERRIDE },
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(ChainEndpointRefusedError);
    const error: Error = failure instanceof Error ? failure : new Error('none');
    // Sending the user to the wrong configuration is INV-9's failure mode.
    expect(error.message).toContain('TRONBOX_UPGRADES_RPC_URL');
    expect(error.message).not.toContain('endpointOverride');
  });
});
