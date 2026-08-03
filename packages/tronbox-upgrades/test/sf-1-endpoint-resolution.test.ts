/**
 * SF-1 — INV-9, INV-27, INV-29, INV-30, INV-31, INV-32, INV-36, INV-42.
 *
 * Everything the endpoint can be, and everything it must be refused for. Two rows
 * carry most of the weight:
 *
 * **INV-30 — the `/tre` refusal.** `tronWrap.send(method, params)` satisfies
 * `EthereumProvider` *structurally*, while `tronWrap.send` POSTs to
 * `this.networkConfig.fullNode + '/tre'` with `default: return _send()` — verified
 * at `tronbox` `v4.9.0`, `src/components/TronWrap/index.js:475`. So
 * `Manifest.forNetwork(env.chain.tronWrap)` type-checks *and runs*, and on a public
 * network returns HTTP 405 with an HTML body which the host rewrites into
 * `TRE RPC 'eth_chainId': Request failed with status code 405` — an error naming the
 * wrong capability. On a TRE the path exists, so the failure becomes
 * environment-dependent: it works on the developer's machine and fails in CI. The
 * path refusal is the fourth and last defence, and the only one that catches an
 * override copy-pasted from the host's cheatcode documentation.
 *
 * **INV-42 — the scrubber.** The credential chain of custody is verified rather
 * than assumed: `filterNetworkConfig` is `fullNode: options.fullNode || options.fullHost`
 * with **no normalization** (`v4.9.0`, verbatim), `tronweb`'s
 * `isValidURL('http://u:p@node:8545')` returns **true** (executed), and
 * `HttpProvider` strips only trailing slashes. So userinfo and query-string API keys
 * reach `fullNode.host` untouched.
 */

import { describe, expect, it } from 'vitest';
import { EnvironmentIncompleteError } from '../src/environment';
import { ChainEndpointRefusedError } from '../src/chain/errors';
import {
  DERIVED_RPC_PATH,
  RPC_URL_ENV_VAR,
  resolveEndpoint,
  scrubEndpoint,
} from '../src/chain/endpoint';
import { createChainAccess } from '../src/chain';
import {
  MAINNET_CHAIN_ID,
  createHandleFixture,
  createHandleWithThrowingHost,
  createHandleWithoutFullNode,
  createRecordingPost,
} from './helpers/sf-1-chain';

const noEnv: Readonly<Record<string, string | undefined>> = {};

/** Resolve against a fixture handle, returning the descriptor only. */
function resolveWith(
  host: string,
  override?: string,
  env: Readonly<Record<string, string | undefined>> = noEnv,
): { readonly describe: string; readonly origin: string } {
  const handle = createHandleFixture({ host });
  const resolved = resolveEndpoint(handle.slot, override, env);
  return resolved.descriptor;
}

function refusalFrom(
  host: string,
  override?: string,
  env: Readonly<Record<string, string | undefined>> = noEnv,
): Error {
  try {
    const handle = createHandleFixture({ host });
    resolveEndpoint(handle.slot, override, env);
    return new Error('no refusal was raised');
  } catch (cause) {
    return cause instanceof Error ? cause : new Error('a non-Error was thrown');
  }
}

// ---------------------------------------------------------------------------
// 1. INV-30 — /tre is refused at resolution
// ---------------------------------------------------------------------------

describe('INV-30: the host\'s /tre cheatcode path is refused at resolution', () => {
  it.each([
    { label: 'an override that is exactly /tre', host: 'http://127.0.0.1:8090', override: 'http://127.0.0.1:9090/tre' },
    { label: 'an override with a trailing slash after /tre', host: 'http://127.0.0.1:8090', override: 'http://127.0.0.1:9090/tre/' },
    { label: 'an override with /tre deeper in the path', host: 'http://127.0.0.1:8090', override: 'http://node.internal:8545/api/tre' },
  ])('refuses $label', ({ host, override }) => {
    const failure = refusalFrom(host, override);

    expect(failure).toBeInstanceOf(ChainEndpointRefusedError);
    // Naming the cheatcode path is the point: the user copied it from somewhere,
    // and the message has to tell them what they copied.
    expect(failure.message).toContain('/tre');
    expect(failure.message).toContain('cheatcode');
    // And it must name the failure's environment-dependence, which is what makes
    // the mistake survive local testing.
    expect(failure.message).toContain('405');
    expect(failure.message).toContain(`/${DERIVED_RPC_PATH}`);
  });

  it('cannot produce a /tre derived endpoint, because jsonrpc is always appended', () => {
    // A first draft of this suite expected a `fullHost` of `…/tre` to be refused.
    // It is not, and the code is right: the derived endpoint is
    // `${host}/jsonrpc`, so a `fullHost` ending in `/tre` yields `/tre/jsonrpc`,
    // which neither *is* nor *ends in* `/tre` — INV-30's exact words. The trap the
    // invariant describes is an **override** copied from the cheatcode
    // documentation, and appending the JSON-RPC path to a host is not that trap.
    // Recorded as a case rather than deleted, so the next reader does not re-derive
    // the same wrong expectation.
    const descriptor = resolveWith('http://127.0.0.1:9090/tre');
    expect(descriptor.origin).toBe('derived');
    expect(descriptor.describe).toBe(`http://127.0.0.1:9090/tre/${DERIVED_RPC_PATH}`);
    expect(descriptor.describe.endsWith('/tre')).toBe(false);
  });

  it('does not refuse a path that merely contains the letters tre', () => {
    // Non-vacuity in the other direction: an over-broad `includes('tre')` would
    // refuse a legitimate endpoint. `/metrics`, `/tre-nodes/jsonrpc` and a host
    // named `tre.example` are all fine.
    for (const override of [
      'http://node.internal:8545/metrics',
      'http://node.internal:8545/tre-nodes/jsonrpc',
      'http://tre.example:8545/jsonrpc',
      'http://node.internal:8545/tremendous',
    ]) {
      expect(
        resolveWith('http://node.internal:8090', override).origin,
        `${override} was refused`,
      ).toBe('argument');
    }
  });

  it('refuses before any request is issued', async () => {
    // The refusal is structural, so it must not cost a round-trip — and must not
    // reach the node whose path is wrong.
    const handle = createHandleFixture({ host: 'http://127.0.0.1:8090' });
    await createChainAccess(handle.slot, {
      env: noEnv,
      endpointOverride: 'http://127.0.0.1:9090/tre',
    }).catch(() => undefined);

    expect(handle.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. INV-31 — http and https only
// ---------------------------------------------------------------------------

describe('INV-31: the resolved endpoint must be http or https', () => {
  it.each([
    { label: 'ws://', override: 'ws://node.internal:8545/jsonrpc', names: 'ws:' },
    { label: 'wss://', override: 'wss://node.internal:8545/jsonrpc', names: 'wss:' },
    { label: 'file://', override: 'file:///tmp/rpc.sock', names: 'file:' },
    { label: 'ipc://', override: 'ipc://var/run/tron.ipc', names: 'ipc:' },
  ])('refuses $label, naming the scheme', ({ override, names }) => {
    const failure = refusalFrom('http://node.internal:8090', override);
    expect(failure).toBeInstanceOf(ChainEndpointRefusedError);
    // Naming the scheme is what keeps the diagnosis at the right layer: a `ws://`
    // override otherwise reaches axios and fails with an adapter-level message
    // about an unsupported protocol, naming axios rather than the configuration.
    expect(failure.message).toContain(names);
  });

  it.each([
    { label: 'an empty string', override: '' },
    { label: 'a relative path', override: '/jsonrpc' },
    { label: 'a bare hostname', override: 'node.internal' },
  ])('refuses $label as not an absolute URL', ({ override }) => {
    const failure = refusalFrom('http://node.internal:8090', override);
    expect(failure).toBeInstanceOf(ChainEndpointRefusedError);
    expect(failure.message).toContain('absolute URL');
    // The remedy is an example, because "not absolute" is not actionable alone.
    expect(failure.message).toContain('http://');
  });

  it('refuses host:port with no scheme as a *scheme* fault, which is the truer diagnosis', () => {
    // Measured while writing this suite: `new URL('node.internal:8545')` **parses**,
    // with `protocol === 'node.internal:'`. So this input never reaches the
    // absolute-URL branch, and the message names the accidental scheme rather than
    // claiming the URL is relative. That is the better diagnosis — a user who wrote
    // `node.internal:8545` is being told what their text actually means — and it is
    // asserted here because the intuitive expectation is the other branch.
    const failure = refusalFrom('http://node.internal:8090', 'node.internal:8545');
    expect(failure).toBeInstanceOf(ChainEndpointRefusedError);
    expect(failure.message).toContain('node.internal:');
    expect(failure.message).toContain('only http and https');
  });

  it('accepts http and https', () => {
    expect(resolveWith('http://node.internal:8090', 'http://a.example:8545/jsonrpc').describe).toBe(
      'http://a.example:8545/jsonrpc',
    );
    expect(resolveWith('http://node.internal:8090', 'https://a.example/jsonrpc').describe).toBe(
      'https://a.example/jsonrpc',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. INV-27 — one source, no fallback
// ---------------------------------------------------------------------------

describe('INV-27: precedence is fixed, resolved once, with no fallback between sources', () => {
  it('prefers the argument over the environment variable and the derived path', () => {
    const descriptor = resolveWith(
      'http://derived.example:8090',
      'http://argument.example:8545/jsonrpc',
      { [RPC_URL_ENV_VAR]: 'http://environment.example:8545/jsonrpc' },
    );
    expect(descriptor.origin).toBe('argument');
    expect(descriptor.describe).toBe('http://argument.example:8545/jsonrpc');
  });

  it('prefers the environment variable over the derived path', () => {
    const descriptor = resolveWith('http://derived.example:8090', undefined, {
      [RPC_URL_ENV_VAR]: 'http://environment.example:8545/jsonrpc',
    });
    expect(descriptor.origin).toBe('environment');
    expect(descriptor.describe).toBe('http://environment.example:8545/jsonrpc');
  });

  it('derives from fullNode.host when neither override is present', () => {
    const descriptor = resolveWith('http://derived.example:8090');
    expect(descriptor.origin).toBe('derived');
    expect(descriptor.describe).toBe(`http://derived.example:8090/${DERIVED_RPC_PATH}`);
  });

  it('strips trailing slashes off the handle host rather than doubling them', () => {
    expect(resolveWith('http://derived.example:8090///').describe).toBe(
      `http://derived.example:8090/${DERIVED_RPC_PATH}`,
    );
  });

  it('refuses an empty environment variable rather than falling through', () => {
    // Code Draft's decided default, and INV-27's rule at the *source* level: only
    // `undefined` counts as absent. A user who sets the variable and typos it must
    // be told, not silently served from the derived endpoint of a node that happens
    // to answer. That is the sibling's defect in SF-1's clothes: a blanket catch plus
    // a hardcoded fallback, which reads slots from a local dev chain on a transient
    // failure.
    const failure = refusalFrom('http://derived.example:8090', undefined, {
      [RPC_URL_ENV_VAR]: '',
    });
    expect(failure).toBeInstanceOf(ChainEndpointRefusedError);
    expect(failure.message).toContain(RPC_URL_ENV_VAR);
  });

  it('refuses an empty override argument rather than falling through', () => {
    const failure = refusalFrom('http://derived.example:8090', '');
    expect(failure).toBeInstanceOf(ChainEndpointRefusedError);
    expect(failure.message).toContain('endpointOverride');
  });

  it('attempts exactly one distinct URL when every request fails', async () => {
    // The fallback specimen, driven. The sibling's `getSlot` reroutes on a blanket
    // catch to `hre.network.config.url ?? process.env.TRE_URL ??
    // 'http://127.0.0.1:9090/jsonrpc'`, so on a public network a *transient*
    // failure reads ERC-1967 slots from a local dev chain. The result is not an
    // error; it is a confident answer about the wrong chain.
    const attempted: string[] = [];
    const handle = createHandleFixture({ host: 'http://derived.example:8090' });

    await createChainAccess(handle.slot, {
      env: noEnv,
      post: async (): Promise<unknown> => {
        attempted.push('post');
        throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    }).catch(() => undefined);

    // One probe, one attempt, no second URL and no retry (INV-39).
    expect(attempted).toHaveLength(1);
    // No JSON-RPC round-trip went through the handle — the injected `post` took it.
    // The handle *does* see one GET, and it is INV-32's best-effort native-API
    // refinement probe of `wallet/getnowblock`, which exists only to choose between
    // two wordings of the failure message. Filtering by method rather than asserting
    // an empty array is what keeps this case about the fallback and not about the
    // refinement probe.
    expect(handle.requests.filter(request => request.httpMethod === 'post')).toEqual(
      [],
    );
    const nativeProbes = handle.requests.filter(
      request => request.httpMethod === 'get',
    );
    expect(nativeProbes).toHaveLength(1);
    expect(nativeProbes[0]?.url).toBe('wallet/getnowblock');
  });

  it('names the source that supplied the endpoint, so the user checks the right place', () => {
    // An inferred origin would report "derived" for an override and send the user
    // to the wrong configuration (INV-9).
    expect(refusalFrom('http://d.example:8090', 'ws://x.example').message).toContain(
      'endpointOverride',
    );
    expect(
      refusalFrom('http://d.example:8090', undefined, { [RPC_URL_ENV_VAR]: 'ws://x.example' })
        .message,
    ).toContain(RPC_URL_ENV_VAR);
    // The derived source, reached through a scheme fault on the handle's own host —
    // since a `/tre` `fullHost` is not refused (see § 1) there is no other way to
    // make the derived endpoint fail structurally.
    expect(refusalFrom('ws://d.example:8090').message).toContain('fullHost');
  });
});

// ---------------------------------------------------------------------------
// 4. INV-9 / INV-42 — the descriptor has two fields and both are scrubbed
// ---------------------------------------------------------------------------

const CREDENTIAL_URL =
  'http://alice:s3cr3t@node.internal:8545/jsonrpc?apikey=AKIA#frag';

describe('INV-9 / INV-42: the descriptor carries no URL and every rendering is scrubbed', () => {
  it('has exactly the two keys describe and origin', () => {
    const descriptor = resolveWith('http://node.internal:8090');
    // A `url` field would be a second place SF-0's INV-40 guarantee can fail,
    // inside the module whose job is to not have one.
    expect(Object.keys(descriptor).sort()).toEqual(['describe', 'origin']);
  });

  it('scrubs userinfo, query and fragment from a credential-bearing endpoint', () => {
    const descriptor = resolveWith('http://node.internal:8090', CREDENTIAL_URL);
    expect(descriptor.describe).toBe('http://node.internal:8545/jsonrpc');
    for (const secret of ['alice', 's3cr3t', 'AKIA', '?', '#']) {
      expect(descriptor.describe, `describe contains ${secret}`).not.toContain(secret);
    }
  });

  it('scrubs a credential-bearing *derived* endpoint too', () => {
    // The channel is verified, not assumed: `filterNetworkConfig` performs no
    // normalization, so a `fullHost` carrying userinfo reaches `fullNode.host`.
    const descriptor = resolveWith('http://alice:s3cr3t@node.internal:8090');
    expect(descriptor.describe).toBe(`http://node.internal:8090/${DERIVED_RPC_PATH}`);
    expect(descriptor.describe).not.toContain('alice');
  });

  it('is idempotent — scrubbing its own output re-parses to the same value', () => {
    const once = scrubEndpoint(new URL(CREDENTIAL_URL));
    expect(scrubEndpoint(new URL(once))).toBe(once);
  });

  it('keeps scheme, host, port and path, and drops nothing else', () => {
    expect(scrubEndpoint(new URL('https://node.internal/jsonrpc'))).toBe(
      'https://node.internal/jsonrpc',
    );
    // A root path is dropped rather than rendered as a bare slash.
    expect(scrubEndpoint(new URL('https://node.internal/'))).toBe(
      'https://node.internal',
    );
    expect(scrubEndpoint(new URL('http://node.internal:8545/a/b/c'))).toBe(
      'http://node.internal:8545/a/b/c',
    );
  });

  it('never leaks the raw URL through JSON.stringify of the whole access object', async () => {
    // INV-3's half that this file can drive cheaply: the composite holds the URL in
    // a closure, so serializing it cannot reveal it and does not throw.
    const handle = createHandleFixture({ host: 'http://alice:s3cr3t@node.internal:8090' });
    const posts = createRecordingPost({ eth_chainId: { result: MAINNET_CHAIN_ID } });

    const access = await createChainAccess(handle.slot, { env: noEnv, post: posts.post });
    const serialized = JSON.stringify(access);

    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('s3cr3t');
    expect(serialized).toContain('node.internal');
  });

  it('keeps the raw URL out of every refusal message', () => {
    // The refusal names the **source** and the structural fault, never the URL —
    // which is what lets it be rendered anywhere without a redaction step.
    const failure = refusalFrom('http://node.internal:8090', 'ws://alice:s3cr3t@x.example:1/p?k=AKIA');
    expect(failure.message).not.toContain('alice');
    expect(failure.message).not.toContain('s3cr3t');
    expect(failure.message).not.toContain('AKIA');
    expect(failure.message).toContain('ws:');
  });
});

// ---------------------------------------------------------------------------
// 5. INV-29 — one module, exactly two property paths
// ---------------------------------------------------------------------------

/** Records every property access on the handle and its `fullNode`. */
function recordingHandle(host: string): {
  readonly slot: { readonly tronWrap: { readonly trx: object } };
  readonly reads: readonly string[];
} {
  const reads: string[] = [];
  const fullNodeTarget = {
    host,
    request: async (): Promise<unknown> => ({
      jsonrpc: '2.0',
      id: 1,
      result: MAINNET_CHAIN_ID,
    }),
  };
  const fullNode = new Proxy(fullNodeTarget, {
    get(target, key, receiver): unknown {
      if (typeof key === 'string') {
        reads.push(`fullNode.${key}`);
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const tronWrapTarget = { trx: {}, fullNode };
  const tronWrap = new Proxy(tronWrapTarget, {
    get(target, key, receiver): unknown {
      if (typeof key === 'string') {
        reads.push(key);
      }
      return Reflect.get(target, key, receiver);
    },
  });
  return { slot: { tronWrap }, reads };
}

describe('INV-29: exactly one module reads the handle, along exactly two paths', () => {
  it('reads only fullNode, fullNode.host and fullNode.request across a full resolution', () => {
    const handle = recordingHandle('http://node.internal:8090');

    resolveEndpoint(handle.slot, undefined, noEnv);

    // Not "does not read networkConfig" — an allow-list, so a *new* read fails too.
    // SF-0 measured that a configured `privateKey` is reachable from the handles it
    // seals, and SF-1 inherits the handle **without** the sealing because its own
    // composite holds no handle in a field. That makes the access discipline the
    // load-bearing half.
    expect([...new Set(handle.reads)].sort()).toEqual([
      'fullNode',
      'fullNode.host',
      'fullNode.request',
    ]);
  });

  it('reads nothing further across a whole createChainAccess', async () => {
    const handle = recordingHandle('http://node.internal:8090');

    const access = await createChainAccess(handle.slot, { env: noEnv });
    await access.provider.send('eth_chainId', []);

    expect([...new Set(handle.reads)].sort()).toEqual([
      'fullNode',
      'fullNode.host',
      'fullNode.request',
    ]);
    for (const forbidden of [
      'networkConfig',
      'send',
      'request',
      'defaultPrivateKey',
      'utils',
      'privateKey',
    ]) {
      expect(handle.reads, `the handle's ${forbidden} was read`).not.toContain(
        forbidden,
      );
    }
  });

  it('preserves the missing/threw distinction SF-0 built its diagnosis around', () => {
    const missing = ((): Error => {
      try {
        resolveEndpoint(createHandleWithoutFullNode(), undefined, noEnv);
        return new Error('no failure');
      } catch (cause) {
        return cause instanceof Error ? cause : new Error('non-error');
      }
    })();
    expect(missing).toBeInstanceOf(EnvironmentIncompleteError);
    expect(missing.message).toContain('tronWrap.fullNode');

    const threw = ((): Error => {
      try {
        resolveEndpoint(createHandleWithThrowingHost(), undefined, noEnv);
        return new Error('no failure');
      } catch (cause) {
        return cause instanceof Error ? cause : new Error('non-error');
      }
    })();
    expect(threw).toBeInstanceOf(EnvironmentIncompleteError);
    // A raising host getter and an absent property are different states, and the
    // rendered message says which. `Config.js`'s `network_config` getter is a real
    // specimen of a host getter that raises.
    expect(threw.message).toContain('threw');
    expect(missing.message).not.toContain('threw');
  });

  it('reports a present-but-wrong-type path as invariant-violated, not as missing', () => {
    // Code Draft's third structural state, pinned. `handle-malformed` renders as
    // "is absent" or "threw when read", and neither is true of a numeric
    // `fullNode.host` — reporting `'missing'` would be the wrong message about the
    // right problem, which is the failure class SF-1 exists to remove.
    const numericHost: { readonly trx: object; readonly fullNode: object } = {
      trx: {},
      fullNode: { host: 8090, request: async (): Promise<unknown> => ({}) },
    };
    const failure = ((): Error => {
      try {
        resolveEndpoint({ tronWrap: numericHost }, undefined, noEnv);
        return new Error('no failure');
      } catch (cause) {
        return cause instanceof Error ? cause : new Error('non-error');
      }
    })();

    expect(failure).toBeInstanceOf(EnvironmentIncompleteError);
    expect(failure.message).toContain('tronWrap.fullNode.host');
    expect(failure.message).toContain('a number');
    expect(failure.message).not.toContain('threw');
  });

  it('reports a non-function fullNode.request as invariant-violated', () => {
    const badRequest: { readonly trx: object; readonly fullNode: object } = {
      trx: {},
      fullNode: { host: 'http://node.internal:8090', request: 'not a function' },
    };
    const failure = ((): Error => {
      try {
        resolveEndpoint({ tronWrap: badRequest }, undefined, noEnv);
        return new Error('no failure');
      } catch (cause) {
        return cause instanceof Error ? cause : new Error('non-error');
      }
    })();
    expect(failure).toBeInstanceOf(EnvironmentIncompleteError);
    expect(failure.message).toContain('tronWrap.fullNode.request');
  });
});

// ---------------------------------------------------------------------------
// 6. INV-32 / INV-18 — one probe, and its wording is the only thing the
//    native-API refinement can change
// ---------------------------------------------------------------------------

describe('INV-32: one capability probe at construction, with no unprobed variant', () => {
  it('rejects before any reader is reachable when eth_chainId fails', async () => {
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });

    const failure = await createChainAccess(handle.slot, {
      env: noEnv,
      post: async (): Promise<unknown> => {
        throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(EnvironmentIncompleteError);
    const error: Error = failure instanceof Error ? failure : new Error('none');
    // Spec scenario 3: name the missing network **capability**, not a generic
    // transport failure, and do it before an operation starts. The condition is
    // ordinary — on a stock java-tron the eth-compat service is gated by
    // `node.jsonrpc.httpFullNodeEnable`, default false, and binds 8545 while the
    // wallet API is on 8090.
    expect(error.message).toContain('node.jsonrpc.httpFullNodeEnable');
    expect(error.message).toContain('8545');
    expect(error.message).toContain('8090');
    expect(error.message).toContain(RPC_URL_ENV_VAR);
  });

  it('carries the scrubbed endpoint and no credential into the capability failure', async () => {
    const handle = createHandleFixture({ host: 'http://alice:s3cr3t@node.internal:8090' });

    const failure = await createChainAccess(handle.slot, {
      env: noEnv,
      post: async (): Promise<unknown> => {
        throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    const error: Error = failure instanceof Error ? failure : new Error('none');
    expect(error.message).toContain('node.internal:8090/jsonrpc');
    expect(error.message).not.toContain('alice');
    expect(error.message).not.toContain('s3cr3t');
  });

  it('disowns the seam\'s appended invocation-context clause (INV-18)', async () => {
    // `renderUnsatisfiedSlot` appends `(provided in tronbox migrate, …; absent in
    // …)` — a statement about which contexts inject the handle, which is true,
    // irrelevant, and actively misdirecting here: the user's context *did* provide
    // the handle; their node did not serve the RPC. The `detail` names the
    // parenthetical and disowns it rather than asking SF-0 to change the renderer.
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const failure = await createChainAccess(handle.slot, {
      env: noEnv,
      post: async (): Promise<unknown> => {
        throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    const error: Error = failure instanceof Error ? failure : new Error('none');

    expect(error.message).toContain('provided in');
    expect(error.message).toContain(
      'the invocation contexts listed at the end of this line are not the cause',
    );
    // The disclaimer must precede the appended context, or it explains nothing.
    const disclaimerAt = error.message.indexOf('not the cause');
    const contextAt = error.message.indexOf('provided in');
    expect(disclaimerAt).toBeLessThan(contextAt);
  });

  it('lets the native-API probe change only the wording, never the diagnosis', async () => {
    const wordings: string[] = [];
    const codes: string[] = [];

    for (const probe of [
      async (): Promise<boolean> => true,
      async (): Promise<boolean> => false,
      async (): Promise<boolean> => {
        throw new Error('the native probe itself failed');
      },
    ]) {
      const handle = createHandleFixture({ host: 'http://node.internal:8090' });
      const failure = await createChainAccess(handle.slot, {
        env: noEnv,
        probeNativeApi: probe,
        post: async (): Promise<unknown> => {
          throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
        },
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(EnvironmentIncompleteError);
      const error = failure instanceof EnvironmentIncompleteError ? failure : undefined;
      codes.push(error?.code ?? 'missing');
      wordings.push(error?.message ?? '');
    }

    // All three outcomes produce the same code and the same diagnosis. This is the
    // **one** deliberate absorption in `src/chain/**`, and it is mandated by INV-32
    // rather than tolerated — safe precisely because the value is consumed by
    // nothing but a wording selector.
    expect(new Set(codes).size).toBe(1);
    // And the wordings do differ for `true` versus `false`, or the probe would be
    // pointless.
    expect(wordings[0]).not.toBe(wordings[1]);
    expect(wordings[0]).toContain('answered on its native wallet API');
    expect(wordings[1]).toContain('answered neither');
    // A throwing probe is indistinguishable from `false`, which is the documented
    // absorption.
    expect(wordings[2]).toBe(wordings[1]);
  });

  it('exports no second constructor and no skip option', async () => {
    const surface: Record<string, unknown> = await import('../src/chain');
    const constructors = Object.keys(surface).filter(name =>
      /^create(Chain|)Access/i.test(name),
    );
    // INV-32: no `createChainAccessUnchecked`, no `skipProbe`, no lazy variant. An
    // escape hatch is worse than no probe, because the diagnosis's main failure
    // mode is a caller who skipped it — and it will be skipped in exactly the
    // harness where the endpoint is least standard.
    expect(constructors).toEqual(['createChainAccess']);
    expect(Object.keys(surface)).not.toContain('createChainAccessUnchecked');
  });
});

// ---------------------------------------------------------------------------
// 7. INV-36 — the request URL never reaches the host's console-log allow-list
// ---------------------------------------------------------------------------

describe('INV-36: the derived request url is exactly jsonrpc', () => {
  it('never sends one of the three native paths the host extracts logs from', async () => {
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });

    const access = await createChainAccess(handle.slot, { env: noEnv });
    await access.provider.send('eth_chainId', []);

    // `src/components/TronWrap/index.js:523-539` at `v4.9.0` wraps
    // `fullNode.request` so every response is handed to
    // `ConsoleLogger.getLogMessages(...)` — but only for these three paths. Had
    // `jsonrpc` been among them, every storage read the plugin performs would emit
    // through the host's logger, and INV-34's "emits nothing" would be false by way
    // of a function SF-1 never calls.
    const consoleLogPaths = [
      'wallet/triggerconstantcontract',
      'walletsolidity/triggerconstantcontract',
      'wallet/broadcasttransaction',
    ];
    for (const request of handle.requests) {
      if (request.httpMethod === 'get') {
        continue;
      }
      expect(request.url).toBe(DERIVED_RPC_PATH);
      expect(consoleLogPaths).not.toContain(request.url);
    }
    expect(handle.requests.filter(r => r.httpMethod === 'post')).not.toHaveLength(0);
  });

  it('pins the allow-list itself, so a host change that adds jsonrpc fails a test', () => {
    // A host-owned list SF-1 has no control over, so the pinned copy is the
    // detector rather than the guarantee.
    expect([
      'wallet/triggerconstantcontract',
      'walletsolidity/triggerconstantcontract',
      'wallet/broadcasttransaction',
    ]).not.toContain(DERIVED_RPC_PATH);
  });
});
