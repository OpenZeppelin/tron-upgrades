import { afterEach, describe, expect, it } from 'vitest';

import {
  OptionValueError,
  renderReceived,
  requireProxyKind,
  resolveInitializer,
  resolveUpgradeOptions,
  engineValidationOptions,
} from '../src/options';
import {
  RECORDED_NOTE_CAP,
  captureEngineWarnings,
  createOutputChannel,
  silenceWarnings,
  type DegradedNote,
} from '../src/output';
import { resetSilenceForTests } from '../src/output/silence';
import {
  operationNotes,
  sealUnavailable,
  transactionIdentity,
} from '../src/results';
import {
  DEPLOY_PROXY_OPTION_KEYS,
  UPGRADE_OPTION_KEYS,
  addPropStyleTarget,
  channelFacts,
  declaredReturnTypes,
  noopSink,
  recordingSink,
  resolveAsJavaScriptCaller,
  sf10Sources,
  validNote,
} from './helpers/sf-10-fixtures';

/**
 * SF-10 Resource Limits & Rate — SF-10 INV-38 … INV-40.
 *
 * Technique 6, quota / boundary testing, adapted to a library with no network
 * surface. There is no request rate to throttle here, so the three bounds that
 * matter are the ones a caller can actually blow past:
 *
 * 1. **INV-38** — how many degraded notes one channel will hold, and whether the
 *    truncation is honest about how many it dropped.
 * 2. **INV-39** — how much of the caller's own data the resolver will walk.
 *    `constructorArgs` is arbitrary caller data, so the bound is *one level* and the
 *    detector is a `Proxy` that counts every read it is subjected to.
 * 3. **INV-40** — that nothing here is asynchronous or does I/O, driven by running
 *    every public entry point with the ambient world replaced by throwing stubs.
 *
 * Every bound below is asserted against the **named constant** rather than a
 * literal, so a deliberate change to the cap moves the test with it and an
 * accidental one does not.
 */

afterEach(() => {
  resetSilenceForTests();
});

// ---------------------------------------------------------------------------
// SF-10 INV-38
// ---------------------------------------------------------------------------

describe('SF-10 INV-38: `recorded` is bounded, and truncation is never silent', () => {
  it('holds at most the cap plus one truncation note, however many are recorded', () => {
    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));

    for (let i = 0; i < RECORDED_NOTE_CAP + 10; i += 1) {
      channel.degraded(validNote('engine-warning', { summary: `note ${String(i)}` }));
    }

    expect(channel.recorded).toHaveLength(RECORDED_NOTE_CAP + 1);
    // The cap is a bound, not a window: the notes kept are the *first* cap, so a
    // flood cannot evict the note that explained the condition.
    expect(channel.recorded[0]?.summary).toBe('note 0');
    expect(channel.recorded[RECORDED_NOTE_CAP - 1]?.summary).toBe(
      `note ${String(RECORDED_NOTE_CAP - 1)}`,
    );
  });

  it('states the suppressed count in the truncation note, under its own code', () => {
    const channel = createOutputChannel(channelFacts(noopSink()));
    for (let i = 0; i < RECORDED_NOTE_CAP + 10; i += 1) {
      channel.degraded(validNote('engine-warning', { summary: `note ${String(i)}` }));
    }

    const truncation = channel.recorded[RECORDED_NOTE_CAP];
    expect(truncation?.code).toBe('notes-truncated');
    // The *count* is what keeps truncation honest — "some notes were suppressed" is
    // unactionable, because the reader cannot tell 1 from 400.
    expect(truncation?.summary).toContain('10 further degraded-mode note(s)');
    expect(truncation?.summary).toContain(String(RECORDED_NOTE_CAP));
    expect(truncation?.remedy).not.toBe('');
    expect(truncation?.detail.length).toBeGreaterThan(0);
  });

  it('reports the FINAL suppressed count, not the count when the cap was reached', () => {
    /*
     * The non-vacuity case for Code Draft's Dev Note 3, made executable.
     *
     * An implementation that froze the truncation note at the moment the cap was
     * reached would report 1 here and 1 again after nine more suppressions — which
     * reads as "one note was dropped" on an operation that dropped ten. `recorded`
     * is a getter that rebuilds precisely so the note can carry the final count
     * while still being frozen before the caller sees it, and the only way to
     * observe the difference is to read the array twice with more suppression in
     * between.
     */
    const channel = createOutputChannel(channelFacts(noopSink()));
    for (let i = 0; i < RECORDED_NOTE_CAP + 1; i += 1) {
      channel.degraded(validNote('engine-warning', { summary: `note ${String(i)}` }));
    }
    const afterOne = channel.recorded[RECORDED_NOTE_CAP];
    expect(afterOne?.summary).toContain('1 further degraded-mode note(s)');

    for (let i = 0; i < 9; i += 1) {
      channel.degraded(validNote('engine-warning', { summary: `late ${String(i)}` }));
    }
    const afterTen = channel.recorded[RECORDED_NOTE_CAP];
    expect(afterTen?.summary).toContain('10 further degraded-mode note(s)');
    // And the earlier read is not retroactively rewritten: it was frozen when it
    // was handed out.
    expect(afterOne?.summary).toContain('1 further degraded-mode note(s)');
  });

  it('suppresses the advisory write too, so `recorded` stays a superset of what the user saw', () => {
    /*
     * Code Draft's deliberate choice, asserted rather than assumed: past the cap
     * the note is neither recorded *nor* written. Continuing to write while no
     * longer recording would make `recorded` a non-superset of the terminal output,
     * which is a worse failure than truncation — the user would see a warning the
     * result has no record of.
     */
    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));
    for (let i = 0; i < RECORDED_NOTE_CAP + 25; i += 1) {
      channel.degraded(validNote('engine-warning', { summary: `note ${String(i)}` }));
    }

    expect(sink.calls).toHaveLength(RECORDED_NOTE_CAP);
    const written = sink.calls.map(args => String(args[0]));
    expect(written.some(line => line.includes('note 99'))).toBe(true);
    expect(written.some(line => line.includes('note 100'))).toBe(false);
  });

  it('returns the validated frozen note past the cap rather than a silent `undefined`', () => {
    const channel = createOutputChannel(channelFacts(noopSink()));
    for (let i = 0; i < RECORDED_NOTE_CAP; i += 1) {
      channel.degraded(validNote('engine-warning'));
    }

    const returned = channel.degraded(
      validNote('storage-layout-unavailable', { summary: 'past the cap' }),
    );
    expect(returned.summary).toBe('past the cap');
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned.detail)).toBe(true);
    // Suppressed from the record, but the caller still gets back what it handed in.
    expect(
      channel.recorded.some(note => note.summary === 'past the cap'),
    ).toBe(false);
  });

  it('does not append a truncation note when nothing was suppressed', () => {
    const channel = createOutputChannel(channelFacts(noopSink()));
    for (let i = 0; i < RECORDED_NOTE_CAP; i += 1) {
      channel.degraded(validNote('engine-warning'));
    }

    expect(channel.recorded).toHaveLength(RECORDED_NOTE_CAP);
    expect(channel.recorded.map(note => note.code)).not.toContain(
      'notes-truncated',
    );
  });

  it('does not let the truncation note itself consume a slot or recurse', () => {
    const channel = createOutputChannel(channelFacts(noopSink()));
    for (let i = 0; i < RECORDED_NOTE_CAP * 3; i += 1) {
      channel.degraded(validNote('engine-warning'));
    }

    // Exactly one truncation note, no matter how far past the cap, and reading
    // `recorded` repeatedly does not accumulate them.
    const readTwice = [...channel.recorded, ...channel.recorded];
    expect(
      readTwice.filter(note => note.code === 'notes-truncated'),
    ).toHaveLength(2);
    expect(channel.recorded).toHaveLength(RECORDED_NOTE_CAP + 1);
    expect(
      channel.recorded.filter(note => note.code === 'notes-truncated'),
    ).toHaveLength(1);
  });

  it('bounds the buffer the engine relay feeds, so an undeduped upstream cannot grow it', () => {
    /*
     * INV-38's violation scenario is upstream-driven, not caller-driven. Verified
     * present at `@openzeppelin/upgrades-core@1.46.0`: `dist/utils/log.js:log`
     * writes on **every** call with no dedupe, and `validate` emits one warning per
     * offending struct. A large project therefore relays hundreds of near-identical
     * notes through one window, and they are then held on the returned result for
     * the caller's lifetime and re-emitted on every migration of a `tronbox test`
     * replay.
     */
    const channel = createOutputChannel(channelFacts(noopSink()));
    captureEngineWarnings(channel, 'validate', () => {
      for (let i = 0; i < RECORDED_NOTE_CAP + 40; i += 1) {
        console.error(`Warning: struct ${String(i)} uses a custom layout`);
      }
    });

    expect(channel.recorded).toHaveLength(RECORDED_NOTE_CAP + 1);
    expect(channel.recorded[RECORDED_NOTE_CAP]?.summary).toContain(
      '40 further degraded-mode note(s)',
    );
    // And the result the caller carries is the bounded array, not the channel's
    // internals.
    expect(operationNotes(channel.recorded)).toHaveLength(RECORDED_NOTE_CAP + 1);
  });

  it('is unaffected by silencing — the cap gates recording, the flag gates writing', () => {
    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));
    silenceWarnings();
    for (let i = 0; i < RECORDED_NOTE_CAP + 3; i += 1) {
      channel.degraded(validNote('engine-warning'));
    }

    expect(sink.calls).toHaveLength(0);
    expect(channel.recorded).toHaveLength(RECORDED_NOTE_CAP + 1);
    expect(channel.recorded[RECORDED_NOTE_CAP]?.summary).toContain(
      '3 further degraded-mode note(s)',
    );
  });
});

// ---------------------------------------------------------------------------
// SF-10 INV-39
// ---------------------------------------------------------------------------

/**
 * A `Proxy` that counts every operation performed on it and throws on any read.
 *
 * This is INV-39's detector, and it is the only instrument that can distinguish
 * "does not deep-walk" from "happens not to have deep-walked this fixture": a
 * length-or-index read of an element registers as a count, and a *validating*
 * traversal — `JSON.stringify`, a deep clone, a deep freeze — cannot avoid one.
 */
function countingElement(): {
  readonly value: object;
  readonly counts: { gets: number; hasChecks: number; keyLists: number };
} {
  const counts = { gets: 0, hasChecks: 0, keyLists: 0 };
  const value = new Proxy(
    {},
    {
      get(_target, property): never {
        counts.gets += 1;
        throw new Error(
          `INV-39 violated: the resolver read "${String(property)}" off a ` +
            'constructor-argument element. Caller data is never traversed.',
        );
      },
      has(_target, _property): boolean {
        counts.hasChecks += 1;
        return false;
      },
      ownKeys(): readonly string[] {
        counts.keyLists += 1;
        return [];
      },
    },
  );
  return { value, counts };
}

describe('SF-10 INV-39: resolution is bounded by the caller key count and never traverses caller data', () => {
  it('never reads into a `constructorArgs` element', () => {
    const element = countingElement();
    const resolved = resolveAsJavaScriptCaller(
      { constructorArgs: [element.value] },
      UPGRADE_OPTION_KEYS,
    );

    expect(element.counts).toEqual({ gets: 0, hasChecks: 0, keyLists: 0 });
    expect(resolved.constructorArgs).toHaveLength(1);
    // Identity, not a clone: a caller passing a live handle as a constructor
    // argument must get that handle through.
    expect(resolved.constructorArgs[0]).toBe(element.value);
  });

  it('resolves a cyclic constructor argument without throwing', () => {
    // A struct with a self-reference is legal Solidity input built from a legal JS
    // object graph. `JSON.stringify` of it throws `TypeError: Converting circular
    // structure to JSON`, so a validating serialization would turn a perfectly
    // valid deployment into an options error.
    interface Cyclic {
      name: string;
      self?: Cyclic;
    }
    const cyclic: Cyclic = { name: 'Box' };
    cyclic.self = cyclic;

    const resolved = resolveAsJavaScriptCaller(
      { constructorArgs: [cyclic, 1n, Symbol('tag'), () => 0] },
      UPGRADE_OPTION_KEYS,
    );
    expect(resolved.constructorArgs).toHaveLength(4);
    expect(resolved.constructorArgs[0]).toBe(cyclic);
    expect(resolved.constructorArgs[1]).toBe(1n);
  });

  it('copies exactly one level of a large `constructorArgs`, and nothing deeper', () => {
    const million = 1_000_000;
    const nested = new Proxy(new Array<number>(million).fill(0), {
      get(_target, property): never {
        // A nested array is caller data too: the one-level copy must not touch it.
        throw new Error(
          `INV-39 violated: the resolver read "${String(property)}" off a ` +
            'nested array inside constructorArgs.',
        );
      },
    });

    const outer = new Array<unknown>(million).fill('arg');
    outer[0] = nested;
    const resolved = resolveAsJavaScriptCaller(
      { constructorArgs: outer },
      UPGRADE_OPTION_KEYS,
    );

    // Bounded by the outer array's length — linear, one level, no recursion. The
    // test completing at all is the time bound: a deep walk of 10^6 nested
    // elements would not finish inside vitest's timeout.
    expect(resolved.constructorArgs).toHaveLength(million);
    expect(resolved.constructorArgs[0]).toBe(nested);
    expect(Object.isFrozen(resolved.constructorArgs)).toBe(true);
  });

  it('examines only own keys and the closed sets — the cost does not grow with value size', () => {
    /*
     * The "bounded by the caller's key count" half. A `Proxy` over the *options
     * object* counts every key enumeration and every read, so the assertion is
     * about the resolver's access pattern rather than about a clock.
     */
    const reads: string[] = [];
    let keyLists = 0;
    const supplied = new Proxy(
      {
        kind: 'uups',
        constructorArgs: new Array<number>(500_000).fill(1),
        timeout: 1_000,
      } as Record<string, unknown>,
      {
        get(target, property, receiver): unknown {
          if (typeof property === 'string') {
            reads.push(property);
          }
          return Reflect.get(target, property, receiver);
        },
        ownKeys(target): readonly (string | symbol)[] {
          keyLists += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    resolveAsJavaScriptCaller(supplied, DEPLOY_PROXY_OPTION_KEYS);

    expect(keyLists).toBeGreaterThan(0);
    // Every key the resolver reads is one the surface declares; it never probes for
    // anything outside the closed set, and it never reads the same key an unbounded
    // number of times. The 500 000-element value is read exactly as often as a
    // one-element one would be — the cost is the key count, not the data size.
    const distinct = [...new Set(reads)].sort();
    expect(distinct).toEqual(
      distinct.filter(key => DEPLOY_PROXY_OPTION_KEYS.includes(key)),
    );
    expect(reads.length).toBeLessThan(DEPLOY_PROXY_OPTION_KEYS.length * 6);
  });

  it('renders `received` within its budget and never throws doing it', () => {
    const long = 'x'.repeat(10_000);
    const rendered = renderReceived(long);
    expect(rendered.length).toBeLessThan(200);
    // 10 002, not 10 000: a string is rendered through `JSON.stringify` for the
    // quoting INV-10 wants, and the budget is measured on the quoted form. Stated
    // exactly rather than loosely, because "contains some number" would pass on a
    // renderer that reported the *truncated* length and hid how much was dropped.
    expect(rendered).toContain('(10002 characters total)');

    interface Cyclic {
      self?: Cyclic;
    }
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    expect(renderReceived(cyclic)).toBe('an object');

    expect(renderReceived(new Array<number>(1_000_000).fill(0))).toBe(
      'an array of 1000000 element(s)',
    );

    // A `Proxy` whose `get` throws is reachable through `Array.isArray` + `.length`;
    // INV-13 requires the renderer itself never to throw, and the message still
    // says what the value was.
    const hostileArray = new Proxy([] as unknown[], {
      get(_target, property): never {
        throw new Error(`no reads: ${String(property)}`);
      },
    });
    expect(renderReceived(hostileArray)).toBe('an array (length unavailable)');

    // `String(value)` is deliberately avoided: it throws on a symbol and invokes a
    // caller-supplied `toString`.
    expect(renderReceived(Symbol('secret'))).toBe('a symbol');
    expect(renderReceived(1n)).toBe('1n');
    expect(renderReceived(-0)).toBe('-0');
  });

  it('keeps the budget when the bounded rendering reaches a real error message', () => {
    const long = 'y'.repeat(5_000);
    let thrown: unknown;
    try {
      resolveAsJavaScriptCaller({ kind: long }, UPGRADE_OPTION_KEYS);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OptionValueError);
    const message = (thrown as OptionValueError).message;
    expect(message).not.toContain(long);
    expect(message.length).toBeLessThan(600);
    // The structured field carries the value in full — bounding is a *rendering*
    // rule, not a data-loss rule (INV-10).
    expect((thrown as OptionValueError).received).toBe(long);
  });
});

// ---------------------------------------------------------------------------
// SF-10 INV-40
// ---------------------------------------------------------------------------

/**
 * Replaces the ambient world with throwing stubs for the duration of one
 * synchronous call, then restores it.
 *
 * Assertions are deliberately made **outside** the window: `expect` itself reads a
 * clock, so asserting inside would fail on the harness rather than on the code
 * under test.
 */
function withHostileAmbient<T>(run: () => T): T {
  const saved = {
    now: Date.now,
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    setImmediate: globalThis.setImmediate,
    fetch: globalThis.fetch,
    env: process.env,
    hrtime: process.hrtime,
  };
  const refuse = (what: string) => (): never => {
    throw new Error(`INV-40 violated: ${what} was reached.`);
  };
  try {
    Date.now = refuse('Date.now');
    process.hrtime = refuse('process.hrtime') as unknown as typeof process.hrtime;
    globalThis.setTimeout = refuse('setTimeout') as unknown as typeof setTimeout;
    globalThis.setInterval = refuse(
      'setInterval',
    ) as unknown as typeof setInterval;
    globalThis.setImmediate = refuse(
      'setImmediate',
    ) as unknown as typeof setImmediate;
    globalThis.fetch = refuse('fetch') as unknown as typeof fetch;
    process.env = new Proxy(
      {},
      {
        get(_target, property): never {
          throw new Error(
            `INV-40 violated: process.env.${String(property)} was read.`,
          );
        },
      },
    ) as NodeJS.ProcessEnv;

    return run();
  } finally {
    Date.now = saved.now;
    process.hrtime = saved.hrtime;
    globalThis.setTimeout = saved.setTimeout;
    globalThis.setInterval = saved.setInterval;
    globalThis.setImmediate = saved.setImmediate;
    globalThis.fetch = saved.fetch;
    process.env = saved.env;
  }
}

describe('SF-10 INV-40: the channel and the resolver are synchronous and perform no I/O', () => {
  it('returns a non-thenable from every public entry point', () => {
    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));
    const target = addPropStyleTarget();

    const returns: readonly unknown[] = [
      resolveUpgradeOptions({ kind: 'uups' }, UPGRADE_OPTION_KEYS),
      engineValidationOptions(
        resolveUpgradeOptions(undefined, UPGRADE_OPTION_KEYS),
      ),
      resolveInitializer('initialize', 1),
      requireProxyKind('uups', ['uups'], 'deployProxy'),
      createOutputChannel(channelFacts(sink)),
      channel.warn('a title'),
      channel.note('a title'),
      channel.degraded(validNote()),
      channel.recorded,
      channel.describe(),
      silenceWarnings(),
      sealUnavailable(target, {}),
      transactionIdentity('0xabc', 'deployProxy'),
      operationNotes([]),
      captureEngineWarnings(channel, 'getErrors', () => 'sync'),
    ];

    for (const [index, value] of returns.entries()) {
      const then = (value as { then?: unknown } | null | undefined)?.then;
      expect(
        typeof then,
        `entry point ${String(index)} returned a thenable`,
      ).not.toBe('function');
    }
  });

  it('declares no `Promise` return type anywhere in the three directories', () => {
    /*
     * The type-level half, and what makes INV-27's runtime guard meaningful: the
     * one place a promise can appear is a *caller's thunk*, so if any declared
     * return type in these directories were a `Promise`, the guard would be
     * guarding a hole the package had already opened for itself.
     */
    const offending = sf10Sources().flatMap(source =>
      declaredReturnTypes(source)
        .filter(entry => /\bPromise\s*</.test(entry.returnType))
        .map(entry => `${source.relative}:${entry.name} -> ${entry.returnType}`),
    );
    expect(offending).toEqual([]);

    // Non-vacuity: the instrument does find the return types that are there.
    const engineReturns = declaredReturnTypes(
      sf10Sources().filter(source => source.relative.endsWith('engine.ts'))[0]!,
    ).map(entry => entry.returnType);
    expect(engineReturns).toContain('T');
    expect(engineReturns).toContain('void');
  });

  it('declares no `async` function and contains no `await` in the three directories', () => {
    // INV-28's static half, asserted over all three directories rather than only
    // `engine.ts`: an `async` helper anywhere in the package that a window's thunk
    // reached would reopen the hazard from a different file.
    const asyncModules = sf10Sources()
      .filter(source => source.hasAsyncModifier || source.hasAwaitExpression)
      .map(source => source.relative);
    expect(asyncModules).toEqual([]);
  });

  it('runs every entry point with the clock, timers, `fetch` and `process.env` refusing', () => {
    const sink = recordingSink();
    const outcome = withHostileAmbient(() => {
      const channel = createOutputChannel(channelFacts(sink));
      const resolved = resolveUpgradeOptions(
        {
          kind: 'uups',
          unsafeAllow: ['external-library-linking'],
          constructorArgs: [1, 'two'],
          timeout: 0,
          pollingInterval: 250,
        },
        UPGRADE_OPTION_KEYS,
      );
      const engineOptions = engineValidationOptions(resolved);
      channel.warn('advisory', ['detail']);
      channel.degraded(validNote('storage-layout-unavailable'));
      const relayed = captureEngineWarnings(channel, 'getErrors', () => {
        console.error('Warning: something the engine noticed');
        return 42;
      });
      const sealed = sealUnavailable(addPropStyleTarget());
      const identity = transactionIdentity('0xdeadbeef', 'deployProxy');
      const notes = operationNotes(channel.recorded);
      return {
        resolvedTimeout: resolved.timeout,
        engineKind: engineOptions.kind,
        relayed,
        contractName: (sealed as unknown as { contractName: string }).contractName,
        hash: identity.hash,
        noteCount: notes.length,
        initializer: resolveInitializer(undefined, 2),
      };
    });

    expect(outcome.resolvedTimeout).toBe(0);
    expect(outcome.engineKind).toBe('uups');
    expect(outcome.relayed).toBe(42);
    expect(outcome.contractName).toBe('Box');
    expect(outcome.hash).toBe('0xdeadbeef');
    // The advisory warn plus the degraded note plus the relayed engine warning.
    expect(outcome.noteCount).toBe(2);
    expect(outcome.initializer).toEqual({ kind: 'call', fn: 'initialize' });
  });

  it('refuses on a real ambient read, so the hostile harness is not vacuous', () => {
    // If `withHostileAmbient` silently failed to install its stubs, every
    // assertion above would pass against code that read the clock freely.
    expect(() =>
      withHostileAmbient(() => {
        return Date.now();
      }),
    ).toThrow(/INV-40 violated: Date\.now was reached/);
    expect(() =>
      withHostileAmbient(() => {
        return process.env['HOME'];
      }),
    ).toThrow(/INV-40 violated: process\.env\.HOME was read/);
    // And the world is restored afterwards.
    expect(typeof Date.now()).toBe('number');
  });

  it('records notes in a bounded, synchronous sequence even when the sink is slow-shaped', () => {
    /*
     * INV-40's violation scenario is that an async channel would make INV-23's
     * "record before write" ordering untestable and let a note be recorded after
     * the result was already returned. Asserted directly: the record exists by the
     * time `degraded` returns, on the same tick, with no microtask in between.
     */
    const order: string[] = [];
    const channel = createOutputChannel(
      channelFacts({
        log(): void {
          order.push('write');
        },
      }),
    );
    const returned: DegradedNote = channel.degraded(
      validNote('artifact-name-indeterminate'),
    );
    order.push(`recorded:${String(channel.recorded.length)}`);

    expect(order).toEqual(['write', 'recorded:1']);
    expect(channel.recorded[0]).toBe(returned);
  });
});
