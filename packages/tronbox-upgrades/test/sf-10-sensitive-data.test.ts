import util from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  OptionConflictError,
  OptionUnsupportedOnTronError,
  OptionValueError,
  UnknownOptionError,
  renderReceived,
} from '../src/options';
import {
  DegradedNoteInvalidError,
  EngineCallNotSynchronousError,
  EngineCaptureReentrantError,
  captureEngineWarnings,
  createOutputChannel,
} from '../src/output';
import { resetSilenceForTests } from '../src/output/silence';
import {
  HostInstanceSharedError,
  ResultCapabilityUnavailableError,
  TransactionHashUnavailableError,
  UnavailableMemberAbsentError,
  hostSharingGuard,
  installGuarded,
  sealUnavailable,
  transactionIdentity,
  unavailableContractMembers,
} from '../src/results';
import {
  SENTINEL_MNEMONIC,
  SENTINEL_PRIVATE_KEY,
} from './helpers/config-fixtures';
import { tronBoxIsInstalled, tronBoxVersionsUnderTest } from './helpers/locate';
import {
  DEPLOY_PROXY_OPTION_KEYS,
  UPGRADE_OPTION_KEYS,
  addPropStyleTarget,
  channelFacts,
  noopSink,
  proxyTrapNames,
  recordingSink,
  resolveAsJavaScriptCaller,
  sf10Sources,
  sourceNamed,
  tronBoxAbstraction,
} from './helpers/sf-10-fixtures';

/**
 * SF-10 Sensitive Data Handling — SF-10 INV-41 and INV-42.
 *
 * Technique 7, leak probing, with the leak surface SF-10 actually has. SF-10 signs
 * nothing and reads no configuration, so it never *sources* a credential; what it
 * does handle is **host-supplied objects that carry one**. TronBox's contract
 * abstraction is the concrete case: `Object.keys` on it already includes `_json` —
 * the full artifact, bytecode and source map — and the migration's surrounding
 * config holds the network private key. So the property under test is the
 * structural one INV-41 states: *no host-supplied object is ever passed to a
 * formatter, interpolated into a template, or serialized.*
 *
 * That structural form is what makes the guarantee hold for `util.inspect`,
 * `console.log`, template interpolation and own-enumerable traversal alike, because
 * none of those is ever handed a handle. Redaction alone would close
 * `JSON.stringify` and nothing else — which is why the tests below assert **absence
 * at the formatter**, not scrubbing at the output.
 *
 * INV-42 is the same concern from the opposite side: sealing must not *widen* what
 * the host already exposed. The assertions are equalities between the sealed and
 * unsealed handle rather than absolute key counts, because the invariant's content
 * is neutrality, not a number.
 *
 * **The one documented echo** is asserted rather than hidden: a caller's own option
 * *value* is named in the refusal, because INV-10 requires the message to say what
 * was received. See the last test in the INV-41 block.
 */

const installedVersions = tronBoxVersionsUnderTest.filter(tronBoxIsInstalled);

/** Every sentinel a leak probe looks for, in one place. */
const SENTINELS: readonly string[] = Object.freeze([
  SENTINEL_PRIVATE_KEY,
  SENTINEL_MNEMONIC,
]);

function assertSentinelFree(label: string, ...renderings: readonly string[]): void {
  for (const rendering of renderings) {
    for (const sentinel of SENTINELS) {
      expect(
        rendering.includes(sentinel),
        `${label} leaked a sentinel credential`,
      ).toBe(false);
    }
  }
}

/**
 * The placeholder standing in for a field the probe deliberately does not walk.
 */
const RETAINED_BY_DESIGN = '<the caller\'s own value, retained in full per INV-10>';

/**
 * Every rendering channel an error or a note can reach, in one call.
 *
 * A probe that only checked `.message` would miss the channels that actually
 * surface in practice: a `catch` block inspecting the error object, a JSON error
 * report, `Object.getOwnPropertyNames`-based serialization, and the stack.
 *
 * **`omit` exists because INV-41's stated instrument is stronger than INV-41.** The
 * invariant's test line asks for *"`util.inspect` of every error and every note is
 * sentinel-free"*, and that is **false against a correct implementation**: INV-10
 * requires every fact in a message to also be reachable as a structured field, so
 * `OptionValueError.received` holds the caller's value **in full and unrendered**.
 * A caller who passes an object containing their own private key as
 * `constructorArgs` therefore gets that object back on `error.received` — which is
 * their value returned to them, not a credential the plugin sourced. The
 * invariant's *statement* is precise about this and its test line is not: it names
 * "any error **message**, any `DegradedNote` field, or any relayed engine text".
 * Those three are probed without exception; `received` is enumerated at its call
 * site with the reason, and asserted directly in the last INV-41 test.
 */
function everyRendering(
  value: unknown,
  omit: readonly string[] = [],
): readonly string[] {
  const source = (value ?? {}) as Record<string, unknown>;
  const projection: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(source)) {
    projection[key] = omit.includes(key) ? RETAINED_BY_DESIGN : source[key];
  }

  const renderings: string[] = [
    util.inspect(projection, { depth: null }),
    util.inspect(projection, { depth: null, showHidden: true }),
    String((value as { message?: unknown } | null)?.message ?? ''),
    String((value as { stack?: unknown } | null)?.stack ?? ''),
  ];
  try {
    // The projection rather than the value: `getOwnPropertyNames` is a superset of
    // the own-enumerable keys `JSON.stringify` would visit, so this is the stricter
    // channel *and* the one that honours `omit`.
    renderings.push(JSON.stringify(projection) ?? 'undefined');
  } catch {
    // A cyclic or BigInt-bearing value is not serializable; the other channels
    // still cover it, and a throw here is not a leak.
    renderings.push('');
  }
  return renderings;
}

/**
 * A host contract abstraction whose `_json` carries a credential, built the way
 * TronBox builds one.
 *
 * The sentinel is placed where a real one lives: inside the artifact blob the host
 * hangs off the handle, reachable by any traversal and by `util.inspect` — so a
 * formatter that received the handle would surface it without anybody writing an
 * interpolation for it.
 */
function credentialBearingHandle(): Record<string, unknown> {
  return addPropStyleTarget({
    _json: {
      contractName: 'Box',
      bytecode: '0x6080',
      networks: {
        '1': {
          address: 'TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh',
          privateKey: SENTINEL_PRIVATE_KEY,
          mnemonic: SENTINEL_MNEMONIC,
        },
      },
    },
  });
}

afterEach(() => {
  resetSilenceForTests();
});

// ---------------------------------------------------------------------------
// SF-10 INV-41
// ---------------------------------------------------------------------------

describe('SF-10 INV-41: no credential and no host handle is ever formatted into a message, a note, or a relayed warning', () => {
  it('names only the member and the remedy when a sealed handle refuses a read', () => {
    const handle = credentialBearingHandle();
    const sealed = sealUnavailable(handle);

    let thrown: unknown;
    try {
      void (sealed as unknown as { events: unknown }).events;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ResultCapabilityUnavailableError);
    const error = thrown as ResultCapabilityUnavailableError;
    // The structured payload is the member name and the plugin's own limitation
    // text — the target is never captured, so there is nothing for a formatter to
    // walk to.
    expect(error.member).toBe('events');
    expect(error.limitation).toBe(unavailableContractMembers['events']);
    assertSentinelFree(
      'ResultCapabilityUnavailableError',
      ...everyRendering(error),
    );
    expect(Object.getOwnPropertyNames(error)).not.toContain('target');
  });

  it('names only the member and the guard evidence when augmentation is refused', () => {
    const handle = credentialBearingHandle();
    const guard = hostSharingGuard(
      'ResolverIntercept.contracts() enumerates every cached abstraction',
      [handle],
    );

    let thrown: unknown;
    try {
      installGuarded(handle, 'address', { value: 'TAddr' }, guard);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HostInstanceSharedError);
    const error = thrown as HostInstanceSharedError;
    expect(error.member).toBe('address');
    // `evidence` is the *caller's* prose, not a rendering of the target. The guard
    // holds the object set; the error holds neither the guard nor the object.
    expect(error.evidence).not.toContain(SENTINEL_PRIVATE_KEY);
    assertSentinelFree('HostInstanceSharedError', ...everyRendering(error));
  });

  it('names only the member when a registry entry is absent from the host', () => {
    const handle = credentialBearingHandle();
    let thrown: unknown;
    try {
      sealUnavailable(handle, {
        logs: { because: 'the host has none', instead: 'read the receipt' },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnavailableMemberAbsentError);
    expect((thrown as UnavailableMemberAbsentError).member).toBe('logs');
    assertSentinelFree(
      'UnavailableMemberAbsentError',
      ...everyRendering(thrown),
    );
  });

  it('names only the operation when a transaction identity is missing', () => {
    const handle = credentialBearingHandle();
    let thrown: unknown;
    try {
      transactionIdentity(handle, 'deployProxy');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TransactionHashUnavailableError);
    // The offending value is a host handle. It is *not* stored on the error — the
    // only structured field is the operation name.
    expect((thrown as TransactionHashUnavailableError).operation).toBe(
      'deployProxy',
    );
    assertSentinelFree(
      'TransactionHashUnavailableError',
      ...everyRendering(thrown),
    );
  });

  it('names only the channel lineage when a malformed note is refused', () => {
    const credentialBearingSink = {
      privateKey: SENTINEL_PRIVATE_KEY,
      log(): void {
        // A host sink is a host object too, and it can carry anything.
      },
    };
    const channel = createOutputChannel(
      channelFacts(credentialBearingSink, 'config-lineage', true),
    );

    let thrown: unknown;
    try {
      channel.degraded({
        code: 'engine-warning',
        summary: '',
        detail: [],
        remedy: 'do something',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DegradedNoteInvalidError);
    const error = thrown as DegradedNoteInvalidError;
    expect(error.channel).toContain('config-lineage');
    // Provenance is a lineage *name* and a boolean, never the sink object.
    assertSentinelFree('DegradedNoteInvalidError', ...everyRendering(error));
    expect(channel.describe()).not.toContain(SENTINEL_PRIVATE_KEY);
  });

  it('renders a non-string engine write by type alone, never by serializing it', () => {
    /*
     * The relay's own leak channel. Upstream writes exactly one string argument —
     * `dist/utils/log.js:log` builds `parts.join('\n')` and passes it alone,
     * verified present at `@openzeppelin/upgrades-core@1.46.0` — so a non-string
     * argument is not upstream's format and must not be serialized. `String(value)`
     * is deliberately avoided: it invokes a caller-supplied `toString`, which is
     * both a leak channel and a way to make the relay itself throw inside the one
     * code path that must not.
     */
    const channel = createOutputChannel(channelFacts(noopSink()));
    const handle = credentialBearingHandle();
    const leaky = {
      toString: () => SENTINEL_PRIVATE_KEY,
      toJSON: () => SENTINEL_MNEMONIC,
    };

    captureEngineWarnings(channel, 'validate', () => {
      console.error(handle);
      console.error(leaky);
      console.error(Symbol(SENTINEL_MNEMONIC));
      console.error(() => SENTINEL_PRIVATE_KEY);
      console.error(`Warning: an argument was ${SENTINEL_PRIVATE_KEY}`, handle);
    });

    // Rendered by `typeof` alone, one bracketed type name per argument — the
    // credential-bearing handle, the object with two leaky stringifiers, a symbol
    // whose *description* is a credential, and a closure over one.
    expect(channel.recorded.map(note => note.summary)).toEqual([
      '[object]',
      '[object]',
      '[symbol]',
      '[function]',
      // The mixed write: upstream's own string is relayed verbatim per INV-33 — that
      // is upstream's text, not a plugin serialization — and the *host object*
      // beside it is still reduced to its type.
      'an argument was ' + SENTINEL_PRIVATE_KEY + ' [object]',
    ]);
    for (const note of channel.recorded.slice(0, 4)) {
      assertSentinelFree('relayed note', ...everyRendering(note));
    }
  });

  it('never invokes a caller value\'s own stringifiers while rendering `received`', () => {
    const invoked: string[] = [];
    const leaky = {
      privateKey: SENTINEL_PRIVATE_KEY,
      toString(): string {
        invoked.push('toString');
        return SENTINEL_PRIVATE_KEY;
      },
      toJSON(): string {
        invoked.push('toJSON');
        return SENTINEL_MNEMONIC;
      },
      valueOf(): string {
        invoked.push('valueOf');
        return SENTINEL_PRIVATE_KEY;
      },
      [Symbol.toPrimitive](): string {
        invoked.push('Symbol.toPrimitive');
        return SENTINEL_PRIVATE_KEY;
      },
    };

    expect(renderReceived(leaky)).toBe('an object');
    // Not merely "the output happens to be clean": none of the four hooks a
    // formatter would trip was called at all.
    expect(invoked).toEqual([]);

    let thrown: unknown;
    try {
      resolveAsJavaScriptCaller({ kind: leaky }, UPGRADE_OPTION_KEYS);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OptionValueError);
    expect((thrown as OptionValueError).message).toContain('an object');
    expect((thrown as OptionValueError).message).not.toContain(
      SENTINEL_PRIVATE_KEY,
    );
    expect(invoked).toEqual([]);
  });

  it('keeps every message sentinel-free across every enumerated option-failure path', () => {
    const surroundings = {
      privateKey: SENTINEL_PRIVATE_KEY,
      mnemonic: SENTINEL_MNEMONIC,
    };
    const drives: readonly { readonly label: string; readonly run: () => void }[] =
      Object.freeze([
        {
          label: 'unknown key',
          run: () =>
            void resolveAsJavaScriptCaller(
              { unsafeAllowRename: true },
              UPGRADE_OPTION_KEYS,
            ),
        },
        {
          label: 'unknown key carrying a credential-bearing object',
          run: () =>
            void resolveAsJavaScriptCaller(
              { walletConfig: surroundings },
              UPGRADE_OPTION_KEYS,
            ),
        },
        {
          label: 'closed-set value',
          run: () =>
            void resolveAsJavaScriptCaller({ kind: 'Transparent' }, UPGRADE_OPTION_KEYS),
        },
        {
          label: 'unrecognized unsafeAllow member',
          run: () =>
            void resolveAsJavaScriptCaller(
              { unsafeAllow: ['delegate-call'] },
              UPGRADE_OPTION_KEYS,
            ),
        },
        {
          label: 'cross-option contradiction',
          run: () =>
            void resolveAsJavaScriptCaller(
              {
                unsafeAllowLinkedLibraries: false,
                unsafeAllow: ['external-library-linking'],
              },
              UPGRADE_OPTION_KEYS,
            ),
        },
        {
          label: 'numeric bound',
          run: () =>
            void resolveAsJavaScriptCaller({ timeout: -1 }, UPGRADE_OPTION_KEYS),
        },
        {
          label: 'shape: constructorArgs holding a credential-bearing object',
          run: () =>
            void resolveAsJavaScriptCaller(
              { constructorArgs: surroundings },
              UPGRADE_OPTION_KEYS,
            ),
        },
        {
          label: 'shape: initializer',
          run: () =>
            void resolveAsJavaScriptCaller(
              { initializer: '   ' },
              DEPLOY_PROXY_OPTION_KEYS,
            ),
        },
      ]);

    const seen: string[] = [];
    for (const drive of drives) {
      let thrown: unknown;
      try {
        drive.run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${drive.label} did not throw`).toBeInstanceOf(Error);
      seen.push(drive.label);
      // The message, the stack and every structured field **except `received`**.
      // `received` is the caller's own value held in full because INV-10 requires
      // every fact in a message to be reachable as a field, and it is the only field
      // on any of these classes that holds a caller value — asserted below.
      assertSentinelFree(drive.label, ...everyRendering(thrown, ['received']));
      expect(
        (thrown as Error).message,
        `${drive.label} leaked through the message`,
      ).not.toContain(SENTINEL_PRIVATE_KEY);
    }

    // Non-vacuity: every enumerated path actually fired.
    expect(seen).toHaveLength(drives.length);
  });

  it('holds `received` as the only field on any error that carries a caller value', () => {
    /*
     * The exemption above is only sound if it is exactly one field wide. Every
     * enumerated class is constructed and its own fields inspected: all of them are
     * plugin-owned strings, plugin-owned string arrays, or the operation name —
     * except `OptionValueError.received`, which is `unknown` by declaration.
     */
    const surroundings = { privateKey: SENTINEL_PRIVATE_KEY };
    const instances: readonly { readonly error: Error; readonly caller: readonly string[] }[] =
      Object.freeze([
        {
          error: new OptionValueError('kind', surroundings, ['uups']),
          caller: ['received'],
        },
        { error: new UnknownOptionError(['walletConfig'], ['kind']), caller: [] },
        { error: new OptionConflictError(['a', 'b'], 'because', 'instead'), caller: [] },
        {
          error: new OptionUnsupportedOnTronError('txOverrides', 'because', 'instead'),
          caller: [],
        },
        { error: new EngineCallNotSynchronousError('addProxyToManifest'), caller: [] },
        { error: new EngineCaptureReentrantError('getErrors', 'validate'), caller: [] },
        {
          error: new DegradedNoteInvalidError('summary', 'the plugin output channel'),
          caller: [],
        },
        { error: new TransactionHashUnavailableError('deployProxy'), caller: [] },
        { error: new UnavailableMemberAbsentError('logs'), caller: [] },
        {
          error: new HostInstanceSharedError('address', 'the migration owns it'),
          caller: [],
        },
        {
          error: new ResultCapabilityUnavailableError(
            'events',
            unavailableContractMembers['events']!,
          ),
          caller: [],
        },
      ]);

    for (const { error, caller } of instances) {
      const fields = Object.getOwnPropertyNames(error).filter(
        name => name !== 'message' && name !== 'stack',
      );
      for (const field of fields) {
        const held = (error as unknown as Record<string, unknown>)[field];
        if (caller.includes(field)) {
          continue;
        }
        // Plugin-owned: a string, a boolean, a frozen string array, or a frozen
        // plugin-authored record. Never a host or caller object.
        const kind =
          typeof held === 'string'
            ? 'string'
            : Array.isArray(held)
              ? 'string[]'
              : held === null
                ? 'null'
                : typeof held;
        expect(
          ['string', 'string[]', 'null', 'object'],
          `${error.name}.${field} holds an unexpected ${kind}`,
        ).toContain(kind);
        assertSentinelFree(`${error.name}.${field}`, util.inspect(held));
      }
    }
    expect(instances).toHaveLength(11);
  });

  it('keeps the two errors constructible-only paths sentinel-free as well', () => {
    // `OptionUnsupportedOnTronError` has no v1 instance (INV-14) and the two engine
    // errors are only reachable through the window, so they are driven directly
    // here — a leak probe that skipped them would leave two of the enumerated
    // classes unprobed.
    const errors: readonly Error[] = Object.freeze([
      new OptionUnsupportedOnTronError('txOverrides', 'because', 'instead'),
      new UnknownOptionError(['walletConfig'], UPGRADE_OPTION_KEYS),
      new OptionConflictError(['a', 'b'], 'because', 'instead'),
      new EngineCallNotSynchronousError('addProxyToManifest'),
      new EngineCaptureReentrantError('getErrors', 'validate'),
    ]);
    for (const error of errors) {
      assertSentinelFree(error.name, ...everyRendering(error));
    }
    expect(errors).toHaveLength(5);
  });

  it('interpolates only plugin-owned values — no host object reaches a template', () => {
    /*
     * The structural half, and the one channel a serialization sweep provably
     * cannot cover: template interpolation invokes `toString` and is invisible to a
     * `toJSON` probe. Collected from the AST, so a new interpolation of a
     * host-typed value is a failing test rather than a review item.
     *
     * The forbidden set is every identifier in the three directories that binds a
     * host-supplied or caller-supplied object.
     */
    const hostBound: readonly string[] = Object.freeze([
      'target',
      'proxyTarget',
      'handle',
      'sink',
      'logger',
      'facts',
      'supplied',
      'options',
      'note',
      'received',
      'value',
      'arg',
      'args',
      'captured',
      'descriptor',
      'hostObjects',
      'registry',
      'resolved',
      'validation',
      'validationInput',
      'channel',
    ]);
    /**
     * Interpolations that mention a host-bound identifier but read only a
     * plugin-owned primitive off it, each with the reason it is safe.
     */
    const sanctioned: readonly string[] = Object.freeze([
      // A lineage name from a two-member union, and a boolean. Never the sink.
      'facts.origin',
      'String(facts.hostQuietRequested)',
      // The bounded type-only renderer — INV-13. This is the only route by which a
      // caller value influences a message at all.
      'renderReceived(received)',
      // A *type name*, never the value: `typeof arg` is one of eight strings.
      'typeof arg',
      // Guarded by `Array.isArray` and wrapped in try/catch; a number.
      'String(value.length)',
      // `typeof value === 'bigint'` has already narrowed this to a primitive.
      'value.toString()',
      // The plugin's own limitation prose, from its own frozen registry.
      'limitation.because',
      'limitation.instead',
      // `describe()`'s output — a plugin-composed string, not the channel object.
      'channel',
    ]);

    const offending = sf10Sources().flatMap(source =>
      source.templateExpressions
        .filter(
          expression =>
            !sanctioned.includes(expression) &&
            hostBound.some(name =>
              new RegExp(`\\b${name}\\b`).test(expression),
            ),
        )
        .map(expression => `${source.relative}: \${${expression}}`),
    );
    expect(offending).toEqual([]);

    // Non-vacuity: the scan is reading real interpolations, and the sanctioned list
    // is not dead weight.
    const allExpressions = sf10Sources().flatMap(
      source => source.templateExpressions,
    );
    expect(allExpressions.length).toBeGreaterThan(30);
    for (const entry of sanctioned) {
      expect(allExpressions, `sanctioned entry '${entry}' is stale`).toContain(
        entry,
      );
    }
  });

  it('echoes a caller\'s own option value verbatim, which is the one place a secret can appear', () => {
    /*
     * **The documented boundary, made executable rather than assumed.**
     *
     * INV-41's subject is credentials the *plugin* has access to — the network
     * private key in the host's config, the mnemonic, the artifact blob. SF-10
     * reads none of them, which is why every assertion above is an absence.
     *
     * What SF-10 *does* echo is the caller's own option value, because INV-10
     * requires the refusal to name what was received — and a caller who writes their
     * private key where a proxy kind belongs gets it named back to them. That is not
     * a plugin leak, it is a diagnostic the caller asked for by supplying the value,
     * and redacting it would break INV-10 for every legitimate case. Asserted here
     * so the boundary is a recorded decision rather than a surprise.
     */
    let thrown: unknown;
    try {
      resolveAsJavaScriptCaller(
        { kind: SENTINEL_PRIVATE_KEY },
        UPGRADE_OPTION_KEYS,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OptionValueError);
    expect((thrown as OptionValueError).message).toContain(SENTINEL_PRIVATE_KEY);
    expect((thrown as OptionValueError).received).toBe(SENTINEL_PRIVATE_KEY);

    // And the boundary is exactly there: the same credential inside a *non-string*
    // caller value is rendered by type alone and does not reach the message — it
    // remains on `received`, unrendered, which is what INV-10 asks for.
    let second: unknown;
    try {
      resolveAsJavaScriptCaller(
        { kind: { privateKey: SENTINEL_PRIVATE_KEY } },
        UPGRADE_OPTION_KEYS,
      );
    } catch (error) {
      second = error;
    }
    expect((second as OptionValueError).message).not.toContain(
      SENTINEL_PRIVATE_KEY,
    );
    expect((second as OptionValueError).message).toContain('an object');
    expect(
      util.inspect((second as OptionValueError).received, { depth: null }),
    ).toContain(SENTINEL_PRIVATE_KEY);
    // Stated as the recorded consequence: the value is on the field, so a caller
    // that logs a whole caught error logs their own value back. The plugin's
    // obligation is not to *render* it, and that is what holds.
    assertSentinelFree(
      'the message and stack of a caller-value refusal',
      (second as Error).message,
      String((second as Error).stack),
    );
  });
});

// ---------------------------------------------------------------------------
// SF-10 INV-42
// ---------------------------------------------------------------------------

describe('SF-10 INV-42: sealing does not widen the handle\'s exposure', () => {
  it('declares exactly one trap, and it is `get`', () => {
    // The instrument has to be about which traps *exist*: a behavioural check can
    // only observe the ones that were written, never the ones that were not.
    expect(proxyTrapNames(sourceNamed('results/limitations.ts'))).toEqual(['get']);
    // And no other module in the three directories builds a proxy at all, so the
    // one handler is the whole surface.
    const allTraps = sf10Sources().flatMap(source => proxyTrapNames(source));
    expect(allTraps).toEqual(['get']);
  });

  it('exposes exactly the keys the host handle exposed', () => {
    const target = credentialBearingHandle();
    const sealed = sealUnavailable(target);

    expect(Object.keys(sealed)).toEqual(Object.keys(target));
    expect(Reflect.ownKeys(sealed)).toEqual(Reflect.ownKeys(target));
    expect(Object.keys({ ...sealed })).toEqual(Object.keys({ ...target }));
    expect(Object.getOwnPropertyNames(sealed)).toEqual(
      Object.getOwnPropertyNames(target),
    );
    // Non-vacuity floor: the fixture has keys, so an equality between two empty
    // lists cannot be what passed.
    expect(Object.keys(target).length).toBeGreaterThan(2);
  });

  it('keeps `events` truthful in shape even though the read refuses', () => {
    const target = credentialBearingHandle();
    const sealed = sealUnavailable(target);

    // `in` is `[[Has]]`, which has no trap — so the shape stays honest: the member
    // is there, and reaching it is what refuses.
    expect('events' in sealed).toBe(true);
    expect(Reflect.has(sealed, 'events')).toBe(true);
    // A member the host never had stays absent rather than becoming a refusal.
    expect('logs' in sealed).toBe(false);
    expect(() => void (sealed as unknown as { events: unknown }).events).toThrow(
      ResultCapabilityUnavailableError,
    );
  });

  it('adds no enumerable member and changes no descriptor', () => {
    const target = credentialBearingHandle();
    const sealed = sealUnavailable(target);

    for (const key of Reflect.ownKeys(target)) {
      expect(
        Object.getOwnPropertyDescriptor(sealed, key),
        `descriptor for ${String(key)} changed`,
      ).toEqual(Object.getOwnPropertyDescriptor(target, key));
    }
    expect(Object.getPrototypeOf(sealed)).toBe(Object.getPrototypeOf(target));
    expect(Object.isExtensible(sealed)).toBe(Object.isExtensible(target));
    // `events` stays non-enumerable, so no serializer starts seeing it.
    expect(
      Object.getOwnPropertyDescriptor(sealed, 'events')?.enumerable,
    ).toBe(false);
  });

  it('leaves every serialization channel behaving exactly as it did unsealed', () => {
    const target = credentialBearingHandle();
    const sealed = sealUnavailable(target);

    // Subtractive-on-read, neutral-on-shape: the pre-existing `_json` exposure is
    // neither amplified nor concealed by sealing. Asserting *equality* is the
    // honest form — claiming the sealed handle hides the artifact would be a
    // guarantee the mechanism does not make.
    expect(JSON.stringify(sealed)).toBe(JSON.stringify(target));
    expect(util.inspect(sealed, { depth: null })).toBe(
      util.inspect(target, { depth: null }),
    );
    expect(() => JSON.stringify(sealed)).not.toThrow();
    expect(() => util.inspect(sealed, { depth: null })).not.toThrow();
    expect(JSON.stringify(sealed)).toContain(SENTINEL_PRIVATE_KEY);
    expect(JSON.stringify(target)).toContain(SENTINEL_PRIVATE_KEY);
  });

  it('forwards a write to the target rather than trapping it', () => {
    // No `set` trap, so assignment behaves as it does on the host handle. Asserted
    // because a `set` trap that silently dropped writes would be a *behaviour*
    // change dressed as a limitation.
    const target = addPropStyleTarget();
    const sealed = sealUnavailable(target);

    Reflect.set(sealed, 'someLaterField', 'written');
    expect(Reflect.get(target, 'someLaterField')).toBe('written');
    expect(Object.keys(sealed)).toEqual(Object.keys(target));
  });

  it('refuses with a message naming the member and the remedy only', () => {
    const target = credentialBearingHandle();
    const sealed = sealUnavailable(target);

    let thrown: unknown;
    try {
      void (sealed as unknown as { events: unknown }).events;
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    expect(message).toContain('events');
    expect(message).toContain('transaction receipt');
    // Never the target's internals — no bytecode, no artifact, no key.
    expect(message).not.toContain('_json');
    expect(message).not.toContain('0x6080');
    assertSentinelFree('refusal message', message);
  });

  it.each(installedVersions)(
    'holds on a real %s abstraction, sealed and unsealed alike',
    installName => {
      const target = tronBoxAbstraction(installName);
      const sealed = sealUnavailable(target);

      expect(Object.keys(sealed)).toEqual(Object.keys(target));
      expect(Object.keys(sealed).length).toBeGreaterThan(15);
      // `_json` is already own-enumerable on the host's own handle, which is the
      // reason INV-42's neutrality matters more than it looks.
      expect(Object.keys(target)).toContain('_json');
      expect('events' in sealed).toBe(true);
      expect('logs' in sealed).toBe(false);
      expect(Reflect.ownKeys(sealed)).toEqual(Reflect.ownKeys(target));
      expect(() => util.inspect(sealed)).not.toThrow();
      expect(() => JSON.stringify(sealed)).not.toThrow();
      expect(Object.getPrototypeOf(sealed)).toBe(Object.getPrototypeOf(target));
      expect(() => void (sealed as unknown as { events: unknown }).events).toThrow(
        ResultCapabilityUnavailableError,
      );
    },
  );

  it('drives both installed minors, so the per-minor claim is not vacuous', () => {
    expect(installedVersions).toEqual(['tronbox-4.9.0', 'tronbox-4.8.0']);
  });

  it('does not leak the target through the channel when a note describes a refusal', () => {
    // The realistic composition: an operation catches a refusal and records a note
    // about it. The note is built from plugin values, so the handle never reaches
    // the channel.
    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));
    const sealed = sealUnavailable(credentialBearingHandle());

    try {
      void (sealed as unknown as { events: unknown }).events;
    } catch (error) {
      channel.degraded({
        code: 'engine-warning',
        summary: `a capability was refused: ${
          (error as ResultCapabilityUnavailableError).member
        }`,
        detail: [(error as ResultCapabilityUnavailableError).limitation.instead],
        remedy: 'read the receipt for the transaction hash on the result',
      });
    }

    expect(channel.recorded).toHaveLength(1);
    assertSentinelFree('recorded note', ...everyRendering(channel.recorded[0]));
    assertSentinelFree('sink write', ...sink.calls.map(args => String(args[0])));
  });
});
