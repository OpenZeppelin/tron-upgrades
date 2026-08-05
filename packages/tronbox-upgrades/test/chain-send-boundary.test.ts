/**
 * The chain layer's `send` boundary: result-shape validation, the method
 * tables, the local metadata refusals, and the block-tag policy.
 *
 * Everything here is decided **before or immediately after** a round-trip, from a
 * table rather than a `switch`, which is what lets these tests read the policy as
 * data instead of restating it. A test can read a table; it can only paraphrase a
 * `switch`, and a paraphrase passes when the thing it paraphrases is emptied.
 *
 * Result-shape validation is the row with the measured harm. `provider.js:getChainId` is
 * `parseInt(await provider.send('eth_chainId', []).replace(/^0x/, ''), 16)` at
 * `@openzeppelin/upgrades-core@1.46.0`, and `parseInt` is not a validator — so § 1
 * reproduces the arithmetic first and asserts the guard second. Reproducing the
 * numbers is not decoration: it is the non-vacuity argument, because it shows the
 * exact inputs a `typeof value === 'string'` guard admits and what the manifest key
 * becomes when it does.
 */

import { describe, expect, it } from 'vitest';
import {
  ChainBlockTagRefusedError,
  ChainMethodRefusedError,
  ChainResultShapeError,
} from '../src/chain/errors';
import {
  acceptedBlockTag,
  blockTagIndex,
  methodPolicies,
  policyFor,
  refusedMethods,
  requiredMethods,
  stringResultMethods,
} from '../src/chain/policy';
import { createProvider, requireResultShape } from '../src/chain/provider';
import { createRpcChannel } from '../src/chain/transport';
import {
  MAINNET_CHAIN_ID,
  createRecordingPost,
  type PostFixture,
  type RpcTable,
} from './helpers/chain-fixtures';

const descriptor = Object.freeze({
  describe: 'http://node.internal:8545/jsonrpc',
  origin: 'derived' as const,
});

/** A provider over a recording transport — the only wiring these tests need. */
function providerOver(table: RpcTable): {
  readonly send: (method: string, params: readonly unknown[]) => Promise<unknown>;
  readonly posts: PostFixture;
} {
  const posts = createRecordingPost(table);
  const provider = createProvider(createRpcChannel(descriptor, posts.post));
  return { send: (method, params) => provider.send(method, params), posts };
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    value => {
      throw new Error(
        `expected a rejection, resolved ${JSON.stringify(value) ?? 'undefined'}`,
      );
    },
    (cause: unknown) => cause,
  );
}

// ---------------------------------------------------------------------------
// 1. result-shape validation — the measured harm, then the guard
// ---------------------------------------------------------------------------

/**
 * The four `eth_chainId` near-misses, each with what upstream's `parseInt` makes
 * of it and the manifest file that follows.
 *
 * `'728126428'` is not a contrived input: it is mainnet's chain id in **decimal**,
 * which is what java-tron itself returns from `net_version` and what a proxy or a
 * shim in front of the endpoint may well return for `eth_chainId`.
 */
const chainIdNearMisses: readonly {
  readonly value: string;
  readonly parsed: number;
  readonly manifest: string;
}[] = [
  { value: '728126428', parsed: 30_737_065_000, manifest: 'unknown-30737065000.json' },
  { value: '0x', parsed: Number.NaN, manifest: 'unknown-NaN.json' },
  { value: '', parsed: Number.NaN, manifest: 'unknown-NaN.json' },
  { value: '0xzz', parsed: Number.NaN, manifest: 'unknown-NaN.json' },
  {
    value: 'TRON/v4.8.2/Linux/Java1.8',
    parsed: Number.NaN,
    manifest: 'unknown-NaN.json',
  },
];

describe('parseInt is not a validator, and the numbers are reproduced', () => {
  it.each(chainIdNearMisses)(
    'upstream getChainId turns $value into $parsed, keying $manifest',
    ({ value, parsed, manifest }) => {
      // Upstream's expression, verbatim: `parseInt(id.replace(/^0x/, ''), 16)`.
      const upstream = Number.parseInt(value.replace(/^0x/, ''), 16);

      if (Number.isNaN(parsed)) {
        expect(upstream).toBeNaN();
      } else {
        expect(upstream).toBe(parsed);
      }
      // `manifest.js` renders `unknown-${chainId}.json`. Both outcomes name a file
      // no later run consults, with no error at any layer.
      expect(`unknown-${String(upstream)}.json`).toBe(manifest);
    },
  );

  it('shows every near-miss passing the typeof guard the shape table replaced', () => {
    // The non-vacuity argument for § 1.2. "A one-line `typeof` guard per method"
    // was the design's first draft; the shape table replaces it. If `typeof` rejected any of
    // these, the guard below would be untestable — there would be nothing for the
    // stronger predicate to catch that the weaker one did not.
    for (const near of chainIdNearMisses) {
      expect(typeof near.value).toBe('string');
    }
  });
});

describe('send refuses a wrong-shaped result, naming the method and what it saw', () => {
  it.each(chainIdNearMisses)(
    'rejects eth_chainId = $value with ChainResultShapeError',
    async ({ value }) => {
      const { send } = providerOver({ eth_chainId: { result: value } });

      const failure = await failureOf(send('eth_chainId', []));

      expect(failure).toBeInstanceOf(ChainResultShapeError);
      const error: Error = failure instanceof Error ? failure : new Error('none');
      expect(error.message).toContain('eth_chainId');
      // The observed value is named, because "the endpoint returned something
      // wrong" without saying what is not a diagnosis a user can act on. The
      // empty string renders as `a string ""` rather than vanishing into the
      // sentence — which is the case a naive interpolation loses.
      expect(error.message).toContain(value === '' ? 'a string ""' : value);
      expect(error.message).toContain('string');
    },
  );

  it('accepts the real mainnet chain id', async () => {
    const { send } = providerOver({ eth_chainId: { result: MAINNET_CHAIN_ID } });
    await expect(send('eth_chainId', [])).resolves.toBe(MAINNET_CHAIN_ID);
  });

  it('refuses 0x0, which is hex and still not a chain id', async () => {
    // The boundary the regex alone does not catch: `'0x0'` matches
    // `/^0x[0-9a-fA-F]{1,64}$/` and parses to a finite `0`. The predicate also
    // requires a positive integer, and `unknown-0.json` would be as wrong a file
    // as `unknown-NaN.json`.
    const { send } = providerOver({ eth_chainId: { result: '0x0' } });
    const failure = await failureOf(send('eth_chainId', []));
    expect(failure).toBeInstanceOf(ChainResultShapeError);
  });

  it.each([
    { value: 42, label: 'a number' },
    { value: null, label: 'null' },
    { value: undefined, label: 'undefined' },
    { value: { chainId: '0x2b6653dc' }, label: 'an object' },
  ])('refuses eth_chainId = $label, since typeof is the floor', async ({ value }) => {
    const { send } = providerOver({ eth_chainId: { result: value } });
    const failure = await failureOf(send('eth_chainId', []));
    expect(failure).toBeInstanceOf(ChainResultShapeError);
  });
});

// ---------------------------------------------------------------------------
// 2. the shape table is five *distinct* predicates, read as data
// ---------------------------------------------------------------------------

describe('stringResultMethods is a table of per-method predicates', () => {
  it('covers exactly the five methods upgrades-core reads unguarded', () => {
    // Pinned as a set, not a count. Each is cited in `policy.ts` against the
    // upstream expression that reads it without a guard, so a method leaving this
    // table is a method whose result reaches a `.replace()` unchecked.
    expect(Object.keys(stringResultMethods).sort()).toEqual([
      'eth_call',
      'eth_chainId',
      'eth_getCode',
      'eth_getStorageAt',
      'web3_clientVersion',
    ]);
  });

  it('is not one shared predicate wearing five names', () => {
    // The assertion that a softened table fails. `'728126428'` is accepted by
    // `web3_clientVersion` (any non-empty string is a legitimate client version)
    // and must be refused by `eth_chainId`. If both delegated to the same
    // `typeof`, this case could not exist — so its existence *is* the measurement
    // that the predicates differ per method.
    expect(stringResultMethods['web3_clientVersion']?.accepts('728126428')).toBe(
      true,
    );
    expect(stringResultMethods['eth_chainId']?.accepts('728126428')).toBe(false);

    // And the inverse direction: `'0x'` is a legitimate `eth_getCode` answer —
    // it is how the node says "no contract here" — while being an unusable
    // `eth_chainId`.
    expect(stringResultMethods['eth_getCode']?.accepts('0x')).toBe(true);
    expect(stringResultMethods['eth_chainId']?.accepts('0x')).toBe(false);

    // `web3_clientVersion` accepts a value the three hex predicates reject, which
    // makes three distinct behaviours visible in one line.
    const clientVersion = 'TRON/v4.8.2/Linux/Java1.8';
    expect(stringResultMethods['web3_clientVersion']?.accepts(clientVersion)).toBe(
      true,
    );
    for (const method of ['eth_getCode', 'eth_getStorageAt', 'eth_call']) {
      expect(
        stringResultMethods[method]?.accepts(clientVersion),
        `${method} accepted a client-version string`,
      ).toBe(false);
    }
  });

  it('rejects an empty string everywhere, including web3_clientVersion', () => {
    // `provider.js:113` is `clientVersion.split('/', 1)`, which does not throw on
    // `''` — it yields `['']`, so the failure is a silently empty node identity
    // rather than an error. The floor is "non-empty".
    for (const method of Object.keys(stringResultMethods)) {
      expect(
        stringResultMethods[method]?.accepts(''),
        `${method} accepted an empty string`,
      ).toBe(false);
    }
  });

  it('names a shape for every method it validates, so the refusal can state it', () => {
    for (const [method, rule] of Object.entries(stringResultMethods)) {
      expect(rule.describe.length, `${method} has no described shape`).toBeGreaterThan(
        0,
      );
    }
  });

  it('refuses a method with no declared shape as a defect here, not a node fact', () => {
    // `requireResultShape` is exported because `read.ts` and `instance.ts` are
    // reachable with a bare `{ send }`. Asking it for a shape the table does
    // not describe is a chain-layer bug, and it says so rather than waving through.
    const failure = (():
      | ChainResultShapeError
      | Error => {
      try {
        requireResultShape('eth_getBlockByNumber', '0x1');
        return new Error('no rejection');
      } catch (cause) {
        return cause instanceof Error ? cause : new Error('non-error');
      }
    })();
    expect(failure).toBeInstanceOf(ChainResultShapeError);
    expect(failure.message).toContain('eth_getBlockByNumber');
  });

  it('leaves the three transaction and block methods unvalidated, deliberately', async () => {
    // Pins the **absence** so a future reader does not mistake it for an
    // oversight. Shape validation is scoped to the five methods
    // upstream reads unguarded; these three it does not, and `asEngineProvider`
    // forwards the node's value for them. Recorded here as a limitation with a
    // test, not only as prose — if a later change starts validating them, this
    // fails and the limitation gets revisited on purpose.
    const unvalidated = [
      'eth_getTransactionByHash',
      'eth_getTransactionReceipt',
      'eth_getBlockByNumber',
    ];
    for (const method of unvalidated) {
      expect(stringResultMethods[method]).toBeUndefined();
    }

    // And the consequence, driven: a structurally absurd result passes through.
    const { send } = providerOver({
      eth_getBlockByNumber: { result: 'not a block at all' },
    });
    await expect(send('eth_getBlockByNumber', ['0x0', false])).resolves.toBe(
      'not a block at all',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. the metadata and endpoint refusals — both local, at zero posts
// ---------------------------------------------------------------------------

describe('the metadata methods are refused locally, before any request', () => {
  it.each([...refusedMethods])('refuses %s with zero recorded posts', async method => {
    // A transport that *would* answer both successfully. That is the whole
    // assertion: if the refusal were forwarded, or moved behind the request, this
    // would resolve and the post count would be one.
    const { send, posts } = providerOver({
      anvil_metadata: { result: { chainId: 31337 } },
      hardhat_metadata: { result: { chainId: 31337 } },
    });

    const failure = await failureOf(send(method, []));

    expect(failure).toBeInstanceOf(ChainMethodRefusedError);
    expect(posts.calls).toEqual([]);
  });

  it('throws rather than resolving an error envelope — the refusal asymmetry', async () => {
    // A positive obligation, not a gap. `manifest.js:getDevInstanceMetadata`
    // distinguishes a dev instance from a persistent one *by catching*, and its
    // `Broken invariant: … chainId undefined does not match eth_chainId 728126428`
    // throw sits **outside both catch blocks**. An adapter that resolved
    // `{jsonrpc, id, error}` here would abort `Manifest.forNetwork` — on the path
    // of every deploy and every upgrade — with a message naming neither TRON nor
    // this plugin. Resolving `null` raises an uncaught `TypeError` at the same
    // place. So both must **reject**, and both are asserted.
    for (const method of refusedMethods) {
      const { send } = providerOver({});
      const outcome = await send(method, []).then(
        value => ({ resolved: true, value }),
        (cause: unknown) => ({ resolved: false, value: cause }),
      );
      expect(outcome.resolved, `${method} resolved instead of throwing`).toBe(false);
      expect(outcome.value).toBeInstanceOf(ChainMethodRefusedError);
    }
  });

  it('reads refusedMethods as data, so emptying the table fails the test', () => {
    // Spec scenario 7 in its own words. The `it.each` above enumerates the table,
    // so an emptied table would run zero cases — which vitest reports as an error
    // rather than as a pass. This pins the arity so the failure is explicit.
    expect(refusedMethods).toHaveLength(2);
    expect([...refusedMethods]).toEqual(['anvil_metadata', 'hardhat_metadata']);
    for (const method of refusedMethods) {
      expect(policyFor(method).kind).toBe('refuse');
      expect(methodPolicies[method]?.kind).toBe('refuse');
    }
  });

  it('names the reason, and the reason is about misreporting rather than support', async () => {
    const { send } = providerOver({});
    const failure = await failureOf(send('anvil_metadata', []));
    const error: Error = failure instanceof Error ? failure : new Error('none');
    // The refusal is a *policy*, not a capability report. A message saying "not
    // supported" would later be cited as evidence that forwarding is safe.
    expect(error.message).toContain('anvil_metadata');
    expect(error.message).toContain('misreport');
  });

  it('forwards everything else, so the refusal is a two-method exception', async () => {
    const { send, posts } = providerOver({
      web3_clientVersion: { result: 'TRON/v4.8.2/Linux/Java1.8' },
    });

    await expect(send('web3_clientVersion', [])).resolves.toContain('TRON');
    expect(policyFor('web3_clientVersion').kind).toBe('forward');
    expect(posts.calls).toHaveLength(1);
  });

  it('refuses before the block-tag check, so an unusable method cannot be masked', async () => {
    // Ordering *within* the two local refusals. A refused method carrying a bad
    // block tag must report the refusal, not the tag — otherwise softening the
    // refusal would be invisible whenever the caller also passed a stale tag.
    const { send, posts } = providerOver({});
    const failure = await failureOf(send('anvil_metadata', ['pending']));
    expect(failure).toBeInstanceOf(ChainMethodRefusedError);
    expect(posts.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. block tags refused uniformly, at zero posts
// ---------------------------------------------------------------------------

const blockTagMethods = ['eth_getStorageAt', 'eth_getCode', 'eth_call'] as const;

/** Params for one method with `tag` at that method's own index. */
function paramsWithTag(method: string, tag: unknown): readonly unknown[] {
  const index = blockTagIndex[method];
  if (index === undefined) {
    throw new Error(`${method} carries no block tag`);
  }
  const params: unknown[] = [];
  for (let position = 0; position < index; position += 1) {
    params.push(position === 0 ? '0x0000000000000000000000000000000000000000' : '0x0');
  }
  params.push(tag);
  return params;
}

describe('unsupported tags are refused uniformly, because the node is not uniform', () => {
  const refusedTags: readonly { readonly label: string; readonly tag: unknown }[] = [
    { label: 'pending', tag: 'pending' },
    { label: 'earliest', tag: 'earliest' },
    { label: 'finalized', tag: 'finalized' },
    { label: 'safe', tag: 'safe' },
    { label: 'a hex height', tag: '0x1' },
    { label: 'a numeric height', tag: 1 },
    { label: 'an EIP-1898 block object', tag: { blockNumber: '0x1' } },
    { label: 'an EIP-1898 block hash object', tag: { blockHash: '0xabc' } },
  ];

  for (const method of blockTagMethods) {
    it.each(refusedTags)(
      `${method} refuses $label locally, with zero posts`,
      async ({ tag }) => {
        const { send, posts } = providerOver({});

        const failure = await failureOf(send(method, paramsWithTag(method, tag)));

        expect(failure).toBeInstanceOf(ChainBlockTagRefusedError);
        // Zero posts is the load-bearing half: `eth_call` with an EIP-1898 object
        // is *validated and then silently answered from present state* by
        // java-tron — present-day data for a historical question, with no error at
        // all. Refusing after the request would leave that answer in hand.
        expect(posts.calls).toEqual([]);
      },
    );

    it(`${method} accepts 'latest' at its own parameter index`, async () => {
      // The invariant must refuse nothing upstream sends today: every
      // `provider.js` reader defaults to `'latest'`.
      const { send, posts } = providerOver({
        eth_getStorageAt: { result: '0x' },
        eth_getCode: { result: '0x' },
        eth_call: { result: '0x' },
      });

      await send(method, paramsWithTag(method, acceptedBlockTag));

      expect(posts.calls).toHaveLength(1);
      expect(posts.calls[0]?.method).toBe(method);
    });
  }

  it('pins each method\'s tag index, which differs — hence a table', () => {
    // Re-read from `provider.js` at 1.46.0: `call` sends `[{to, data}, block]`
    // with no `from` and no `gas`, so its index is 1 while `getStorageAt`'s is 2.
    // A single constant would silently inspect the wrong argument.
    expect(blockTagIndex).toEqual({
      eth_getStorageAt: 2,
      eth_getCode: 1,
      eth_call: 1,
    });
  });

  it('accepts a method with the tag omitted, rather than inventing a refusal', async () => {
    const { send, posts } = providerOver({ eth_getCode: { result: '0x' } });
    await send('eth_getCode', ['0x0000000000000000000000000000000000000000']);
    expect(posts.calls).toHaveLength(1);
  });

  it('leaves block-query methods alone — they accept heights', async () => {
    // `eth_getBlockByNumber` carries no entry in `blockTagIndex` on purpose:
    // java-tron's *block-query* methods accept heights and named tags while its
    // *state* methods accept only `latest`. Generalizing either way is the error
    // the uniformity clause is scoped to avoid.
    expect(blockTagIndex['eth_getBlockByNumber']).toBeUndefined();
    const { send, posts } = providerOver({
      eth_getBlockByNumber: { result: { hash: '0xabc' } },
    });
    await send('eth_getBlockByNumber', ['0x1', false]);
    expect(posts.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. the method sets are data
// ---------------------------------------------------------------------------

describe('the required set is eight, and it is a table rather than a switch', () => {
  it('pins all eight, including the one upgrades-core never calls', () => {
    // `eth_getBlockByNumber` is the chain layer's own — the engine never calls it — so a
    // later "simplify the required set to what the engine needs" removes exactly
    // the method the instance-change fingerprint depends on, silently disabling
    // that detection while every engine-facing test still passes. Pinning it here
    // is the detector.
    expect([...requiredMethods]).toEqual([
      'eth_chainId',
      'web3_clientVersion',
      'eth_getCode',
      'eth_getStorageAt',
      'eth_call',
      'eth_getTransactionByHash',
      'eth_getTransactionReceipt',
      'eth_getBlockByNumber',
    ]);
    expect(requiredMethods).toHaveLength(8);
  });

  it('keeps the required and refused sets disjoint', () => {
    const required = new Set<string>(requiredMethods);
    for (const method of refusedMethods) {
      expect(required.has(method), `${method} is both required and refused`).toBe(
        false,
      );
    }
  });

  it('exposes frozen tables, so a caller cannot widen the policy at runtime', () => {
    expect(Object.isFrozen(refusedMethods)).toBe(true);
    expect(Object.isFrozen(requiredMethods)).toBe(true);
    expect(Object.isFrozen(methodPolicies)).toBe(true);
    expect(Object.isFrozen(stringResultMethods)).toBe(true);
    expect(Object.isFrozen(blockTagIndex)).toBe(true);
  });

  it('defaults policyFor to forward, including for a name from Object.prototype', () => {
    // `policyFor` uses `hasOwnProperty` rather than `in`, so `'constructor'` and
    // `'toString'` forward instead of resolving a prototype member as a policy.
    for (const method of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(policyFor(method).kind, `${method} did not forward`).toBe('forward');
    }
  });
});
