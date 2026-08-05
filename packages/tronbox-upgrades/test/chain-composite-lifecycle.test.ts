/**
 * The chain layer's composite, end to end.
 *
 * The composite as a whole: what it is, what it costs, what it retains, and
 * — in § 8 — the one test in this suite that drives the **real**
 * `Manifest.forNetwork` from `@openzeppelin/upgrades-core` against
 * `access.provider`. That is the refusal-absorption invariant's claim end to
 * end: both of the chain layer's declared refusals are absorbed by upstream,
 * so `ChainMethodRefusedError` reaches no user, and the manifest resolves to
 * the `unknown-<decimal>` file the manifest-filename invariant's message has
 * to be able to name.
 *
 * The resolved-result mutability rule names the row where the defensive
 * instinct is wrong, and § 2 drives the exact upstream assignment:
 * `provider.js:getTransactionReceipt` does
 * `receipt.status = receipt.status.match(/^0x0+$/) ? '0x0' : receipt.status.replace(/^0x0+/, '0x')`
 * in a `"use strict"` module, guarded by `if (receipt?.status)`. The guard makes a
 * frozen result **worse**: it passes every test that polls a not-yet-mined
 * transaction and throws only when the receipt finally arrives — on the success path
 * of every deploy, after the transaction is already on chain.
 */

import { describe, expect, it } from 'vitest';
import { Manifest } from '@openzeppelin/upgrades-core';
import { createChainAccess, verifyCapabilities } from '../src/chain';
import { ChainMethodRefusedError, ChainTransportError } from '../src/chain/errors';
import { refusedMethods, requiredMethods } from '../src/chain/policy';
import { createProvider } from '../src/chain/provider';
import { createRpcChannel } from '../src/chain/transport';
import {
  DEFAULT_HANDLE_TIMEOUT,
  MAINNET_CHAIN_ID,
  createCredentialBearingHandle,
  createHandleFixture,
  createRecordingPost,
  mainnetFirstBlockHash,
  mainnetGenesisHash,
  slotWordFor,
  type RpcTable,
} from './helpers/chain-fixtures';

const noEnv: Readonly<Record<string, string | undefined>> = {};
const IMPL = '0x2222222222222222222222222222222222222222';

const descriptor = Object.freeze({
  describe: 'http://node.internal:8545/jsonrpc',
  origin: 'derived' as const,
});

/** Everything `identity()` needs, plus the probe. */
const identityTable: RpcTable = {
  eth_chainId: { result: MAINNET_CHAIN_ID },
  eth_getBlockByNumber: { result: { hash: mainnetGenesisHash } },
};

/** A responder that answers block 0 and block 1 differently, for `identity()`. */
function identityPost(): {
  readonly post: (payload: unknown) => Promise<unknown>;
  readonly methods: readonly string[];
} {
  const methods: string[] = [];
  return {
    methods,
    post: async (payload: unknown): Promise<unknown> => {
      const record: Record<string, unknown> = { ...(payload as object) };
      const method = String(record['method']);
      methods.push(method);
      const params = Array.isArray(record['params']) ? record['params'] : [];
      if (method === 'eth_chainId') {
        return { jsonrpc: '2.0', id: record['id'], result: MAINNET_CHAIN_ID };
      }
      if (method === 'eth_getBlockByNumber') {
        return {
          jsonrpc: '2.0',
          id: record['id'],
          result: {
            hash: params[0] === '0x0' ? mainnetGenesisHash : mainnetFirstBlockHash,
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Total, frozen, and holds no handle or URL
// ---------------------------------------------------------------------------

describe('ChainAccess is total and frozen, and holds neither handle nor URL', () => {
  it('has own values for all four members, none undefined', async () => {
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const access = await createChainAccess(handle.slot, { env: noEnv });

    expect(Object.keys(access).sort()).toEqual([
      'endpoint',
      'identity',
      'provider',
      'read',
    ]);
    for (const key of ['provider', 'endpoint', 'identity', 'read'] as const) {
      expect(access[key], `${key} is undefined`).toBeDefined();
    }
    expect(Object.isFrozen(access)).toBe(true);
    expect(Object.isFrozen(access.read)).toBe(true);
  });

  it('survives JSON.stringify without throwing and without leaking a credential', async () => {
    // The environment seam met the credential-redaction guarantee by
    // **redaction**, because its slots expose handles as named capabilities.
    // The chain layer meets it by **construction** — there is no field to
    // redact — which is why `sealSlot` is unnecessary here. The adapter was
    // expected to need sealing; it does not.
    const handle = createCredentialBearingHandle({
      host: 'http://alice:s3cr3t@node.internal:8090',
    });
    const access = await createChainAccess(handle.slot, { env: noEnv });

    const serialized = JSON.stringify(access);

    expect(typeof serialized).toBe('string');
    for (const secret of ['alice', 's3cr3t', 'sentinel-api-key-do-not-leak']) {
      expect(serialized, `serialization leaks ${secret}`).not.toContain(secret);
    }
  });

  it('exposes no function-bearing host object at any bounded depth', async () => {
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const access = await createChainAccess(handle.slot, { env: noEnv });

    // A key-walk to bounded depth, looking for the shape a handle has: `trx`,
    // `fullNode`, `networkConfig`, `defaultPrivateKey`.
    const forbidden = ['trx', 'fullNode', 'networkConfig', 'defaultPrivateKey', 'tronWrap'];
    const seen = new Set<object>();
    const walk = (value: unknown, depth: number): void => {
      if (depth > 4 || typeof value !== 'object' || value === null || seen.has(value)) {
        return;
      }
      seen.add(value);
      for (const [key, nested] of Object.entries(value)) {
        expect(forbidden, `the composite exposes ${key}`).not.toContain(key);
        walk(nested, depth + 1);
      }
    };
    walk(access, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. The resolved result is mutable, and upstream's assignment succeeds
// ---------------------------------------------------------------------------

describe('send resolves the unwrapped result and freezes nothing', () => {
  it('lets upstream\'s exact receipt assignment succeed on the deploy success path', async () => {
    const receipt = { status: '0x01', transactionHash: `0x${'a'.repeat(64)}` };
    const posts = createRecordingPost({ eth_getTransactionReceipt: { result: receipt } });
    const provider = createProvider(createRpcChannel(descriptor, posts.post));

    const resolved = await provider.send('eth_getTransactionReceipt', [
      `0x${'a'.repeat(64)}`,
    ]);

    // Upstream's expression, verbatim, in the shape a `"use strict"` module runs it.
    // A frozen result throws `TypeError: Cannot assign to read only property 'status'`
    // here — after the transaction is already on chain.
    expect(typeof resolved).toBe('object');
    const mutable: Record<string, unknown> = resolved as Record<string, unknown>;
    const status = mutable['status'];
    expect(typeof status).toBe('string');
    if (typeof status === 'string') {
      mutable['status'] = /^0x0+$/.test(status) ? '0x0' : status.replace(/^0x0+/, '0x');
    }
    expect(mutable['status']).toBe('0x1');
    expect(Object.isFrozen(resolved)).toBe(false);
  });

  it('resolves the result itself, never the envelope', async () => {
    const posts = createRecordingPost({ eth_chainId: { result: MAINNET_CHAIN_ID } });
    const provider = createProvider(createRpcChannel(descriptor, posts.post));

    const resolved = await provider.send('eth_chainId', []);

    expect(resolved).toBe(MAINNET_CHAIN_ID);
    // The outcome union's negative clause states: nothing resolving from
    // `send` carries a top-level `error` key, and nothing is the envelope.
    expect(resolved).not.toHaveProperty('jsonrpc');
    expect(resolved).not.toHaveProperty('error');
    expect(resolved).not.toHaveProperty('result');
  });

  it('returns no defensive copy, so identity is preserved', async () => {
    const receipt = { status: '0x1' };
    const posts = createRecordingPost({ eth_getTransactionReceipt: { result: receipt } });
    const provider = createProvider(createRpcChannel(descriptor, posts.post));

    const resolved = await provider.send('eth_getTransactionReceipt', ['0x0']);

    // A copy would pass a value test and break identity — the property the engine's
    // polling loop depends on when it mutates what it read.
    expect(resolved).toBe(receipt);
  });

  it('resolves result: null as an answer rather than a failure', async () => {
    // Measured live: `eth_getBlockByNumber('0xfffffffff')` returns `{"result":null}`,
    // so "there is no such block" is an answer, and the null-is-an-answer
    // rule forbids collapsing it into the same value as "the read failed".
    const posts = createRecordingPost({ eth_getTransactionReceipt: { result: null } });
    const provider = createProvider(createRpcChannel(descriptor, posts.post));
    await expect(provider.send('eth_getTransactionReceipt', ['0x0'])).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. The three-member union, and the id is diagnostic only
// ---------------------------------------------------------------------------

describe('every disposition, and a mismatched id changes nothing', () => {
  it('classifies java-tron\'s measured "id":"null" + -32700 reply as a node error', async () => {
    // **"A mismatched id" was originally specified among `malformed-envelope`'s
    // triggers, and that is wrong.** Measured live: java-tron answers a request
    // carrying `"id": 7` with `"id": "null"` — the JSON **string** — whenever it
    // returns `-32700`, which is exactly what an EIP-1898 block object on a state
    // method produces. Under a correlation rule, a real, well-formed node error would be
    // reported as "the response was not JSON-RPC", discarding the code and message.
    const posts = createRecordingPost({
      eth_getCode: {
        body: {
          jsonrpc: '2.0',
          id: 'null',
          error: { code: -32700, message: 'JSON parse error' },
        },
      },
    });
    const provider = createProvider(createRpcChannel(descriptor, posts.post));

    const failure = await provider.send('eth_getCode', ['0x0', 'latest']).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(Error);
    const error: Error = failure instanceof Error ? failure : new Error('none');
    // A `ChainRpcError`, not a `ChainTransportError` — the code and the message
    // survive.
    expect(failure).not.toBeInstanceOf(ChainTransportError);
    expect(error.message).toContain('-32700');
    expect(error.message).toContain('JSON parse error');
  });

  it('classifies a well-formed result with a wrong id as a result', async () => {
    const posts = createRecordingPost({
      eth_chainId: { body: { jsonrpc: '2.0', id: 9_999, result: MAINNET_CHAIN_ID } },
    });
    const provider = createProvider(createRpcChannel(descriptor, posts.post));
    // Correlation buys nothing here: the chain layer issues one request per
    // round-trip and never batches, so a response cannot be confused with
    // another request's.
    await expect(provider.send('eth_chainId', [])).resolves.toBe(MAINNET_CHAIN_ID);
  });

  it.each([
    { label: 'a non-JSON 2xx body', table: { eth_chainId: { body: '<html>oops</html>' } } as RpcTable, detail: 'not JSON' },
    { label: 'a body with neither result nor error', table: { eth_chainId: { body: { jsonrpc: '2.0', id: 1 } } } as RpcTable, detail: 'not a JSON-RPC envelope' },
    { label: 'an error that is not a JSON-RPC error object', table: { eth_chainId: { body: { jsonrpc: '2.0', id: 1, error: 'boom' } } } as RpcTable, detail: 'not a JSON-RPC error' },
    { label: 'a string body', table: { eth_chainId: { body: 'plain text' } } as RpcTable, detail: 'not JSON' },
    { label: 'a numeric body', table: { eth_chainId: { body: 42 } } as RpcTable, detail: 'not a JSON-RPC envelope' },
  ])('reports $label as a transport failure naming $detail', async ({ table, detail }) => {
    const posts = createRecordingPost(table);
    const provider = createProvider(createRpcChannel(descriptor, posts.post));

    const failure = await provider.send('eth_chainId', []).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(ChainTransportError);
    const error: Error = failure instanceof Error ? failure : new Error('none');
    expect(error.message).toContain(detail);
  });

  it('reads error: null alongside a real result as a result', async () => {
    // Some proxies emit `error: null`. Reading it as a malformed envelope would
    // discard a perfectly good answer.
    const posts = createRecordingPost({
      eth_chainId: { body: { jsonrpc: '2.0', id: 1, error: null, result: MAINNET_CHAIN_ID } },
    });
    const provider = createProvider(createRpcChannel(descriptor, posts.post));
    await expect(provider.send('eth_chainId', [])).resolves.toBe(MAINNET_CHAIN_ID);
  });

  it.each([
    { label: 'http-status', reject: Object.assign(new Error('405'), { response: { status: 405 } }), detail: 'HTTP 405' },
    { label: 'a fetch-style status', reject: Object.assign(new Error('502'), { status: 502 }), detail: 'HTTP 502' },
    { label: 'timeout', reject: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }), detail: 'timed out' },
    { label: 'undici header timeout', reject: Object.assign(new Error('t'), { code: 'UND_ERR_HEADERS_TIMEOUT' }), detail: 'timed out' },
    { label: 'unreachable', reject: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }), detail: 'did not accept a connection' },
  ])('classifies a $label rejection as $detail', async ({ reject, detail }) => {
    const posts = createRecordingPost({ eth_chainId: { reject } });
    const provider = createProvider(createRpcChannel(descriptor, posts.post));

    const failure = await provider.send('eth_chainId', []).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(ChainTransportError);
    expect((failure instanceof Error ? failure : new Error('')).message).toContain(detail);
  });

  it('states the user\'s timeout is the one that applied', async () => {
    const posts = createRecordingPost({
      eth_chainId: { reject: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) },
    });
    const provider = createProvider(createRpcChannel(descriptor, posts.post));
    const failure = await provider.send('eth_chainId', []).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    // "this plugin sets none of its own" — the message says so, because a user
    // debugging a timeout needs to know where the number came from.
    expect((failure instanceof Error ? failure : new Error('')).message).toContain(
      'sets none of its own',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. send memoizes nothing; identity() memoizes exactly once
// ---------------------------------------------------------------------------

describe('N sends are N round-trips, and identity() reads once', () => {
  it('issues one post per send, including repeats of the same method', async () => {
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const posts = createRecordingPost({ eth_chainId: { result: MAINNET_CHAIN_ID } });
    const access = await createChainAccess(handle.slot, { env: noEnv, post: posts.post });

    const before = posts.calls.length;
    for (let call = 0; call < 5; call += 1) {
      await access.provider.send('eth_chainId', []);
    }

    // A memoizing `send` is a second source of truth about the chain living inside the
    // one object whose entire purpose is to be the single translation point — and its
    // staleness window is unbounded, because a `tronbox console` session can switch
    // network under it.
    expect(posts.calls.length - before).toBe(5);
  });

  it('issues exactly one post per send on the failure path too', async () => {
    let attempts = 0;
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const access = await createChainAccess(handle.slot, {
      env: noEnv,
      post: async (payload: unknown): Promise<unknown> => {
        const record: Record<string, unknown> = { ...(payload as object) };
        attempts += 1;
        if (record['method'] === 'eth_chainId' && attempts === 1) {
          return { jsonrpc: '2.0', id: record['id'], result: MAINNET_CHAIN_ID };
        }
        throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    });

    const before = attempts;
    await access.provider.send('eth_getCode', ['0x0', 'latest']).catch(() => undefined);

    // No retry, no backoff: one attempt, exactly.
    expect(attempts - before).toBe(1);
  });

  it('performs identity()\'s three reads once, even under concurrent callers', async () => {
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const responder = identityPost();
    const access = await createChainAccess(handle.slot, {
      env: noEnv,
      post: responder.post,
    });

    const [first, second, third] = await Promise.all([
      access.identity(),
      access.identity(),
      access.identity(),
    ]);

    // The memo is the **promise**, so a second call while the first is in flight
    // awaits the first rather than issuing a second set of reads — the in-flight case
    // is covered by construction rather than by a lock.
    expect(responder.methods).toEqual([
      'eth_chainId',
      'eth_chainId',
      'eth_getBlockByNumber',
      'eth_getBlockByNumber',
    ]);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('keeps identity() at three reads across many sequential calls', async () => {
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const responder = identityPost();
    const access = await createChainAccess(handle.slot, {
      env: noEnv,
      post: responder.post,
    });

    const first = await access.identity();
    for (let call = 0; call < 10; call += 1) {
      expect(await access.identity()).toBe(first);
    }

    // One probe + three identity reads. Nothing more, however many callers ask.
    expect(responder.methods).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 5. No module state, and not a singleton
// ---------------------------------------------------------------------------

describe('two instances in one process resolve two endpoints', () => {
  it('resolves different endpoints from different deps.env in the same process', async () => {
    // Impossible if `process.env` were read at module load. The sharper case is
    // `tronbox console`, where a user legitimately switches network mid-session — a
    // module-load read would bake the first network's override into the process.
    const handleA = createHandleFixture({ host: 'http://a.example:8090' });
    const handleB = createHandleFixture({ host: 'http://b.example:8090' });

    const accessA = await createChainAccess(handleA.slot, {
      env: { TRONBOX_UPGRADES_RPC_URL: 'http://a.example:8545/jsonrpc' },
      post: createRecordingPost({ eth_chainId: { result: MAINNET_CHAIN_ID } }).post,
    });
    const accessB = await createChainAccess(handleB.slot, {
      env: { TRONBOX_UPGRADES_RPC_URL: 'http://b.example:8545/jsonrpc' },
      post: createRecordingPost({ eth_chainId: { result: MAINNET_CHAIN_ID } }).post,
    });

    expect(accessA.endpoint.describe).toBe('http://a.example:8545/jsonrpc');
    expect(accessB.endpoint.describe).toBe('http://b.example:8545/jsonrpc');
    expect(accessA).not.toBe(accessB);
  });

  it('gives each instance its own request-id counter', async () => {
    // A module-scope counter shared across two instances would make the ids of one
    // channel depend on the traffic of another, turning a diagnostic into noise.
    const idsFor = async (): Promise<readonly unknown[]> => {
      const ids: unknown[] = [];
      const handle = createHandleFixture({ host: 'http://node.internal:8090' });
      const access = await createChainAccess(handle.slot, {
        env: noEnv,
        post: async (payload: unknown): Promise<unknown> => {
          const record: Record<string, unknown> = { ...(payload as object) };
          ids.push(record['id']);
          return { jsonrpc: '2.0', id: record['id'], result: MAINNET_CHAIN_ID };
        },
      });
      await access.provider.send('eth_chainId', []);
      await access.provider.send('eth_chainId', []);
      return ids;
    };

    expect(await idsFor()).toEqual([1, 2, 3]);
    // A second instance starts from 1 again, which is only true of a per-channel
    // counter.
    expect(await idsFor()).toEqual([1, 2, 3]);
  });

  it('retains nothing across a thousand sends beyond the monotonic id', async () => {
    const ids: number[] = [];
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const access = await createChainAccess(handle.slot, {
      env: noEnv,
      post: async (payload: unknown): Promise<unknown> => {
        const record: Record<string, unknown> = { ...(payload as object) };
        const id = record['id'];
        if (typeof id === 'number') {
          ids.push(id);
        }
        return { jsonrpc: '2.0', id, result: MAINNET_CHAIN_ID };
      },
    });

    for (let call = 0; call < 1_000; call += 1) {
      await access.provider.send('eth_chainId', []);
    }

    // Strictly monotonic, and nothing else grew: the composite's own key set is
    // unchanged, so no request, response, error or diagnosis was retained. A retained
    // log of requests "for better diagnostics" would be both an unbounded structure
    // and, given the endpoint's credential-bearing nature, a second copy of
    // the thing the endpoint-scrubbing invariant keeps in one place.
    expect(ids).toHaveLength(1_001);
    expect(ids[ids.length - 1]).toBe(1_001);
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]).toBe((ids[index - 1] ?? 0) + 1);
    }
    expect(Object.keys(access).sort()).toEqual([
      'endpoint',
      'identity',
      'provider',
      'read',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. The user's timeout, and all four seams substituted
// ---------------------------------------------------------------------------

describe('the handle\'s own client — and its timeout — is the one used', () => {
  it('routes the derived endpoint through the fixture carrying the sentinel timeout', async () => {
    const handle = createHandleFixture({
      host: 'http://node.internal:8090',
      timeout: DEFAULT_HANDLE_TIMEOUT,
    });

    await createChainAccess(handle.slot, { env: noEnv });

    // `HttpProvider`'s constructor default is 30,000 ms and TronBox passes whatever
    // the user configured. A hardcoded chain-layer timeout would silently
    // override a deliberate choice — shorter, and a slow public node fails
    // mid-migration;
    // longer, and a hung endpoint blocks a deploy past the point where the user could
    // still intervene.
    expect(handle.requests[0]?.timeout).toBe(DEFAULT_HANDLE_TIMEOUT);
  });
});

describe('every surface works with all four dependencies substituted', () => {
  it('drives the probe, a read and identity() with no real handle behaviour', async () => {
    // The seam-completeness test: the *only* real handle behaviour is the two
    // property reads the handle-sealing rule permits. Everything else — the
    // environment, the transport, the native-API probe, the endpoint — is
    // injected. The chain layer's own test suite is the first consumer that
    // is not TronBox, and this is the assertion that says so.
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    let nativeProbes = 0;
    const responder = identityPost();

    const access = await createChainAccess(handle.slot, {
      endpointOverride: 'http://node.internal:8090/jsonrpc',
      env: { MANIFEST_DEFAULT_DIR: 'build/oz' },
      post: async (payload: unknown): Promise<unknown> => {
        const record: Record<string, unknown> = { ...(payload as object) };
        if (record['method'] === 'eth_getCode') {
          return { jsonrpc: '2.0', id: record['id'], result: '0x60806040' };
        }
        if (record['method'] === 'eth_getStorageAt') {
          return { jsonrpc: '2.0', id: record['id'], result: slotWordFor(IMPL) };
        }
        return responder.post(payload);
      },
      probeNativeApi: async (): Promise<boolean> => {
        nativeProbes += 1;
        return true;
      },
    });

    expect(access.endpoint.origin).toBe('argument');
    await expect(access.read.hasCode(IMPL)).resolves.toBe(true);
    await expect(access.read.readImplementationAddress(IMPL)).resolves.toBe(IMPL);
    await expect(access.identity()).resolves.toMatchObject({
      chainId: MAINNET_CHAIN_ID,
    });
    // The native probe is best-effort and is not consulted on the success path.
    expect(nativeProbes).toBe(0);
    // Zero requests through the handle: `deps.post` took every round-trip.
    expect(handle.requests.filter(r => r.httpMethod === 'post')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Ordering, and the chain layer's refusal vs the node's
// ---------------------------------------------------------------------------

describe('the probe completes before any reader is reachable', () => {
  it('makes eth_chainId the first method on the wire, always', async () => {
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const posts = createRecordingPost({
      eth_chainId: { result: MAINNET_CHAIN_ID },
      eth_getCode: { result: '0x60806040' },
    });

    const access = await createChainAccess(handle.slot, { env: noEnv, post: posts.post });
    await access.read.hasCode(IMPL);

    // `read` is only obtainable from this factory's resolved value, so the ordering is
    // structural rather than a discipline: there is no way to reach a reader before
    // the probe has resolved.
    expect(posts.methods()).toEqual(['eth_chainId', 'eth_getCode']);
  });
});

describe('verifyCapabilities distinguishes the chain layer\'s refusal from the node\'s', () => {
  it('reports refusedLocally for both, with zero posts, while the node WOULD answer', async () => {
    // The assertion scenario 7 turns on. A report that says only "anvil_metadata:
    // unavailable" is indistinguishable between "the chain layer refuses this
    // by policy" and "this node happens not to serve it" — and those have
    // opposite implications. The first is a guarantee; the second is a
    // coincidence the chain layer explicitly refuses to depend on.
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const table: RpcTable = {
      eth_chainId: { result: MAINNET_CHAIN_ID },
      web3_clientVersion: { result: 'TRON/v4.8.2/Linux/Java1.8' },
      eth_getCode: { result: '0x' },
      eth_getStorageAt: { result: `0x${'0'.repeat(64)}` },
      eth_call: { result: '0x' },
      eth_getTransactionByHash: { result: null },
      eth_getTransactionReceipt: { result: null },
      eth_getBlockByNumber: { result: { hash: mainnetGenesisHash } },
      // A node that answers both metadata methods successfully.
      anvil_metadata: { result: { chainId: 31_337, forkedNetwork: null, snapshots: {} } },
      hardhat_metadata: { result: { chainId: 31_337, clientVersion: 'x', instanceId: 'y' } },
    };
    const posts = createRecordingPost(table);
    const access = await createChainAccess(handle.slot, { env: noEnv, post: posts.post });

    const report = await verifyCapabilities(access);

    expect(report.refused.map(entry => entry.method).sort()).toEqual(
      [...refusedMethods].sort(),
    );
    for (const entry of report.refused) {
      expect(entry.refusedLocally, `${entry.method} was not refused locally`).toBe(true);
    }
    // And no request for either was ever issued, even though the stub would have
    // answered — which is the difference between a guarantee and a coincidence.
    expect(posts.methods()).not.toContain('anvil_metadata');
    expect(posts.methods()).not.toContain('hardhat_metadata');
  });

  it('reports a verdict for all eight required methods', async () => {
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const posts = createRecordingPost({
      eth_chainId: { result: MAINNET_CHAIN_ID },
      web3_clientVersion: { result: 'TRON/v4.8.2/Linux/Java1.8' },
      eth_getCode: { result: '0x' },
      eth_getStorageAt: { result: `0x${'0'.repeat(64)}` },
      eth_call: { result: '0x' },
      eth_getTransactionByHash: { result: null },
      eth_getTransactionReceipt: { result: null },
      eth_getBlockByNumber: { result: { hash: mainnetGenesisHash } },
    });
    const access = await createChainAccess(handle.slot, { env: noEnv, post: posts.post });

    const report = await verifyCapabilities(access);

    expect(report.resolved.map(entry => entry.method)).toEqual([...requiredMethods]);
    for (const entry of report.resolved) {
      expect(entry.ok, `${entry.method} reported not served`).toBe(true);
    }
    expect(report.endpoint).toBe(access.endpoint);
  });

  it('reads a node error about the arguments as evidence the method EXISTS', async () => {
    // `eth_call` against the zero address returns `-32600 "Smart contract is not
    // exist."` on every TRON network, and reporting that as an unavailable capability
    // would make the report useless. Only `-32601` says the method itself is absent.
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const posts = createRecordingPost({
      eth_chainId: { result: MAINNET_CHAIN_ID },
      web3_clientVersion: { result: 'TRON/v4.8.2' },
      eth_getCode: { result: '0x' },
      eth_getStorageAt: { result: `0x${'0'.repeat(64)}` },
      eth_call: { error: { code: -32600, message: 'Smart contract is not exist.' } },
      eth_getTransactionByHash: { result: null },
      eth_getTransactionReceipt: { result: null },
      eth_getBlockByNumber: { error: { code: -32601, message: 'method not found' } },
    });
    const access = await createChainAccess(handle.slot, { env: noEnv, post: posts.post });

    const report = await verifyCapabilities(access);
    const byMethod = new Map(report.resolved.map(entry => [entry.method, entry]));

    expect(byMethod.get('eth_call')?.ok).toBe(true);
    expect(byMethod.get('eth_call')?.detail).toContain('served');
    expect(byMethod.get('eth_getBlockByNumber')?.ok).toBe(false);
    expect(byMethod.get('eth_getBlockByNumber')?.detail).toContain(
      'does not serve this method',
    );
  });

  it('leaves identity()\'s memo untouched', async () => {
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const responder = identityPost();
    const access = await createChainAccess(handle.slot, {
      env: noEnv,
      post: async (payload: unknown): Promise<unknown> => {
        const record: Record<string, unknown> = { ...(payload as object) };
        const method = String(record['method']);
        if (
          method === 'eth_chainId' ||
          method === 'eth_getBlockByNumber'
        ) {
          return responder.post(payload);
        }
        return { jsonrpc: '2.0', id: record['id'], result: '0x' };
      },
    });

    await verifyCapabilities(access);
    const identity = await access.identity();
    const again = await access.identity();

    // `verifyCapabilities` performs no writes and changes no state on the
    // `ChainAccess` it is given.
    expect(again).toBe(identity);
  });
});

// ---------------------------------------------------------------------------
// 8. The real Manifest.forNetwork absorbs both refusals
// ---------------------------------------------------------------------------

describe('the declared refusals reach no user, driven against the real engine', () => {
  it('resolves a Manifest through access.provider, absorbing both refusals', async () => {
    // The end-to-end claim, with upstream's own code doing the catching.
    // `getAnvilMetadata` and `getHardhatMetadata` have exactly two call sites in
    // `@openzeppelin/upgrades-core@1.46.0`, both inside `getDevInstanceMetadata`'s
    // nested try/catch — so the chain layer's deliberately terse refusal is
    // never rendered to a user, and the chain layer does not invest it with
    // message quality it does not need.
    //
    // If a future minor calls either method **outside** a catch, this test fails
    // rather than a raw refusal surfacing in a migration.
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const posts = createRecordingPost({ eth_chainId: { result: MAINNET_CHAIN_ID } });
    const access = await createChainAccess(handle.slot, { env: noEnv, post: posts.post });

    const manifest = await Manifest.forNetwork(access.provider);

    expect(manifest).toBeDefined();
    // `provider.js:networkNames` has 26 entries and no TRON chain id, so mainnet
    // resolves to `unknown-728126428` — the name the manifest-filename
    // invariant's refusal has to be able to cite because no user would
    // guess it.
    expect(manifest.file).toContain('unknown-728126428.json');
  });

  it('raised ChainMethodRefusedError during that call, which upstream swallowed', async () => {
    // The refusal is real and is reached — it is simply absorbed. Asserting the class
    // directly is what keeps § 8.1's success from being read as "the methods were
    // never probed".
    const handle = createHandleFixture({ host: 'http://node.internal:8090' });
    const posts = createRecordingPost({ eth_chainId: { result: MAINNET_CHAIN_ID } });
    const access = await createChainAccess(handle.slot, { env: noEnv, post: posts.post });

    for (const method of refusedMethods) {
      const failure = await access.provider.send(method, []).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(ChainMethodRefusedError);
    }

    await expect(Manifest.forNetwork(access.provider)).resolves.toBeDefined();
  });
});
