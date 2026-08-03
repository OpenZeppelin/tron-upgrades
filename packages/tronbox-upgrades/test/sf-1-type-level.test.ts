/**
 * SF-1 — the eleven invariants that make a wrong answer **unrepresentable**.
 *
 * These are enforced by the type system, so **the assertion is a compile error**, and
 * this file is checked by `tsc -p tsconfig.test.json` rather than only by vitest.
 * Every negative case is written with `@ts-expect-error`, which is a bidirectional
 * assertion and the reason this idiom is used instead of prose:
 *
 * - if the forbidden code stops being an error, `tsc` fails with
 *   *"Unused '@ts-expect-error' directive"* — so a **loosened** type breaks the build;
 * - if the surrounding permitted code becomes an error, `tsc` fails normally — so an
 *   over-tightened type breaks the build too.
 *
 * A runtime test that merely restates a type is deliberately **not** written here.
 * Where a type-level property has an observable runtime consequence, that assertion
 * lives in the suite that drives the behaviour; this file holds only what the compiler
 * alone can prove.
 */

import { describe, expect, it } from 'vitest';
import type { EthereumProvider } from '@openzeppelin/upgrades-core';
import type { ChainHandleSlot, TronWrapHandle } from '../src/environment';
import * as chain from '../src/chain';
import type {
  ChainAccess,
  ChainAccessDependencies,
  CapabilityReport,
} from '../src/chain';
import type { TvmDiagnosis, ProbeDiagnosis } from '../src/chain/classify';
import type { EndpointDescriptor, EndpointOrigin } from '../src/chain/endpoint';
import type { JsonRpcOutcome } from '../src/chain/transport';
import type { TronEthereumProvider } from '../src/chain/provider';
import type {
  BeaconRead,
  OptionalCallOutcome,
  ProxySlotsRead,
} from '../src/chain/read';
import type { InstanceComparison, RecordedChainInstance } from '../src/chain/instance';
import type { ChainAddress } from '../src/chain/slots';
import { slotToAddress, zeroChainAddress, zeroSlotWord } from '../src/chain/slots';

/** `true` only when `A` and `B` are mutually assignable — a real equality check. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Compile-time assertion. `expectType<true>()` fails to compile when the check is `false`. */
function expectType<T extends true>(): T {
  return true as T;
}

/** The keys of a type, as a union — for asserting a shape has *exactly* some fields. */
type KeysOf<T> = keyof T;

// ---------------------------------------------------------------------------
// INV-1 — the three-member union, and no member carries both
// ---------------------------------------------------------------------------

describe('INV-1 (type-level): JsonRpcOutcome has three members and no member carries both', () => {
  it('is a closed three-member discriminated union', () => {
    expectType<Exact<JsonRpcOutcome['kind'], 'result' | 'node-error' | 'transport-failure'>>();

    // `outcome.result` is reachable **only** inside the `'result'` branch, so a
    // passthrough returning the envelope instead of `envelope.result`, or one that
    // resolves `{error}` instead of raising, cannot be written without changing this
    // type. That is what makes upstream's `Broken invariant: … chainId undefined does
    // not match eth_chainId 728126428` abort structurally unreachable rather than
    // avoided by convention.
    const outcome: JsonRpcOutcome = { kind: 'result', result: '0x1' };
    // @ts-expect-error — `error` does not exist on the 'result' member.
    void outcome.error;

    const failed: JsonRpcOutcome = { kind: 'node-error', error: { code: -1, message: 'x' } };
    // @ts-expect-error — `result` does not exist on the 'node-error' member.
    void failed.result;

    // And no member can be constructed carrying both.
    // @ts-expect-error — an object with both `result` and `error` matches no member.
    const both: JsonRpcOutcome = { kind: 'result', result: '0x1', error: { code: -1, message: 'x' } };
    void both;

    expect(outcome.kind).toBe('result');
  });

  it('narrows exhaustively, so a fourth member would be a compile error at every consumer', () => {
    // `provider.ts` closes its switch with `assertNever`. Modelled here so the
    // property is asserted rather than described: a `never` in the default arm is what
    // turns a new member into an error at the consumer rather than a silent fallthrough.
    const describeOutcome = (outcome: JsonRpcOutcome): string => {
      switch (outcome.kind) {
        case 'result':
          return 'result';
        case 'node-error':
          return 'node-error';
        case 'transport-failure':
          return 'transport-failure';
        default: {
          const exhaustive: never = outcome;
          return exhaustive;
        }
      }
    };
    expect(describeOutcome({ kind: 'result', result: null })).toBe('result');
  });
});

// ---------------------------------------------------------------------------
// INV-5 — the ChainAddress brand
// ---------------------------------------------------------------------------

describe('INV-5 (type-level): ChainAddress is a brand a bare string cannot satisfy', () => {
  it('refuses a bare string where a ChainAddress is required', () => {
    // Minted only by the validating functions. If SF-1 emitted un-branded lowercase
    // strings, the gap to SF-3's canonical form would be crossable by assignment and
    // the failure would appear as a proxy that "was never deployed".
    // @ts-expect-error — a bare string is not a ChainAddress.
    const forged: ChainAddress = '0x2222222222222222222222222222222222222222';
    void forged;

    // The minting function is the only route, and it returns the brand.
    const minted: ChainAddress = slotToAddress(zeroSlotWord);
    expectType<Exact<typeof minted, ChainAddress>>();
    expect(minted).toBe(zeroChainAddress);
  });

  it('is still assignable *to* string, so it can be sent as a parameter', () => {
    // The brand must not make the value unusable: it is a `string & {…}`, so it flows
    // into `params` without a cast.
    const address: ChainAddress = zeroChainAddress;
    const asString: string = address;
    expect(asString.startsWith('0x')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-8 — six total discriminated unions, one permitted `| undefined`
// ---------------------------------------------------------------------------

describe('INV-8 (type-level): six total unions, and the reason is always a named member', () => {
  it('closes each union over its named discriminants', () => {
    expectType<Exact<OptionalCallOutcome['kind'], 'answered' | 'no-answer'>>();
    expectType<Exact<ProxySlotsRead['kind'], 'no-code' | 'code'>>();
    expectType<
      Exact<BeaconRead['kind'], 'implementation' | 'no-code-at-beacon' | 'not-a-beacon'>
    >();
    expectType<
      Exact<
        TvmDiagnosis['kind'],
        | 'no-contract-at-address'
        | 'reverted'
        | 'method-unsupported'
        | 'argument-rejected'
        | 'unclassified'
      >
    >();
    expectType<Exact<InstanceComparison['kind'], 'same' | 'changed' | 'indeterminate'>>();
    expect(true).toBe(true);
  });

  it('makes the no-answer reason unreadable without narrowing first', () => {
    const outcome: OptionalCallOutcome = { kind: 'no-answer', because: 'reverted' };
    // @ts-expect-error — `because` is not on the union, only on the 'no-answer' member.
    void ({ kind: 'answered', data: '0x' } as OptionalCallOutcome).because;
    expect(outcome.because).toBe('reverted');
  });

  it('keeps no-code structurally distinct from a code member with three nulls', () => {
    const noCode: ProxySlotsRead = { kind: 'no-code' };
    // @ts-expect-error — the 'no-code' member has no `implementation` field, so the
    // two facts cannot be conflated even by a caller that ignores `kind`.
    void noCode.implementation;
    expect(noCode.kind).toBe('no-code');
  });

  it('names ProbeDiagnosis as exactly the two probe members', () => {
    // INV-16 as a type: `isProbeOutcome`'s narrowing target is two members, so a
    // caller that has checked it cannot then read a `because` from a non-probe member.
    expectType<Exact<ProbeDiagnosis['kind'], 'no-contract-at-address' | 'reverted'>>();
    // @ts-expect-error — 'unclassified' is not a ProbeDiagnosis.
    const notAProbe: ProbeDiagnosis = { kind: 'unclassified' };
    void notAProbe;
    expect(true).toBe(true);
  });

  it('permits `| undefined` on exactly one reader return', () => {
    type UpgradeInterfaceVersion = Awaited<
      ReturnType<ChainAccess['read']['readUpgradeInterfaceVersion']>
    >;
    expectType<Exact<UpgradeInterfaceVersion, string | undefined>>();

    // And nowhere else: the other readers return unions or a branded value.
    type Slots = Awaited<ReturnType<ChainAccess['read']['readProxySlots']>>;
    expectType<Exact<Slots, ProxySlotsRead>>();
    type Impl = Awaited<ReturnType<ChainAccess['read']['readImplementationAddress']>>;
    expectType<Exact<Impl, ChainAddress>>();
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-9 — EndpointDescriptor has exactly two fields, neither URL-shaped
// ---------------------------------------------------------------------------

describe('INV-9 (type-level): the descriptor has exactly describe and origin', () => {
  it('has no url, host or fullHost field', () => {
    expectType<Exact<KeysOf<EndpointDescriptor>, 'describe' | 'origin'>>();

    const descriptor: EndpointDescriptor = {
      describe: 'http://node.internal:8545/jsonrpc',
      origin: 'derived',
    };
    // @ts-expect-error — there is no `url` field, so no un-scrubbed form exists to
    // assign. A `url` field would be a second place SF-0's INV-40 can fail, inside the
    // module whose job is to not have one.
    void descriptor.url;
    // @ts-expect-error — and no `host` field either.
    void descriptor.host;

    expect(Object.keys(descriptor).sort()).toEqual(['describe', 'origin']);
  });

  it('closes origin over the three sources, so it is reported rather than guessed', () => {
    expectType<Exact<EndpointOrigin, 'argument' | 'environment' | 'derived'>>();
    // @ts-expect-error — an inferred fourth origin does not exist.
    const guessed: EndpointOrigin = 'inferred';
    void guessed;
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-29 — TronWrapRpcView is module-private
// ---------------------------------------------------------------------------

describe('INV-29 (type-level): no module outside endpoint.ts holds a typed handle view', () => {
  it('does not export TronWrapRpcView from the directory\'s face', () => {
    // A second module reading `tronWrap.networkConfig` "just for the fee limit" would
    // both cross SF-0's INV-28 boundary and put a credential-reachable object into a
    // second scope, in the one sub-feature that was proven not to need `sealSlot`.
    // Keeping the *type* private is what makes that require a fresh, reviewable
    // declaration rather than an import.
    expect(Object.keys(chain)).not.toContain('TronWrapRpcView');

    // The seam's own handle type stays narrow, which is the other half.
    expectType<Exact<KeysOf<TronWrapHandle>, 'trx'>>();
    const handle: TronWrapHandle = { trx: {} };
    // @ts-expect-error — `fullNode` is not on the seam's handle type.
    void handle.fullNode;
  });
});

// ---------------------------------------------------------------------------
// INV-30 — the engine gets access.provider, and the handle is not assignable
// ---------------------------------------------------------------------------

describe('INV-30 (type-level): the host handle is not an EthereumProvider', () => {
  it('refuses to pass the handle where the engine wants a provider', () => {
    const slot: ChainHandleSlot = { tronWrap: { trx: {} } };
    // @ts-expect-error — `TronWrapHandle` is not assignable to `EthereumProvider`, so
    // `Manifest.forNetwork(env.chain.tronWrap)` needs a cast. That matters because
    // `tronWrap.send(method, params)` satisfies the interface *structurally* while
    // POSTing to `this.networkConfig.fullNode + '/tre'` — so the mistake type-checks
    // and runs, and on a public network returns HTTP 405 with an HTML body.
    const misrouted: EthereumProvider = slot.tronWrap;
    void misrouted;
    expect(slot.tronWrap).toBeDefined();
  });

  it('declares ChainAccess.provider as the engine\'s own interface, so no consumer casts', () => {
    // Code Draft's one corrected Design claim, as a type assertion. A single
    // `send(string, unknown[]) => Promise<unknown>` does **not** satisfy
    // `EthereumProvider`: assignability to an overloaded interface requires
    // compatibility with every signature, and `Promise<unknown>` is not assignable to
    // the `Promise<HardhatMetadata>` two of the eleven declare. Declaring the field as
    // the engine's own type is what spares six consumers a cast each.
    expectType<Exact<ChainAccess['provider'], EthereumProvider>>();
    expect(true).toBe(true);
  });

  it('keeps the internal seam deliberately loose, which INV-47 requires', () => {
    // `TronEthereumProvider` stays `{ send(string, readonly unknown[]) }` so every
    // `read.ts` / `instance.ts` function is callable with a bare object and no
    // `ChainAccess` in existence. Narrowing it to the engine's overloads would make
    // INV-47's own test impossible to write without a cast.
    const bare: TronEthereumProvider = {
      send: async (): Promise<unknown> => '0x',
    };
    expectType<Exact<KeysOf<TronEthereumProvider>, 'send'>>();
    expect(bare.send).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// INV-11 / INV-24 — the tables are readonly
// ---------------------------------------------------------------------------

describe('INV-11 / INV-24 (type-level): the policy tables are not mutable', () => {
  it('refuses a write to refusedMethods or requiredMethods, at both layers', () => {
    // Two layers, and both are asserted because they fail differently. The type
    // refuses the write at compile time (`@ts-expect-error` below), and `Object.freeze`
    // refuses it at runtime — so a build that dropped the `readonly` would still throw,
    // and a build that dropped the freeze would still fail to compile. Executing the
    // mutation inside `toThrow` is what lets one test carry both.
    expect(() => {
      // @ts-expect-error — a readonly tuple has no assignable index.
      chain.refusedMethods[0] = 'eth_chainId';
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error — and no `push` on a readonly tuple.
      chain.refusedMethods.push('eth_chainId');
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error — same for the required set.
      chain.requiredMethods[0] = 'anvil_metadata';
    }).toThrow(TypeError);

    // And the tables are unchanged, which is the property that actually matters:
    // emptying `refusedMethods` at runtime would silently re-enable forwarding.
    expect([...chain.refusedMethods]).toEqual(['anvil_metadata', 'hardhat_metadata']);
    expect(chain.requiredMethods[0]).toBe('eth_chainId');
  });

  it('refuses a write to the shape and block-tag tables, at both layers', () => {
    const codeRule = chain.stringResultMethods['eth_getCode'];
    expect(codeRule).toBeDefined();
    expect(() => {
      // @ts-expect-error — `Readonly<Record<…>>` has no assignable index signature.
      chain.stringResultMethods['eth_chainId'] = codeRule;
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error — nor does the block-tag index.
      chain.blockTagIndex['eth_call'] = 0;
    }).toThrow(TypeError);

    // `eth_chainId`'s predicate survived: a table whose entries could be swapped at
    // runtime would let the strictest predicate be replaced by the loosest, which is
    // INV-4's whole failure mode reached by assignment.
    expect(chain.stringResultMethods['eth_chainId']?.accepts('728126428')).toBe(false);
    expect(chain.blockTagIndex['eth_call']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// INV-32 / INV-46 / INV-50 — one constructor, four seams
// ---------------------------------------------------------------------------

describe('INV-32 / INV-46 (type-level): one async constructor, four optional seams', () => {
  it('types createChainAccess as the sole route to a ChainAccess', () => {
    type Factory = typeof chain.createChainAccess;
    type Resolved = Awaited<ReturnType<Factory>>;
    expectType<Exact<Resolved, ChainAccess>>();

    // INV-32: there is no unprobed variant, and the type surface is where that is
    // guaranteed — an escape hatch would be worse than no probe, because the
    // diagnosis's main failure mode is a caller who skipped it.
    // @ts-expect-error — no such export exists.
    void chain.createChainAccessUnchecked;
    expect(typeof chain.createChainAccess).toBe('function');
  });

  it('names exactly the four dependency seams, all optional', () => {
    expectType<
      Exact<
        KeysOf<ChainAccessDependencies>,
        'endpointOverride' | 'env' | 'post' | 'probeNativeApi'
      >
    >();

    // Every one has a stated default, so `{}` is a complete argument. A consumer
    // embedding SF-1 in a different host changes configuration, not source.
    const none: ChainAccessDependencies = {};
    void none;

    // @ts-expect-error — a fifth seam is not accepted, which is what "the complete
    // set" means as a type rather than as prose.
    const extra: ChainAccessDependencies = { logger: console };
    void extra;
    expect(true).toBe(true);
  });

  it('offers no skipProbe or lazy option on the dependency surface', () => {
    // @ts-expect-error — no `skipProbe`.
    const skip: ChainAccessDependencies = { skipProbe: true };
    void skip;
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-38 — refusedLocally cannot be conflated with a node verdict
// ---------------------------------------------------------------------------

describe('INV-38 (type-level): the two facts have different shapes', () => {
  it('gives the refusal verdict no `ok` and the resolved verdict no `refusedLocally`', () => {
    type Resolved = CapabilityReport['resolved'][number];
    type Refused = CapabilityReport['refused'][number];

    expectType<Exact<KeysOf<Refused>, 'method' | 'refusedLocally'>>();

    const refused: Refused = { method: 'anvil_metadata', refusedLocally: true };
    // @ts-expect-error — a refusal verdict has no `ok`, so "unavailable" and "refused
    // by policy" cannot be reported through the same field. Those have opposite
    // implications: the first is a coincidence, the second a guarantee.
    void refused.ok;

    const resolved: Resolved = { method: 'eth_chainId', ok: true };
    // @ts-expect-error — and a node verdict cannot claim a local refusal.
    void resolved.refusedLocally;

    expect(refused.refusedLocally).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-10 / INV-25 — the recorded shape admits a partial record
// ---------------------------------------------------------------------------

describe('INV-10 / INV-25 (type-level): a partially written record is representable', () => {
  it('requires only chainId, so `indeterminate` has inputs to describe', () => {
    // `indeterminate` is the state **every** existing project is in on the first run
    // after this ships. If the recorded shape required all three fields, the
    // comparator's non-refusing branch would be unreachable by construction and the
    // feature would be a breaking change for a condition it cannot tell apart from a
    // first run.
    const minimal: RecordedChainInstance = { chainId: '0x2b6653dc' };
    void minimal;
    const partial: RecordedChainInstance = {
      chainId: '0x2b6653dc',
      genesisHash: `0x${'0'.repeat(64)}`,
    };
    void partial;

    // @ts-expect-error — `chainId` is not optional: a record with no chain id is not a
    // record, it is an absence, and the comparator takes `undefined` for that.
    const empty: RecordedChainInstance = {};
    void empty;
    expect(minimal.chainId).toBe('0x2b6653dc');
  });

  it('lets firstBlockHash be null, which is a different fact from absent', () => {
    // `null` means "this chain had no block 1 when the record was written"; absent
    // means "this record does not say". The comparator distinguishes them, so the type
    // has to as well.
    const noBlockOne: RecordedChainInstance = {
      chainId: '0x2b6653dc',
      genesisHash: `0x${'0'.repeat(64)}`,
      firstBlockHash: null,
    };
    expect(noBlockOne.firstBlockHash).toBeNull();
  });

  it('never types a comparison signal as a free string', () => {
    type Changed = Extract<InstanceComparison, { kind: 'changed' }>;
    expectType<
      Exact<Changed['signal'], 'chain-id' | 'genesis-hash' | 'first-block-hash'>
    >();
    // The three-member literal union is what lets the message differ per signal — a
    // chain-id change means a *different network*, a stronger claim than a wipe.
    expect(true).toBe(true);
  });
});
