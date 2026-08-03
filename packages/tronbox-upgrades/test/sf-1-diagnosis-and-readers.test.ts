/**
 * SF-1 — INV-8, INV-14, INV-15, INV-16, INV-17, INV-22, INV-37(b), INV-40, INV-47.
 *
 * **INV-22 is the row with the trap that reads as a feature.**
 * `'REVERT opcode executed'.includes('revert')` is `false` — verified by execution
 * in § 1 — so all four of `call-optional-signature.js`'s case-sensitive substrings
 * miss both of TRON's probe outcomes, and `callOptionalSignature` rethrows where it
 * should return `undefined`. The tempting fix is to make SF-1's own error text
 * match. But the `TvmDiagnosis` kind `'reverted'` **does** contain `revert`, so
 * interpolating the diagnosis into `ChainRpcError`'s message — the natural way to
 * make the error self-explaining — would silently perform exactly the translation
 * INV-22 bans, and would change `callOptionalSignature`'s behaviour without any
 * change to a call site. § 2 asserts the diagnosis is a **field** and is absent from
 * the message.
 *
 * **INV-16 is the row where a permissive default disables a safety check.** "Out of
 * energy" arrives on the *same* `-32000` as a revert. Classified as a revert,
 * `looksLikeProxyAdmin` returns `false` and a transparent-proxy admin check is
 * skipped on an account that simply ran out of a resource the user could have topped
 * up in a second. `default: reverted` is the natural way to write that function.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyNodeError,
  isProbeOutcome,
  type JsonRpcErrorPayload,
  type TvmDiagnosis,
} from '../src/chain/classify';
import {
  ChainBeaconNotFoundError,
  ChainImplementationNotFoundError,
  ChainRpcError,
  ChainTransportError,
} from '../src/chain/errors';
import { createProvider } from '../src/chain/provider';
import { createRpcChannel } from '../src/chain/transport';
import {
  bindChainReaders,
  hasCode,
  looksLikeProxyAdmin,
  readBeaconImplementation,
  readImplementationAddress,
  readProxySlots,
  readUpgradeInterfaceVersion,
  slotLabels,
  tvmCallOptional,
} from '../src/chain/read';
import { eip1967Slots, zeroChainAddress, zeroSlotWord } from '../src/chain/slots';
import {
  createRecordingPost,
  slotWordFor,
  type PostFixture,
  type RpcTable,
} from './helpers/sf-1-chain';

const descriptor = Object.freeze({
  describe: 'http://node.internal:8545/jsonrpc',
  origin: 'derived' as const,
});

const PROXY = '0x1111111111111111111111111111111111111111';
const IMPL = '0x2222222222222222222222222222222222222222';

function providerOver(table: RpcTable): {
  readonly provider: { send(m: string, p: readonly unknown[]): Promise<unknown> };
  readonly posts: PostFixture;
} {
  const posts = createRecordingPost(table);
  return { provider: createProvider(createRpcChannel(descriptor, posts.post)), posts };
}

/** The measured java-tron payloads, one place. */
const nodeErrors = {
  noContract: { code: -32600, message: 'Smart contract is not exist.', data: '{}' },
  reverted: { code: -32000, message: 'REVERT opcode executed', data: '{}' },
  outOfEnergy: {
    code: -32000,
    message: 'account does not have enough energy',
    data: '{}',
  },
  methodMissing: { code: -32601, message: 'method not found', data: '{}' },
  methodMissingAlt: { code: -32601, message: 'the method eth_foo does not exist/is not available' },
  badParams: {
    code: -32602,
    message: 'QUANTITY not supported, just support TAG as latest',
  },
  badParamsAlt: {
    code: -32602,
    message: 'exception decoding Hex string: invalid characters encountered in Hex string',
  },
} as const satisfies Readonly<Record<string, JsonRpcErrorPayload>>;

// ---------------------------------------------------------------------------
// 1. INV-22 — the premise, executed
// ---------------------------------------------------------------------------

describe('INV-22: upstream\'s four substrings miss TRON\'s probe outcomes', () => {
  it('measures that REVERT opcode executed does not contain "revert"', () => {
    // The whole reason the five-name deny-list is free rather than costly. Upstream
    // matches case-sensitively, and java-tron shouts.
    expect('REVERT opcode executed'.includes('revert')).toBe(false);
    expect('Smart contract is not exist.'.includes('revert')).toBe(false);
    for (const substring of [
      'revert',
      'execution error',
      'invalid opcode',
      'call revert exception',
    ]) {
      expect(
        nodeErrors.reverted.message.includes(substring),
        `upstream's "${substring}" unexpectedly matches TRON's revert text`,
      ).toBe(false);
      expect(
        nodeErrors.noContract.message.includes(substring),
        `upstream's "${substring}" unexpectedly matches TRON's no-contract text`,
      ).toBe(false);
    }
  });

  it('measures that the diagnosis kind "reverted" DOES contain "revert"', () => {
    // The trap. Interpolating the kind into a message would make upstream's
    // predicate match — a translation performed by a template, with no call site to
    // review.
    const kind: TvmDiagnosis['kind'] = 'reverted';
    expect(kind.includes('revert')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. INV-22 — the diagnosis is a field, absent from the message
// ---------------------------------------------------------------------------

describe('INV-22: ChainRpcError carries the diagnosis as a field, never in its text', () => {
  it.each([
    { label: 'a revert', payload: nodeErrors.reverted, kind: 'reverted' },
    { label: 'no contract', payload: nodeErrors.noContract, kind: 'no-contract-at-address' },
    { label: 'out of energy', payload: nodeErrors.outOfEnergy, kind: 'unclassified' },
    { label: 'a missing method', payload: nodeErrors.methodMissing, kind: 'method-unsupported' },
    { label: 'a rejected argument', payload: nodeErrors.badParams, kind: 'argument-rejected' },
  ])('exposes $kind for $label without naming it in the message', ({ payload, kind }) => {
    const error = new ChainRpcError('eth_call', payload, descriptor.describe);

    expect(error.diagnosis.kind).toBe(kind);
    // The load-bearing assertion of this file. If the kind were interpolated, the
    // message for a revert would contain `revert` and `callOptionalSignature` would
    // start swallowing — a behaviour change with no code change at any call site.
    expect(error.message).not.toContain(kind);
    expect(error.message).not.toContain('revert');
    expect(error.message).not.toContain('no-contract');
    expect(error.message).not.toContain('unclassified');
  });

  it('reproduces the node\'s own text byte-for-byte (INV-44)', () => {
    for (const payload of Object.values(nodeErrors)) {
      const error = new ChainRpcError('eth_call', payload, descriptor.describe);
      // Editing node text is how the forbidden translation re-enters through the
      // back door — an appended clarification is a translation with a friendlier
      // name — and it destroys the one artifact a user can search a java-tron issue
      // tracker for.
      expect(error.message).toContain(payload.message);
      expect(error.rpcMessage).toBe(payload.message);
      expect(error.rpcCode).toBe(payload.code);
    }
  });

  it('names the code and the scrubbed endpoint, and no raw URL', () => {
    const error = new ChainRpcError('eth_call', nodeErrors.reverted, descriptor.describe);
    expect(error.message).toContain('-32000');
    expect(error.message).toContain(descriptor.describe);
  });

  it('derives the diagnosis in the constructor, so two callers cannot disagree', () => {
    // One classification site. Passing the diagnosis in would let a caller supply a
    // different one for the same payload.
    const first = new ChainRpcError('eth_call', nodeErrors.reverted, 'a');
    const second = new ChainRpcError('eth_getCode', nodeErrors.reverted, 'b');
    expect(first.diagnosis).toEqual(second.diagnosis);
    expect(first.diagnosis).toEqual(classifyNodeError(nodeErrors.reverted));
  });
});

// ---------------------------------------------------------------------------
// 3. INV-15 / INV-16 — code first, message second, and no permissive default
// ---------------------------------------------------------------------------

describe('INV-15: classification keys on code first and message only within a code', () => {
  it.each([
    { label: '-32600 + not exist', payload: nodeErrors.noContract, kind: 'no-contract-at-address' },
    { label: '-32000 + REVERT', payload: nodeErrors.reverted, kind: 'reverted' },
    { label: '-32000 + out of energy', payload: nodeErrors.outOfEnergy, kind: 'unclassified' },
    { label: '-32601 short form', payload: nodeErrors.methodMissing, kind: 'method-unsupported' },
    { label: '-32601 long form', payload: nodeErrors.methodMissingAlt, kind: 'method-unsupported' },
    { label: '-32602 QUANTITY', payload: nodeErrors.badParams, kind: 'argument-rejected' },
    { label: '-32602 hex decoding', payload: nodeErrors.badParamsAlt, kind: 'argument-rejected' },
  ])('classifies $label as $kind', ({ payload, kind }) => {
    expect(classifyNodeError(payload).kind).toBe(kind);
  });

  it('does not treat an unrecognized -32600 as no-contract', () => {
    // A positive match, never a code catch-all: an unrecognized `-32600` must reach
    // `unclassified` rather than become "nothing is deployed here".
    expect(
      classifyNodeError({ code: -32600, message: 'invalid request' }).kind,
    ).toBe('unclassified');
  });

  it('tolerates a reworded no-contract message without becoming a catch-all', () => {
    for (const message of [
      'Smart contract is not exist.',
      "contract doesn't exist",
      'CONTRACT DOES not exist',
    ]) {
      expect(
        classifyNodeError({ code: -32600, message }).kind,
        `"${message}" was not classified`,
      ).toBe('no-contract-at-address');
    }
  });

  it('gates revert data on a 0x prefix, so the literal "{}" is never decoded', () => {
    // `data` is `"{}"` on java-tron below 4.8.1 *and* on non-revert errors at 4.8.2,
    // so its presence proves nothing.
    const withBrace = classifyNodeError({ ...nodeErrors.reverted, data: '{}' });
    expect(withBrace).toEqual({ kind: 'reverted' });
    expect('revertData' in withBrace).toBe(false);

    const withData = classifyNodeError({ ...nodeErrors.reverted, data: '0xdeadbeef' });
    expect(withData).toEqual({ kind: 'reverted', revertData: '0xdeadbeef' });
  });

  it('performs no nested traversal of error.error or error.cause', () => {
    // INV-15 forbids a walk, and the reason there is nothing to walk is that
    // `transport.ts` refuses an unvalidated shape first — the structural fix for
    // Research D9's shallowness. A nested payload therefore classifies on its own
    // top-level code, not on a message dug out of a child.
    const nested: JsonRpcErrorPayload = {
      code: -32603,
      message: 'internal error',
      data: { error: { message: 'REVERT opcode executed' } },
    };
    expect(classifyNodeError(nested).kind).toBe('unclassified');
  });
});

describe('INV-16: unclassified is never a probe outcome', () => {
  it.each([
    { kind: 'no-contract-at-address', probe: true },
    { kind: 'reverted', probe: true },
    { kind: 'method-unsupported', probe: false },
    { kind: 'argument-rejected', probe: false },
    { kind: 'unclassified', probe: false },
  ])('isProbeOutcome($kind) is $probe', ({ kind, probe }) => {
    // Enumerating all five, so a sixth member added without a decision shows up as
    // an untested kind rather than falling into a permissive default.
    const diagnosis = { kind } as TvmDiagnosis;
    expect(isProbeOutcome(diagnosis)).toBe(probe);
  });

  it('covers exactly two of the five members', () => {
    const kinds: readonly TvmDiagnosis['kind'][] = [
      'no-contract-at-address',
      'reverted',
      'method-unsupported',
      'argument-rejected',
      'unclassified',
    ];
    const probes = kinds.filter(kind => isProbeOutcome({ kind } as TvmDiagnosis));
    expect(probes).toEqual(['no-contract-at-address', 'reverted']);
  });

  it('raises for out-of-energy instead of returning a no-answer', async () => {
    // The failure INV-16 exists to prevent, driven end to end: a resource condition
    // the user could fix must not silently disable a safety check.
    const { provider } = providerOver({ eth_call: { error: nodeErrors.outOfEnergy } });

    const failure = await tvmCallOptional(provider, PROXY, '0x8da5cb5b').then(
      outcome => outcome,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(ChainRpcError);
    const error = failure instanceof ChainRpcError ? failure : undefined;
    expect(error?.diagnosis.kind).toBe('unclassified');
    expect(error?.rpcMessage).toContain('energy');
  });

  it('does not let out-of-energy make looksLikeProxyAdmin answer false', async () => {
    // The specific consumer INV-16 names. `false` here would skip a
    // transparent-proxy admin check.
    const { provider } = providerOver({ eth_call: { error: nodeErrors.outOfEnergy } });
    await expect(looksLikeProxyAdmin(provider, PROXY)).rejects.toBeInstanceOf(
      ChainRpcError,
    );
  });

  it('raises for a method-unsupported diagnosis rather than absorbing it', async () => {
    const { provider } = providerOver({ eth_call: { error: nodeErrors.methodMissing } });
    await expect(tvmCallOptional(provider, PROXY, '0x8da5cb5b')).rejects.toBeInstanceOf(
      ChainRpcError,
    );
  });

  it('returns a no-answer for the two genuine probe outcomes', async () => {
    for (const [payload, because] of [
      [nodeErrors.reverted, 'reverted'],
      [nodeErrors.noContract, 'no-contract-at-address'],
    ] as const) {
      const { provider } = providerOver({ eth_call: { error: payload } });
      const outcome = await tvmCallOptional(provider, PROXY, '0x8da5cb5b');
      expect(outcome).toEqual({ kind: 'no-answer', because });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. INV-14 — a transport failure is never a no-answer
// ---------------------------------------------------------------------------

const transportFaults: readonly { readonly label: string; readonly table: RpcTable }[] = [
  {
    label: 'unreachable',
    table: {
      eth_call: { reject: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) },
      eth_getCode: { reject: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) },
      eth_getStorageAt: { reject: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) },
    },
  },
  {
    label: 'http-status',
    table: {
      eth_call: { reject: Object.assign(new Error('405'), { response: { status: 405 } }) },
      eth_getCode: { reject: Object.assign(new Error('405'), { response: { status: 405 } }) },
      eth_getStorageAt: { reject: Object.assign(new Error('405'), { response: { status: 405 } }) },
    },
  },
  {
    label: 'timeout',
    table: {
      eth_call: { reject: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
      eth_getCode: { reject: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
      eth_getStorageAt: { reject: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
    },
  },
  {
    label: 'non-json-body',
    table: {
      eth_call: { body: '<html><body>502 Bad Gateway</body></html>' },
      eth_getCode: { body: '<html><body>502 Bad Gateway</body></html>' },
      eth_getStorageAt: { body: '<html><body>502 Bad Gateway</body></html>' },
    },
  },
  {
    label: 'malformed-envelope',
    table: {
      eth_call: { body: { jsonrpc: '2.0', id: 1 } },
      eth_getCode: { body: { jsonrpc: '2.0', id: 1 } },
      eth_getStorageAt: { body: { jsonrpc: '2.0', id: 1 } },
    },
  },
];

describe('INV-14: every transport failure raises at every read.ts entry point', () => {
  for (const fault of transportFaults) {
    it(`raises ChainTransportError from tvmCallOptional on ${fault.label}`, async () => {
      const { provider } = providerOver(fault.table);
      await expect(tvmCallOptional(provider, PROXY, '0x8da5cb5b')).rejects.toBeInstanceOf(
        ChainTransportError,
      );
    });

    it(`raises rather than answering false from hasCode on ${fault.label}`, async () => {
      const { provider } = providerOver(fault.table);
      await expect(hasCode(provider, PROXY)).rejects.toBeInstanceOf(ChainTransportError);
    });

    it(`raises rather than answering no-code from readProxySlots on ${fault.label}`, async () => {
      // The specimen: the sibling's `getSlot` wraps its read in `catch (_)` and
      // reroutes to a local dev chain, so a *transient* failure on a public network
      // silently reads ERC-1967 slots from somewhere else. The severity is not "a
      // read failed" — it is that the read *succeeded* against the wrong chain.
      const { provider } = providerOver(fault.table);
      await expect(readProxySlots(provider, PROXY)).rejects.toBeInstanceOf(
        ChainTransportError,
      );
    });

    it(`raises rather than answering false from looksLikeProxyAdmin on ${fault.label}`, async () => {
      const { provider } = providerOver(fault.table);
      await expect(looksLikeProxyAdmin(provider, PROXY)).rejects.toBeInstanceOf(
        ChainTransportError,
      );
    });

    it(`raises rather than answering undefined from readUpgradeInterfaceVersion on ${fault.label}`, async () => {
      const { provider } = providerOver(fault.table);
      await expect(
        readUpgradeInterfaceVersion(provider, PROXY),
      ).rejects.toBeInstanceOf(ChainTransportError);
    });

    it(`raises rather than answering not-a-beacon from readBeaconImplementation on ${fault.label}`, async () => {
      const { provider } = providerOver(fault.table);
      await expect(
        readBeaconImplementation(provider, PROXY),
      ).rejects.toBeInstanceOf(ChainTransportError);
    });
  }

  it('bounds a 1 MB non-JSON body in the message and states the truncation (INV-44)', async () => {
    const page = `<html>${'x'.repeat(1_000_000)}</html>`;
    const { provider } = providerOver({ eth_getCode: { body: page } });

    const failure = await hasCode(provider, PROXY).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(ChainTransportError);
    const error: Error = failure instanceof Error ? failure : new Error('none');
    // Unbounded rendering is both unreadable and, if the proxy echoes request
    // headers — which error pages do — a leak of whatever INV-43 was keeping out.
    expect(error.message.length).toBeLessThan(1_000);
    expect(error.message).toContain('characters total');
  });
});

// ---------------------------------------------------------------------------
// 5. INV-17 / INV-37(b) / INV-40 — code before slots, and the cost proves it
// ---------------------------------------------------------------------------

describe('INV-17: no-code and reverted stay distinct at all four surfaces', () => {
  it('reports no-code from readProxySlots at a cost of exactly one round-trip', async () => {
    // The round-trip count is the only externally visible consequence of the
    // `eth_getCode`-first rule, which is why INV-40 states it and INV-37 relies on
    // it. One post, not six.
    const { provider, posts } = providerOver({ eth_getCode: { result: '0x' } });

    const read = await readProxySlots(provider, PROXY);

    expect(read).toEqual({ kind: 'no-code' });
    expect(posts.methods()).toEqual(['eth_getCode']);
  });

  it('does not report a code member with three nulls for a no-code address', async () => {
    // Those are different facts. `{kind:'no-code'}` says nothing is deployed;
    // three `null`s say something is deployed and is not a proxy.
    const { provider } = providerOver({ eth_getCode: { result: '0x' } });
    const read = await readProxySlots(provider, PROXY);
    expect(read.kind).toBe('no-code');
    expect('implementation' in read).toBe(false);
  });

  it('reports a code member with three nulls for a deployed non-proxy', async () => {
    const { provider, posts } = providerOver({
      eth_getCode: { result: '0x60806040' },
      eth_getStorageAt: { result: zeroSlotWord },
    });

    const read = await readProxySlots(provider, PROXY);

    expect(read).toEqual({
      kind: 'code',
      implementation: null,
      admin: null,
      beacon: null,
    });
    // 1 code + 2 implementation (modern, legacy) + 2 admin + 1 beacon = 6, the
    // stated bound for all three slots.
    expect(posts.calls).toHaveLength(6);
  });

  it('reports no-code-at-beacon at one round-trip and not-a-beacon at two', async () => {
    const noCode = providerOver({ eth_getCode: { result: '0x' } });
    expect(await readBeaconImplementation(noCode.provider, PROXY)).toEqual({
      kind: 'no-code-at-beacon',
    });
    expect(noCode.posts.calls).toHaveLength(1);

    const reverts = providerOver({
      eth_getCode: { result: '0x60806040' },
      eth_call: { error: nodeErrors.reverted },
    });
    expect(await readBeaconImplementation(reverts.provider, PROXY)).toEqual({
      kind: 'not-a-beacon',
      because: 'call-did-not-answer',
    });
    expect(reverts.posts.calls).toHaveLength(2);
  });

  it('distinguishes not-a-beacon\'s two reasons', async () => {
    // D8's distinction, at the last surface it can be lost: upstream collapses both
    // into `InvalidBeacon`, so a user who mistyped an address is told their contract
    // is the wrong kind and "check the address" is not among the suggestions.
    const notAnAddress = providerOver({
      eth_getCode: { result: '0x60806040' },
      eth_call: { result: `0x${'ff'.repeat(32)}` },
    });
    expect(await readBeaconImplementation(notAnAddress.provider, PROXY)).toEqual({
      kind: 'not-a-beacon',
      because: 'answer-is-not-an-address',
    });
  });

  it('reads a beacon implementation when the answer is an address word', async () => {
    const { provider } = providerOver({
      eth_getCode: { result: '0x60806040' },
      eth_call: { result: slotWordFor(IMPL) },
    });
    expect(await readBeaconImplementation(provider, PROXY)).toEqual({
      kind: 'implementation',
      address: IMPL,
    });
  });

  it('keeps tvmCallOptional\'s two because values apart', async () => {
    const reverted = providerOver({ eth_call: { error: nodeErrors.reverted } });
    const noContract = providerOver({ eth_call: { error: nodeErrors.noContract } });
    const first = await tvmCallOptional(reverted.provider, PROXY, '0x8da5cb5b');
    const second = await tvmCallOptional(noContract.provider, PROXY, '0x8da5cb5b');
    expect(first).not.toEqual(second);
    expect(first.kind === 'no-answer' ? first.because : '').toBe('reverted');
    expect(second.kind === 'no-answer' ? second.because : '').toBe(
      'no-contract-at-address',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. INV-40 — the stated counts, per surface
// ---------------------------------------------------------------------------

describe('INV-40: every surface costs its stated number of round-trips', () => {
  const codeTable: RpcTable = {
    eth_getCode: { result: '0x60806040' },
    eth_getStorageAt: { result: slotWordFor(IMPL) },
    eth_call: { result: slotWordFor(IMPL) },
  };

  it.each([
    { surface: 'hasCode', count: 1, run: (p: PostFixture, provider: { send(m: string, a: readonly unknown[]): Promise<unknown> }) => hasCode(provider, PROXY) },
  ])('$surface costs $count', async ({ count, run }) => {
    const { provider, posts } = providerOver(codeTable);
    await run(posts, provider);
    expect(posts.calls).toHaveLength(count);
  });

  it('readImplementationAddress costs one when the modern slot answers', async () => {
    const { provider, posts } = providerOver(codeTable);
    await readImplementationAddress(provider, PROXY);
    expect(posts.calls).toHaveLength(1);
  });

  it('readImplementationAddress costs two when the modern slot is empty', async () => {
    // Mirrors `eip-1967.js:getStorageFallback`: modern then legacy, stopping at the
    // first non-empty. The engine already makes an implementation lookup cost two.
    let call = 0;
    const posts = createRecordingPost({});
    const provider = createProvider(
      createRpcChannel(descriptor, async (payload: unknown) => {
        call += 1;
        void posts;
        const record: Record<string, unknown> = { ...(payload as object) };
        return {
          jsonrpc: '2.0',
          id: record['id'],
          result: call === 1 ? zeroSlotWord : slotWordFor(IMPL),
        };
      }),
    );

    const address = await readImplementationAddress(provider, PROXY);

    expect(address).toBe(IMPL);
    expect(call).toBe(2);
  });

  it('readProxySlots de-duplicates the requested labels so the bound is content-independent', async () => {
    const { provider, posts } = providerOver({
      eth_getCode: { result: '0x60806040' },
      eth_getStorageAt: { result: slotWordFor(IMPL) },
    });

    await readProxySlots(provider, PROXY, [
      'implementation',
      'implementation',
      'implementation',
    ]);

    // Three requests for the same label cost one read, not three.
    expect(posts.calls).toHaveLength(2);
  });

  it('readProxySlots is bounded at six for all three slots regardless of content', async () => {
    const { provider, posts } = providerOver({
      eth_getCode: { result: '0x60806040' },
      eth_getStorageAt: { result: zeroSlotWord },
    });
    await readProxySlots(provider, PROXY, slotLabels);
    expect(posts.calls.length).toBeLessThanOrEqual(6);
  });

  it('tvmCallOptional, readUpgradeInterfaceVersion and looksLikeProxyAdmin each cost one', async () => {
    for (const run of [
      (p: { send(m: string, a: readonly unknown[]): Promise<unknown> }) =>
        tvmCallOptional(p, PROXY, '0x8da5cb5b'),
      (p: { send(m: string, a: readonly unknown[]): Promise<unknown> }) =>
        readUpgradeInterfaceVersion(p, PROXY),
      (p: { send(m: string, a: readonly unknown[]): Promise<unknown> }) =>
        looksLikeProxyAdmin(p, PROXY),
    ]) {
      const { provider, posts } = providerOver(codeTable);
      await run(provider);
      expect(posts.calls).toHaveLength(1);
    }
  });

  it('readBeaconImplementation costs exactly two with code', async () => {
    const { provider, posts } = providerOver(codeTable);
    await readBeaconImplementation(provider, PROXY);
    expect(posts.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 7. INV-8 — no-answer reasons are named members, never undefined
// ---------------------------------------------------------------------------

describe('INV-8: every no-answer branch carries a named reason', () => {
  it('never expresses a no-answer as undefined, null or an empty string', async () => {
    const outcomes: readonly unknown[] = await Promise.all([
      tvmCallOptional(
        providerOver({ eth_call: { error: nodeErrors.reverted } }).provider,
        PROXY,
        '0x8da5cb5b',
      ),
      readProxySlots(providerOver({ eth_getCode: { result: '0x' } }).provider, PROXY),
      readBeaconImplementation(
        providerOver({ eth_getCode: { result: '0x' } }).provider,
        PROXY,
      ),
    ]);

    for (const outcome of outcomes) {
      expect(outcome).not.toBeUndefined();
      expect(outcome).not.toBeNull();
      expect(typeof outcome).toBe('object');
      const record: Record<string, unknown> = { ...(outcome as object) };
      expect(typeof record['kind']).toBe('string');
    }
  });

  it('allows exactly one `| undefined` — readUpgradeInterfaceVersion\'s', async () => {
    // Mirrors upstream's documented contract for a **present, answering** contract
    // that has no such getter, and it is the only one in SF-1's surface.
    const answering = providerOver({ eth_call: { result: '0x' } });
    await expect(
      readUpgradeInterfaceVersion(answering.provider, PROXY),
    ).resolves.toBeUndefined();

    const reverting = providerOver({ eth_call: { error: nodeErrors.reverted } });
    await expect(
      readUpgradeInterfaceVersion(reverting.provider, PROXY),
    ).resolves.toBeUndefined();
  });

  it('decodes a real ABI string answer', async () => {
    // `"5.0.0"` as an ABI-encoded string: offset 32, length 5, then the bytes.
    const encoded =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '0000000000000000000000000000000000000000000000000000000000000005' +
      '352e302e30'.padEnd(64, '0');
    const { provider } = providerOver({ eth_call: { result: encoded } });
    await expect(readUpgradeInterfaceVersion(provider, PROXY)).resolves.toBe('5.0.0');
  });

  it('returns undefined when the offset is not 32, mirroring upstream\'s guard', async () => {
    // A fallback function can answer this call with something that is not a string,
    // and upstream deliberately returns `undefined` rather than throwing.
    const wrongOffset =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000040' +
      '0000000000000000000000000000000000000000000000000000000000000005' +
      '352e302e30'.padEnd(64, '0');
    const { provider } = providerOver({ eth_call: { result: wrongOffset } });
    await expect(readUpgradeInterfaceVersion(provider, PROXY)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. INV-47 — every reader works with a bare { send }, and the binding is thin
// ---------------------------------------------------------------------------

describe('INV-47: the reader surface takes send as a parameter', () => {
  it('drives every reader from a bare object with no ChainAccess in existence', async () => {
    // The seam's completeness test: a bare `{ send }` and nothing else. Free
    // functions that each construct their own transport are how the sibling ended up
    // with two, reading the implementation slot through one and verifying it through
    // the other.
    const bare = {
      send: async (method: string): Promise<unknown> => {
        if (method === 'eth_getCode') {
          return '0x60806040';
        }
        if (method === 'eth_getStorageAt') {
          return slotWordFor(IMPL);
        }
        return slotWordFor(IMPL);
      },
    };

    await expect(hasCode(bare, PROXY)).resolves.toBe(true);
    await expect(readImplementationAddress(bare, PROXY)).resolves.toBe(IMPL);
    await expect(readProxySlots(bare, PROXY)).resolves.toMatchObject({ kind: 'code' });
    await expect(looksLikeProxyAdmin(bare, PROXY)).resolves.toBe(true);
    await expect(readBeaconImplementation(bare, PROXY)).resolves.toMatchObject({
      kind: 'implementation',
    });
  });

  it('produces identical results and identical request sequences through the binding', async () => {
    const table: RpcTable = {
      eth_getCode: { result: '0x60806040' },
      eth_getStorageAt: { result: slotWordFor(IMPL) },
    };

    const direct = providerOver(table);
    const directResult = await readImplementationAddress(direct.provider, PROXY);

    const bound = providerOver(table);
    const boundResult = await bindChainReaders(bound.provider).readImplementationAddress(
      PROXY,
    );

    expect(boundResult).toBe(directResult);
    expect(bound.posts.calls).toEqual(direct.posts.calls);
  });

  it('exposes a frozen reader surface (INV-3)', () => {
    const { provider } = providerOver({});
    expect(Object.isFrozen(bindChainReaders(provider))).toBe(true);
  });

  it('mirrors the engine\'s throw/zero-address asymmetry rather than smoothing it', async () => {
    // `eip-1967-type.js:isTransparentProxy` is `!isEmptySlot(adminAddress)`, so a
    // reader that threw for an empty admin slot would make that predicate throw
    // instead of returning `false` — and the plugin would disagree with the engine
    // about whether an address is a proxy (Research D7).
    const empty = providerOver({
      eth_getCode: { result: '0x60806040' },
      eth_getStorageAt: { result: zeroSlotWord },
    });
    const readers = bindChainReaders(empty.provider);

    await expect(readers.readAdminAddress(PROXY)).resolves.toBe(zeroChainAddress);
    await expect(readers.readImplementationAddress(PROXY)).rejects.toBeInstanceOf(
      ChainImplementationNotFoundError,
    );
    await expect(readers.readBeaconAddress(PROXY)).rejects.toBeInstanceOf(
      ChainBeaconNotFoundError,
    );
  });

  it('reads the modern slot key the engine derives, not a copy of a decimal', async () => {
    const { provider, posts } = providerOver({
      eth_getStorageAt: { result: slotWordFor(IMPL) },
    });
    await readImplementationAddress(provider, PROXY);
    expect(posts.calls[0]?.params[1]).toBe(eip1967Slots.implementation);
  });
});
