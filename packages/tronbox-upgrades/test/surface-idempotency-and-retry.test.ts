import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  engineValidationOptions,
  requireProxyKind,
  resolveInitializer,
  resolveUpgradeOptions,
} from '../src/options';
import { createOutputChannel, silenceWarnings } from '../src/output';
import { resetSilenceForTests } from '../src/output/silence';
import { sealUnavailable, transactionIdentity } from '../src/results';
import {
  ACCUMULATING_UNSAFE_ALLOW,
  NON_ACCUMULATING_UNSAFE_ALLOW,
  UPGRADE_OPTION_KEYS,
  addPropStyleTarget,
  channelFacts,
  recordingSink,
  resolveAsJavaScriptCaller,
  sf10Sources,
  upstreamOverrides,
  validNote,
} from './helpers/surface-fixtures';
import { valueIdentifierNames } from './helpers/source-scan';

/**
 * Idempotency & Retry for the option/result surface — resolution purity, the
 * copy-in/freeze-out boundary at the engine, and the silence flag's lifecycle.
 *
 * Technique: replay. Every test drives the same input twice and compares, or
 * drives the plugin's boundary and then compares the caller's own object against a
 * `structuredClone` snapshot taken before the first call.
 *
 * **The fixture choice in this file is load-bearing and is the reason the whole
 * category could pass vacuously.** Upstream's aliasing only bites when a *derived*
 * flag is truthy. Verified by execution against `@openzeppelin/upgrades-core@1.46.0`:
 *
 * - `{ unsafeAllow: ['constructor'] }` — one call leaves `['constructor']`, two
 *   calls leave `['constructor']`. **Nothing accumulates.** A test written on this
 *   fixture passes whether or not the plugin copies anything.
 * - `{ unsafeAllow: ['external-library-linking'] }` — one call leaves **two**
 *   members, two calls leave **three**. This is also the opt-out v1 ships, so it is
 *   what a real caller writes.
 * - `{ unsafeAllow: ['struct-definition', 'enum-definition'] }` — two members
 *   become four, then six.
 *
 * So every aliasing assertion below uses an accumulating fixture, and the
 * non-accumulating one appears exactly once — as a negative control proving the
 * detector is a detector.
 */

beforeEach(() => {
  resetSilenceForTests();
});

afterEach(() => {
  resetSilenceForTests();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// resolveUpgradeOptions is pure and idempotent, and leaves the caller
// byte-identical
// ---------------------------------------------------------------------------

describe('resolveUpgradeOptions is pure and idempotent, and leaves the caller byte-identical', () => {
  it('yields deep-equal results twice and leaves the caller unchanged, on the accumulating fixture', () => {
    const supplied = {
      kind: 'uups',
      unsafeAllow: [...ACCUMULATING_UNSAFE_ALLOW],
      constructorArgs: [1, { nested: true }],
      timeout: 30_000,
    };
    const snapshot = structuredClone(supplied);

    const first = resolveAsJavaScriptCaller(supplied, UPGRADE_OPTION_KEYS);
    const second = resolveAsJavaScriptCaller(supplied, UPGRADE_OPTION_KEYS);

    expect(second).toEqual(first);
    // Array *length* is the direct detector — upstream's `push` is what a
    // shallow deep-equal on scalars alone would miss.
    expect(supplied.unsafeAllow).toHaveLength(snapshot.unsafeAllow.length);
    expect(supplied).toEqual(snapshot);
    expect(supplied.constructorArgs).toHaveLength(2);
  });

  it('is unaffected by the number of resolutions, up to ten', () => {
    const supplied = { unsafeAllow: [...ACCUMULATING_UNSAFE_ALLOW] };
    const snapshot = structuredClone(supplied);
    const results = Array.from({ length: 10 }, () =>
      resolveAsJavaScriptCaller(supplied, UPGRADE_OPTION_KEYS),
    );
    for (const result of results) {
      expect(result).toEqual(results[0]);
    }
    expect(supplied).toEqual(snapshot);
  });

  it('detects the aliasing it exists to prevent — the fixture is a real detector', () => {
    /*
     * The non-vacuity proof, run against upstream directly. Without the plugin's
     * copy this is what a caller's object looks like after two engine calls, and
     * the shape of it is why the plugin owns every array crossing the boundary.
     *
     * `withValidationDefaults` aliases `opts.unsafeAllow`
     * (`const unsafeAllow = opts.unsafeAllow ?? []`) and then pushes into it. On a
     * migration that reuses one options literal across `deployProxy` and a later
     * `upgradeProxy` — the ordinary pattern — the second call sees an allowance
     * list the author never wrote, and under `tronbox test`'s full replay it
     * happens on every run.
     */
    const { withValidationDefaults } = upstreamOverrides();

    const callerOwned = { unsafeAllow: [...ACCUMULATING_UNSAFE_ALLOW] };
    withValidationDefaults(callerOwned);
    expect(callerOwned.unsafeAllow).toHaveLength(2);
    withValidationDefaults(callerOwned);
    expect(callerOwned.unsafeAllow).toHaveLength(3);
    expect(callerOwned.unsafeAllow).toEqual([
      'external-library-linking',
      'external-library-linking',
      'external-library-linking',
    ]);

    // And the same drive through the plugin does not accumulate — which is the
    // property, now asserted against a fixture proved capable of failing.
    const throughPlugin = { unsafeAllow: [...ACCUMULATING_UNSAFE_ALLOW] };
    resolveAsJavaScriptCaller(throughPlugin, UPGRADE_OPTION_KEYS);
    resolveAsJavaScriptCaller(throughPlugin, UPGRADE_OPTION_KEYS);
    expect(throughPlugin.unsafeAllow).toEqual([...ACCUMULATING_UNSAFE_ALLOW]);
  });

  it('would pass vacuously on the non-accumulating fixture, which is why that one is not used', () => {
    /*
     * The negative control, kept as an executable statement rather than a comment.
     * `['constructor']` drives no derived flag, so upstream pushes nothing and the
     * caller's array is byte-identical after two calls **even with no plugin copy
     * at all**. This is the assertion that says so, and it is the reason
     * `ACCUMULATING_UNSAFE_ALLOW` is a named constant.
     */
    const { withValidationDefaults } = upstreamOverrides();
    const callerOwned = { unsafeAllow: [...NON_ACCUMULATING_UNSAFE_ALLOW] };
    withValidationDefaults(callerOwned);
    withValidationDefaults(callerOwned);
    expect(callerOwned.unsafeAllow).toEqual([...NON_ACCUMULATING_UNSAFE_ALLOW]);
  });

  it('accumulates fastest on the two-member custom-types fixture, so that one is covered too', () => {
    const { withValidationDefaults } = upstreamOverrides();
    const callerOwned = {
      unsafeAllow: ['struct-definition', 'enum-definition'],
    };
    withValidationDefaults(callerOwned);
    expect(callerOwned.unsafeAllow).toHaveLength(4);

    const throughPlugin = { unsafeAllow: ['struct-definition', 'enum-definition'] };
    resolveAsJavaScriptCaller(throughPlugin, UPGRADE_OPTION_KEYS);
    resolveAsJavaScriptCaller(throughPlugin, UPGRADE_OPTION_KEYS);
    expect(throughPlugin.unsafeAllow).toEqual(['struct-definition', 'enum-definition']);
  });

  it('leaves resolveInitializer and requireProxyKind pure as well', () => {
    // Both are covered by the purity guarantee above, and both are total
    // functions over primitives — so the property to check is that repeated
    // calls agree and nothing observable changes.
    for (const argCount of [0, 1, 5]) {
      expect(resolveInitializer(undefined, argCount)).toEqual(
        resolveInitializer(undefined, argCount),
      );
    }
    expect(resolveInitializer(false, 3)).toEqual({ kind: 'none' });
    expect(resolveInitializer(undefined, 0)).toEqual({ kind: 'none' });
    expect(resolveInitializer(undefined, 1)).toEqual({ kind: 'call', fn: 'initialize' });
    expect(resolveInitializer('setUp', 0)).toEqual({ kind: 'call', fn: 'setUp' });

    const allowed = ['uups', 'transparent'] as const;
    const allowedSnapshot = [...allowed];
    requireProxyKind('uups', allowed, 'deployProxy');
    requireProxyKind('uups', allowed, 'deployProxy');
    expect([...allowed]).toEqual(allowedSnapshot);
  });

  it('reads no ambient state, so a replay resolves to the same value by construction', () => {
    /*
     * The structural half of purity, and the reason the option/result surface
     * declares no replay disposition: a default quietly sourced from an
     * environment variable would make a replay resolve differently from the
     * original run with no diagnostic.
     */
    for (const source of sf10Sources()) {
      const values = valueIdentifierNames(source);
      for (const forbidden of ['process', 'Date', 'fetch', 'setTimeout', 'setInterval']) {
        expect(
          values.filter(name => name === forbidden),
          `${source.relative} must not reference ${forbidden}`,
        ).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// arrays are copied inbound to upstream and frozen outbound to the caller
// ---------------------------------------------------------------------------

describe('arrays are copied inbound to upstream and frozen outbound to the caller', () => {
  it('is unaffected by the caller mutating their array after resolution', () => {
    const unsafeAllow = [...ACCUMULATING_UNSAFE_ALLOW];
    const constructorArgs: unknown[] = [1, 2];
    const resolved = resolveAsJavaScriptCaller(
      { unsafeAllow, constructorArgs },
      UPGRADE_OPTION_KEYS,
    );
    const beforeAllow = [...resolved.validation.unsafeAllow];
    const beforeArgs = [...resolved.constructorArgs];

    unsafeAllow.push('selfdestruct');
    constructorArgs.push(3);

    expect(resolved.validation.unsafeAllow).toEqual(beforeAllow);
    expect(resolved.constructorArgs).toEqual(beforeArgs);
    expect(resolved.constructorArgs).toHaveLength(2);
  });

  it('freezes every outbound array', () => {
    const resolved = resolveAsJavaScriptCaller(
      { unsafeAllow: [...ACCUMULATING_UNSAFE_ALLOW], constructorArgs: [1] },
      UPGRADE_OPTION_KEYS,
    );
    expect(Object.isFrozen(resolved.constructorArgs)).toBe(true);
    expect(Object.isFrozen(resolved.validation.unsafeAllow)).toBe(true);

    const channel = createOutputChannel(channelFacts(recordingSink()));
    const note = channel.degraded(validNote());
    expect(Object.isFrozen(note.detail)).toBe(true);
    expect(Object.isFrozen(channel.recorded)).toBe(true);
  });

  it('shares the default constructorArgs by reference, and it is frozen', () => {
    // A shared frozen empty array is the right shape for a default: no allocation
    // per resolution, and no way for one caller's mutation to reach another's.
    const first = resolveAsJavaScriptCaller({}, UPGRADE_OPTION_KEYS);
    const second = resolveAsJavaScriptCaller({}, UPGRADE_OPTION_KEYS);
    expect(first.constructorArgs).toBe(second.constructorArgs);
    expect(Object.isFrozen(first.constructorArgs)).toBe(true);
  });

  it('copies one level and no deeper, so element identity is preserved', () => {
    // The shallow-copy rule, observed from this boundary's side: the copy
    // exists to stop upstream's `push`, not to clone caller data. A deep clone
    // would break identity for a caller passing a contract handle as a
    // constructor argument.
    const element = { nested: { deep: true } };
    const resolved = resolveAsJavaScriptCaller(
      { constructorArgs: [element] },
      UPGRADE_OPTION_KEYS,
    );
    expect(resolved.constructorArgs[0]).toBe(element);
  });
});

// ---------------------------------------------------------------------------
// the one sanctioned upstream boundary
// ---------------------------------------------------------------------------

describe('engineValidationOptions is the only sanctioned way to reach the engine', () => {
  /*
   * **The conflict this resolves, reproduced by execution at
   * `@openzeppelin/upgrades-core@1.46.0`.** The freeze on `validation.unsafeAllow`
   * and the copy-in/freeze-out rule above both apply here; the specified flow
   * hands that same object to the engine. `processExceptions` — reached from
   * `getErrors` and therefore from `assertUpgradeSafe` — opens with
   * `withValidationDefaults(opts)`, aliases `opts.unsafeAllow`, and pushes into
   * it whenever a derived flag is truthy. So passing `resolved.validation`
   * directly throws, and it throws for exactly the callers who set an expert
   * opt-out.
   *
   * Both guarantees are non-negotiable and they are compatible only if the fresh
   * copy has a single home. The freeze **stays**, because it turns a call site
   * that forgets into a loud failure at the boundary rather than a silent
   * accumulation of allowances the author never wrote.
   */
  it('throws when the frozen resolved value is handed to the engine directly', () => {
    const { processExceptions } = upstreamOverrides();
    const resolved = resolveAsJavaScriptCaller(
      { unsafeAllow: [...ACCUMULATING_UNSAFE_ALLOW] },
      UPGRADE_OPTION_KEYS,
    );
    expect(Object.isFrozen(resolved.validation.unsafeAllow)).toBe(true);

    let thrown: unknown;
    try {
      processExceptions('Box', [], resolved.validation);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message).toContain('not extensible');
  });

  it('throws on the derived-flag route too, not only on the array route', () => {
    // `unsafeAllowCustomTypes: true` reaches the same `push` with an *empty*
    // frozen array, so the refusal is about the freeze rather than about the
    // array's contents. Verified by execution: `Cannot add property 0, object is
    // not extensible`.
    const { processExceptions } = upstreamOverrides();
    const resolved = resolveAsJavaScriptCaller(
      { unsafeAllowCustomTypes: true },
      UPGRADE_OPTION_KEYS,
    );
    expect(() => processExceptions('Box', [], resolved.validation)).toThrow(TypeError);
  });

  it('would pass vacuously with a non-triggering allowance, which is why that fixture is not used', () => {
    /*
     * The second negative control, and the more dangerous of the two: with
     * `['constructor']` the derived flags stay false, upstream never pushes, and
     * `processExceptions` on a **frozen** array succeeds. A test for this
     * boundary written on this fixture would assert that no boundary is needed.
     */
    const { processExceptions } = upstreamOverrides();
    const resolved = resolveAsJavaScriptCaller(
      { unsafeAllow: [...NON_ACCUMULATING_UNSAFE_ALLOW] },
      UPGRADE_OPTION_KEYS,
    );
    expect(() => processExceptions('Box', [], resolved.validation)).not.toThrow();
  });

  it('succeeds through the boundary, twice, and leaves the resolved value byte-identical', () => {
    const { processExceptions } = upstreamOverrides();
    const resolved = resolveAsJavaScriptCaller(
      { unsafeAllow: [...ACCUMULATING_UNSAFE_ALLOW] },
      UPGRADE_OPTION_KEYS,
    );
    const before = structuredClone({
      validation: { ...resolved.validation, unsafeAllow: [...resolved.validation.unsafeAllow] },
      constructorArgs: [...resolved.constructorArgs],
      redeployImplementation: resolved.redeployImplementation,
      timeout: resolved.timeout,
      pollingInterval: resolved.pollingInterval,
    });

    expect(() => processExceptions('Box', [], engineValidationOptions(resolved))).not.toThrow();
    expect(() => processExceptions('Box', [], engineValidationOptions(resolved))).not.toThrow();

    expect(resolved.validation.unsafeAllow).toEqual(before.validation.unsafeAllow);
    expect(resolved.timeout).toBe(before.timeout);
    expect(Object.isFrozen(resolved.validation.unsafeAllow)).toBe(true);
  });

  it('carries upstream\'s normalized form once, and it does not grow with engine calls', () => {
    /*
     * An observation worth stating rather than leaving for a reader to trip over.
     * `buildResolved` calls `withValidationDefaults` on the plugin's **own** fresh
     * copy, and that call derives `unsafeAllowLinkedLibraries` from
     * `unsafeAllow.includes('external-library-linking')` and then pushes the
     * member back in — so the frozen `resolved.validation.unsafeAllow` holds the
     * member **twice**. That is upstream's canonical form applied exactly once,
     * inside an array the plugin owns, and it is a recorded rule that upstream
     * owns these six defaults by construction. It is harmless downstream
     * (`processExceptions` asks `includes`), and the two properties that matter
     * are asserted here: the caller's array is untouched, and repeated engine
     * calls do not make the resolved value grow.
     */
    const { processExceptions } = upstreamOverrides();
    const callerOwned = { unsafeAllow: [...ACCUMULATING_UNSAFE_ALLOW] };
    const resolved = resolveAsJavaScriptCaller(callerOwned, UPGRADE_OPTION_KEYS);

    expect(callerOwned.unsafeAllow).toHaveLength(1);
    expect(resolved.validation.unsafeAllow).toEqual([
      'external-library-linking',
      'external-library-linking',
    ]);
    expect(resolved.validation.unsafeAllowLinkedLibraries).toBe(true);

    for (let call = 0; call < 5; call += 1) {
      processExceptions('Box', [], engineValidationOptions(resolved));
    }
    expect(resolved.validation.unsafeAllow).toHaveLength(2);
    expect(callerOwned.unsafeAllow).toHaveLength(1);

    // And a second resolution of the same caller object lands on the same value —
    // the normalization is applied once per resolution, not cumulatively.
    const again = resolveAsJavaScriptCaller(callerOwned, UPGRADE_OPTION_KEYS);
    expect(again.validation.unsafeAllow).toEqual(resolved.validation.unsafeAllow);
  });

  it('returns a fresh object with a fresh array on every call', () => {
    const resolved = resolveAsJavaScriptCaller(
      { unsafeAllow: [...ACCUMULATING_UNSAFE_ALLOW] },
      UPGRADE_OPTION_KEYS,
    );
    const first = engineValidationOptions(resolved);
    const second = engineValidationOptions(resolved);

    expect(first).not.toBe(second);
    expect(first.unsafeAllow).not.toBe(second.unsafeAllow);
    expect(first.unsafeAllow).not.toBe(resolved.validation.unsafeAllow);
    expect(first).toEqual(second);
    // The copy is not frozen — it exists precisely so upstream can push into it.
    expect(Object.isFrozen(first.unsafeAllow)).toBe(false);
    // And it carries all six members upstream demands.
    expect(Object.keys(first).sort()).toEqual([
      'kind',
      'unsafeAllow',
      'unsafeAllowCustomTypes',
      'unsafeAllowLinkedLibraries',
      'unsafeAllowRenames',
      'unsafeSkipStorageCheck',
    ]);
  });

  it('lets two engine calls accumulate only inside their own copies', () => {
    // The point of a *fresh* copy per call rather than one copy reused: two engine
    // calls must not see each other's derived pushes.
    const resolved = resolveAsJavaScriptCaller(
      { unsafeAllow: [...ACCUMULATING_UNSAFE_ALLOW] },
      UPGRADE_OPTION_KEYS,
    );
    const { processExceptions } = upstreamOverrides();
    const first = engineValidationOptions(resolved);
    processExceptions('Box', [], first);
    const second = engineValidationOptions(resolved);
    processExceptions('Box', [], second);
    // Each copy starts from the resolved value's two members and takes upstream's
    // one push, so both land on three — and neither sees the other's.
    expect(first.unsafeAllow).toHaveLength(3);
    expect(second.unsafeAllow).toHaveLength(3);
    expect(first.unsafeAllow).not.toBe(second.unsafeAllow);
    // The resolved value is the fixed point: it never grows, however many engine
    // calls run against it. Without a fresh copy per call this would be 4.
    expect(resolved.validation.unsafeAllow).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// the silence flag is process-global and monotonic, and a channel does not
// capture it
// ---------------------------------------------------------------------------

describe('the silence flag is process-global and monotonic, and a channel does not capture it', () => {
  it('suppresses a channel created before the call', () => {
    /*
     * The ordering that matters, and the reason a per-channel flag cannot work:
     * `silenceWarnings()` is called at migration top level — before any operation,
     * and therefore before any channel exists — so a flag captured at construction
     * time would make the documented control a no-op for exactly the call pattern
     * the parity target documents.
     */
    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));
    channel.warn('before silencing');
    expect(sink.calls).toHaveLength(1);

    silenceWarnings();
    channel.warn('after silencing');
    expect(sink.calls).toHaveLength(1);
  });

  it('suppresses a channel created after the call', () => {
    silenceWarnings();
    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));
    channel.warn('never written');
    channel.note('never written either');
    expect(sink.calls).toEqual([]);
  });

  it('stays set for the life of the process, so it is monotonic', () => {
    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));
    silenceWarnings();
    silenceWarnings();
    channel.warn('one');
    channel.warn('two');
    expect(sink.calls).toEqual([]);
  });

  it('is re-read after a reset, and the reset is reachable only by deep import', () => {
    /*
     * `resetSilenceForTests` exists because the flag is process-global and the
     * suite is not. It is deliberately absent from `output/index.ts`, so
     * reaching it needs `src/output/silence` — the same shape as the Hardhat
     * sibling's `setNamespacedWarningSink`.
     */
    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));
    silenceWarnings();
    channel.warn('suppressed');
    expect(sink.calls).toHaveLength(0);

    resetSilenceForTests();
    channel.warn('written again');
    expect(sink.calls).toHaveLength(1);
  });

  it('copies the flag into no channel state', () => {
    // Two channels either side of the call behave identically, which is only
    // possible if neither holds a copy.
    const before = recordingSink();
    const channelBefore = createOutputChannel(channelFacts(before));
    silenceWarnings();
    const after = recordingSink();
    const channelAfter = createOutputChannel(channelFacts(after));

    channelBefore.warn('x');
    channelAfter.warn('x');
    expect(before.calls).toEqual([]);
    expect(after.calls).toEqual([]);

    resetSilenceForTests();
    channelBefore.warn('y');
    channelAfter.warn('y');
    expect(before.calls).toHaveLength(1);
    expect(after.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// declares no replay disposition, because it changes no state
// ---------------------------------------------------------------------------

describe('the option/result surface declares no replay disposition, because it changes no state', () => {
  it('resolves every fixture with the clock, the timers and the network sabotaged', () => {
    /*
     * The ambient-stub run. `process.env` is replaced by a throwing `Proxy`, and
     * `Date.now`, `setTimeout`, `setInterval` and `fetch` by throwing stubs — so
     * any ambient read becomes a thrown error rather than a subtle difference.
     *
     * Nothing inside the sabotaged region asserts: `expect` itself may read a
     * clock, which would attribute vitest's own behaviour to the plugin. Outcomes
     * are collected and the assertions run after restoration.
     */
    const savedEnv = process.env;
    const savedNow = Date.now;
    const savedTimeout = globalThis.setTimeout;
    const savedInterval = globalThis.setInterval;
    const savedFetch = globalThis.fetch;

    const outcomes: { readonly label: string; readonly error: unknown }[] = [];
    const drive = (label: string, run: () => unknown): void => {
      try {
        run();
        outcomes.push({ label, error: undefined });
      } catch (error) {
        outcomes.push({ label, error });
      }
    };

    try {
      Object.defineProperty(process, 'env', {
        configurable: true,
        value: new Proxy(
          {},
          {
            get(_target, property) {
              throw new Error(`ambient read of process.env.${String(property)}`);
            },
            has() {
              throw new Error('ambient probe of process.env');
            },
          },
        ),
      });
      Date.now = () => {
        throw new Error('ambient clock read');
      };
      Reflect.set(globalThis, 'setTimeout', () => {
        throw new Error('timer created');
      });
      Reflect.set(globalThis, 'setInterval', () => {
        throw new Error('interval created');
      });
      Reflect.set(globalThis, 'fetch', () => {
        throw new Error('network reached');
      });

      drive('resolve empty', () => resolveUpgradeOptions(undefined, UPGRADE_OPTION_KEYS));
      drive('resolve full', () =>
        resolveAsJavaScriptCaller(
          {
            kind: 'uups',
            unsafeAllow: [...ACCUMULATING_UNSAFE_ALLOW],
            constructorArgs: [1],
            timeout: 1,
            pollingInterval: 1,
            redeployImplementation: 'always',
          },
          UPGRADE_OPTION_KEYS,
        ),
      );
      drive('engine options', () =>
        engineValidationOptions(resolveUpgradeOptions(undefined, UPGRADE_OPTION_KEYS)),
      );
      drive('initializer', () => resolveInitializer(undefined, 2));
      drive('proxy kind', () => requireProxyKind('uups', ['uups'], 'deployProxy'));
      drive('channel', () => {
        const channel = createOutputChannel(channelFacts(recordingSink()));
        channel.warn('a warning');
        channel.note('a note');
        channel.degraded(validNote());
        return channel.recorded;
      });
      drive('describe', () =>
        createOutputChannel(channelFacts(recordingSink())).describe(),
      );
      drive('seal', () => sealUnavailable(addPropStyleTarget()));
      drive('transaction identity', () => transactionIdentity('0xabc', 'deployProxy'));
      drive('refusal path', () => {
        try {
          resolveAsJavaScriptCaller({ typo: 1 }, UPGRADE_OPTION_KEYS);
        } catch {
          return 'refused as expected';
        }
        throw new Error('expected a refusal');
      });
    } finally {
      Object.defineProperty(process, 'env', { configurable: true, value: savedEnv });
      Date.now = savedNow;
      Reflect.set(globalThis, 'setTimeout', savedTimeout);
      Reflect.set(globalThis, 'setInterval', savedInterval);
      Reflect.set(globalThis, 'fetch', savedFetch);
    }

    expect(outcomes).toHaveLength(10);
    for (const { label, error } of outcomes) {
      expect(error, `${label} must not reach ambient state`).toBeUndefined();
    }
  });

  it('performs no state change of any kind — no filesystem, no chain, no manifest', () => {
    // The structural half: an absence, so the assertion is over the module graph.
    // A filesystem import anywhere here would also make the no-ambient-io
    // property false and the "no TronBox process" testability claim false with it.
    for (const source of sf10Sources()) {
      for (const specifier of source.moduleSpecifiers) {
        expect(
          specifier.specifier,
          `${source.relative}:${specifier.line} must not reach a stateful module`,
        ).not.toMatch(/^node:|^fs$|^path$|^http|^net$|^child_process$/);
      }
      expect(source.dynamicSpecifierSites, `${source.relative}`).toEqual([]);
    }
  });
});
