import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DegradedNoteInvalidError,
  EngineCallNotSynchronousError,
  EngineCaptureReentrantError,
  capturableEngineExports,
  captureEngineWarnings,
  createOutputChannel,
  degradedCodes,
  engineWarningCapableExports,
  silenceWarnings,
  uncapturableEngineExports,
  uncapturedEngineWarnings,
  type DegradedCode,
  type DegradedNote,
  type LogSink,
  type OutputChannel,
} from '../src/output';
import { resetSilenceForTests } from '../src/output/silence';
import { operationNotes } from '../src/results';
import {
  FACT_COMBINATIONS,
  atChalkLevel,
  channelFacts,
  consoleBackedSink,
  conditionExpressions,
  consoleCallSites,
  deployerStyleSink,
  enclosingFunctionsOf,
  enclosingFunctionsOfChain,
  noopSink,
  recordingSink,
  sf10Sources,
  sinkMissingLog,
  sourceNamed,
  throwingSink,
  upstreamLogWriters,
  validNote,
  warnCapableSink,
} from './helpers/surface-fixtures';
import { callSites, valueIdentifierNames } from './helpers/source-scan';

/**
 * Side-effect ordering and observability for the option/result surface, covering
 * the capture window's guards, the channel's write discipline, and the degraded-note
 * contract.
 *
 * Technique: sequence interleaving, with an **unguarded twin** for each guard the
 * category rests on. Four guards get one: the capture window's thenable refusal,
 * its buffer-and-flush-after-restore, its non-reentrancy and always-restore, and
 * (in `surface-augmentation-boundary.test.ts`) the augmentation policy's non-identity
 * refusal. In each case the same fixtures run through a local re-implementation
 * that omits exactly the refusal, and the twin is asserted to break on a **named
 * count** of cases. That is the difference between a test that exercises a guard
 * and a test that proves the guard is doing something.
 *
 * `console.error` is swapped by the code under test, so every test that touches
 * the capture window saves and restores it by hand rather than through `vi.spyOn` —
 * a spy would be the value the window saves, which conflates the two mechanisms.
 * The `afterEach` below is the backstop.
 */

/** The value `console.error` must hold before and after every test in this file. */
let pristineConsoleError: typeof console.error;

beforeEach(() => {
  resetSilenceForTests();
  pristineConsoleError = console.error;
});

afterEach(() => {
  // The always-restore guarantee, restated as a suite-wide obligation: no test may
  // leave the stub installed, because the next one would silently capture into a
  // dead buffer.
  // `vi.restoreAllMocks()` runs *first* — a `vi.spyOn(console, 'error')` is itself
  // a replacement, and checking before restoring would report the suite's own spy
  // as a leak.
  vi.restoreAllMocks();
  const leaked = console.error !== pristineConsoleError;
  console.error = pristineConsoleError;
  resetSilenceForTests();
  expect(leaked, 'console.error was left swapped by the preceding test').toBe(false);
});

// ---------------------------------------------------------------------------
// Local twins — the non-vacuity instruments
// ---------------------------------------------------------------------------

function renderCaptured(args: readonly unknown[]): string {
  return args.map(arg => (typeof arg === 'string' ? arg : `[${typeof arg}]`)).join(' ');
}

/** A minimal note builder for the twins, so they exercise the channel the same way. */
function twinNote(text: string): DegradedNote {
  return {
    code: 'engine-warning',
    summary: text === '' ? 'a blank captured write' : text.split('\n')[0] ?? text,
    detail: [],
    remedy: 'the twin exists only to be compared against the real window',
  };
}

/**
 * The window with the thenable refusal removed, and nothing else changed.
 * Returns whatever `fn` returned — including a promise.
 */
function captureWithoutThenableCheck<T>(channel: OutputChannel, fn: () => T): T {
  const captured: string[] = [];
  const saved = console.error;
  try {
    console.error = (...args: unknown[]): void => {
      captured.push(renderCaptured(args));
    };
    return fn();
  } finally {
    console.error = saved;
    for (const write of captured.splice(0, captured.length)) {
      channel.degraded(twinNote(write));
    }
  }
}

/**
 * The window that does what the thenable refusal exists to make impossible:
 * `await`s inside the swap. This is the direction that fabricates rather than
 * loses.
 */
async function captureAwaitingInside<T>(
  channel: OutputChannel,
  fn: () => Promise<T>,
  concurrent: () => void,
): Promise<T> {
  const captured: string[] = [];
  const saved = console.error;
  try {
    console.error = (...args: unknown[]): void => {
      captured.push(renderCaptured(args));
    };
    const pending = fn();
    // Some unrelated code runs while the event loop is yielded — which is the
    // whole hazard, and the only way to model it deterministically.
    concurrent();
    return await pending;
  } finally {
    console.error = saved;
    for (const write of captured.splice(0, captured.length)) {
      channel.degraded(twinNote(write));
    }
  }
}

/** The window with the restore guarantee's `finally` removed. */
function captureWithoutFinally<T>(channel: OutputChannel, fn: () => T): T {
  const captured: string[] = [];
  const saved = console.error;
  console.error = (...args: unknown[]): void => {
    captured.push(renderCaptured(args));
  };
  const value = fn();
  console.error = saved;
  for (const write of captured.splice(0, captured.length)) {
    channel.degraded(twinNote(write));
  }
  return value;
}

/** The window with the re-entrancy guard removed. */
function captureWithoutReentrancyGuard<T>(channel: OutputChannel, fn: () => T): T {
  const captured: string[] = [];
  const saved = console.error;
  try {
    console.error = (...args: unknown[]): void => {
      captured.push(renderCaptured(args));
    };
    return fn();
  } finally {
    console.error = saved;
    for (const write of captured.splice(0, captured.length)) {
      channel.degraded(twinNote(write));
    }
  }
}

/**
 * The window that relays **inside** the swap, which the buffer-and-flush-
 * after-restore guard forbids.
 */
function captureRelayingInsideWindow<T>(channel: OutputChannel, fn: () => T): T {
  const saved = console.error;
  try {
    console.error = (...args: unknown[]): void => {
      // The relay runs immediately, while the stub is still installed.
      channel.degraded(twinNote(renderCaptured(args)));
    };
    return fn();
  } finally {
    console.error = saved;
  }
}

// ---------------------------------------------------------------------------
// The degraded record is the guarantee; the write is a courtesy
// ---------------------------------------------------------------------------

describe('the degraded record is the guarantee; the write is a courtesy', () => {
  it.each([
    { label: 'a throwing sink', sink: (): LogSink => throwingSink() },
    { label: 'a noop sink', sink: (): LogSink => noopSink() },
    { label: 'a sink with no log at all', sink: (): LogSink => sinkMissingLog() },
  ])('records the note through $label', ({ sink }) => {
    /*
     * `build/lib/test.js:Test.performInitialDeploy` calls `Migrate.run` with
     * `{ quiet: true, logger: { log: function log(){} } }`, so the migration-phase
     * logger is a noop on **every** `tronbox test` run with no flag involved — and
     * `build/lib/commands/test.js:command.builder` does not declare `quiet` at
     * all. A design that discharged the degraded-mode disclosure requirement
     * through the log would be broken for the one command that forces a full
     * replay of every migration on every run.
     */
    const channel = createOutputChannel(channelFacts(sink()));
    const returned = channel.degraded(validNote('namespaced-ast-only'));
    expect(channel.recorded).toHaveLength(1);
    expect(channel.recorded[0]?.code).toBe('namespaced-ast-only');
    // `degraded` returns what it recorded, so the record is on the call's happy
    // path rather than a side effect a caller has to go looking for.
    expect(returned).toBe(channel.recorded[0]);
  });

  it('records the note when the plugin\'s silence flag is set', () => {
    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));
    silenceWarnings();
    channel.degraded(validNote('storage-layout-unavailable'));
    expect(channel.recorded).toHaveLength(1);
    expect(sink.calls).toEqual([]);
  });

  it('appends before it attempts the write, observed from inside the write', () => {
    /*
     * The ordering, asserted directly rather than by spying on two functions and
     * comparing timestamps: the sink reads `channel.recorded` *while being called*,
     * so if the write happened first it would see an empty array.
     */
    const observedLengths: number[] = [];
    let channel: OutputChannel | undefined;
    const sink: LogSink = {
      log: (): void => {
        observedLengths.push(channel?.recorded.length ?? -1);
      },
    };
    channel = createOutputChannel(channelFacts(sink));
    channel.degraded(validNote());
    channel.degraded(validNote());
    expect(observedLengths).toEqual([1, 2]);
  });

  it('never lets a write failure propagate or prevent the record', () => {
    const channel = createOutputChannel(channelFacts(throwingSink('host sink exploded')));
    expect(() => channel.degraded(validNote())).not.toThrow();
    expect(() => channel.warn('advisory')).not.toThrow();
    expect(() => channel.note('informational')).not.toThrow();
    expect(channel.recorded).toHaveLength(1);
  });

  it('swallows the write failure in exactly one place, and nothing load-bearing rides it', () => {
    // The swallow lives in the single emitter rather than only in `degraded`, so
    // the same rule covers `warn` and `note` — and covers the JavaScript-host case
    // the type system cannot, where the sink has no `log` at all. That is a
    // deliberate widening of the write-is-a-courtesy guarantee, recorded during
    // implementation.
    const channel = sourceNamed('output/channel.ts');
    const catchClauses = channel.text.match(/\} catch \{/g) ?? [];
    expect(catchClauses).toHaveLength(1);
    // And `degraded`'s own throws are *before* the record, so they are not
    // swallowed: a malformed note is refused, not silently dropped.
    expect(() =>
      createOutputChannel(channelFacts(throwingSink())).degraded(
        validNote('engine-warning', { summary: '   ' }),
      ),
    ).toThrow(DegradedNoteInvalidError);
  });
});

// ---------------------------------------------------------------------------
// silenceWarnings() suppresses writes only
// ---------------------------------------------------------------------------

describe('silenceWarnings() suppresses writes only', () => {
  it('runs the three-way matrix and finds recorded identical in all three', () => {
    /*
     * Scenario 5's matrix: normal, plugin-silenced, host-quiet. Writes differ only
     * for the plugin-silenced case — `hostQuietRequested` is provenance and gates
     * nothing — while `recorded` and the thrown errors are identical in
     * all three.
     */
    const run = (
      mode: 'normal' | 'plugin-silenced' | 'host-quiet',
    ): {
      readonly writes: number;
      readonly recorded: readonly DegradedNote[];
      readonly refusal: {
        readonly className: string;
        readonly field: string;
        readonly code: string;
        readonly message: string;
      };
    } => {
      resetSilenceForTests();
      const sink = recordingSink();
      const channel = createOutputChannel(
        channelFacts(sink, 'deployer', mode === 'host-quiet'),
      );
      if (mode === 'plugin-silenced') {
        silenceWarnings();
      }
      channel.warn('an advisory warning');
      channel.note('an informational note');
      channel.degraded(validNote('artifact-name-indeterminate'));
      let refusal = { className: 'none', field: 'none', code: 'none', message: 'none' };
      try {
        channel.degraded(validNote('engine-warning', { remedy: '' }));
      } catch (error) {
        const typed = error as DegradedNoteInvalidError;
        refusal = {
          className: typed.name,
          field: typed.field,
          code: typed.code,
          message: typed.message,
        };
      }
      return { writes: sink.calls.length, recorded: channel.recorded, refusal };
    };

    const normal = run('normal');
    const silenced = run('plugin-silenced');
    const hostQuiet = run('host-quiet');

    // Three writes normally: warn, note, and the degraded note's advisory write.
    expect(normal.writes).toBe(3);
    expect(silenced.writes).toBe(0);
    expect(hostQuiet.writes).toBe(3);

    expect(silenced.recorded).toEqual(normal.recorded);
    expect(hostQuiet.recorded).toEqual(normal.recorded);
    expect(normal.recorded).toHaveLength(1);

    // The thrown error is the same failure in all three: same class, same field,
    // same code. Its *message* differs in exactly one clause — the provenance
    // `describe()` appends — and that difference is itself the evidence that
    // provenance never changes behavior:
    // `hostQuietRequested` reaches the message and nothing else, so it changes what
    // a failure says about where the channel came from and never what the channel
    // does. Comparing the whole message here would assert the opposite property.
    expect(silenced.refusal).toEqual(normal.refusal);
    expect(hostQuiet.refusal.className).toBe(normal.refusal.className);
    expect(hostQuiet.refusal.field).toBe(normal.refusal.field);
    expect(hostQuiet.refusal.code).toBe(normal.refusal.code);
    expect(normal.refusal.className).toBe('DegradedNoteInvalidError');
    expect(hostQuiet.refusal.message).not.toBe(normal.refusal.message);
    expect(hostQuiet.refusal.message).toContain('host quiet requested: true');
    expect(normal.refusal.message).toContain('host quiet requested: false');
  });

  it('never suppresses the engine-warning capture', () => {
    /*
     * The bypass this closes: a `silenceWarnings()` that short-circuited
     * `captureEngineWarnings` would let upstream's writes escape to `console.error`
     * and bypass the host's quiet mode — the plugin's own control creating the
     * bypass it exists to prevent.
     */
    const { logWarning } = upstreamLogWriters();
    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));
    silenceWarnings();

    const escaped: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => {
      escaped.push(args);
    };
    try {
      captureEngineWarnings(channel, 'getErrors', () => {
        atChalkLevel(0, () => logWarning('Potentially unsafe deployment of Box', []));
        return 'engine result';
      });
    } finally {
      console.error = original;
    }

    // Captured and recorded, not escaped, and not written.
    expect(escaped).toEqual([]);
    expect(channel.recorded).toHaveLength(1);
    expect(channel.recorded[0]?.code).toBe('engine-warning');
    expect(sink.calls).toEqual([]);
  });

  it('never suppresses a thrown error', () => {
    const channel = createOutputChannel(channelFacts(recordingSink()));
    silenceWarnings();
    expect(() => channel.degraded(validNote('engine-note', { summary: '' }))).toThrow(
      DegradedNoteInvalidError,
    );
    expect(() =>
      captureEngineWarnings(channel, 'assertUpgradeSafe', () => {
        throw new Error('the engine refused the upgrade');
      }),
    ).toThrow('the engine refused the upgrade');
  });

  it('reads the flag at exactly one place in the package', () => {
    /*
     * Structural, and the reason "silencing gates emission only" is a property
     * rather than a review note: the emitter is the sole reader. Measured as **call
     * sites** rather than identifier occurrences — `output/silence.ts` necessarily
     * names `isSilenced` to declare it, and an identifier scan would report the
     * declaration as a second reader.
     */
    const readers = callSites(sf10Sources(), 'isSilenced');
    expect(readers).toHaveLength(1);
    expect(readers[0]?.relative).toBe('output/channel.ts');
    // …and the only occurrence inside a function is in `emit`, not in `degraded`
    // and not in the `recorded` getter. The module-scope hit is the import
    // specifier, which is how the name gets there at all.
    const channel = sourceNamed('output/channel.ts');
    expect(enclosingFunctionsOf(channel, 'isSilenced')).toEqual([
      '<module scope>',
      'emit',
    ]);
    // The flag itself lives in one module, and no other module imports the
    // resettable half.
    const importers = sf10Sources().filter(source =>
      source.importSpecifiers.some(specifier => specifier.endsWith('./silence')),
    );
    expect(importers.map(source => source.relative).sort()).toEqual([
      'output/channel.ts',
      'output/index.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Every write goes through the injected sink with a probed method
// ---------------------------------------------------------------------------

describe('every write goes through the injected sink with a probed method', () => {
  it('performs exactly one write per emission on every injection path', () => {
    /*
     * The multiple-write hazard is concrete: the deployer's own wrapper
     * (`{ log: msg => logger.log('  ' + msg) }`) indents by two spaces **per
     * call**, so a three-call emission would get three prefixes. One write per
     * emission is what makes detail lines legible on every host.
     */
    const paths: readonly { readonly label: string; readonly build: () => {
      readonly sink: LogSink;
      readonly count: () => number;
    } }[] = [
      {
        label: 'console-shaped (the un-quieted CLI path)',
        build: () => {
          const sink = warnCapableSink();
          return { sink, count: () => sink.calls.length + sink.warnCalls.length };
        },
      },
      {
        label: 'single-method (--quiet, tronbox test, Config default)',
        build: () => {
          const sink = recordingSink();
          return { sink, count: () => sink.calls.length };
        },
      },
      {
        label: "the deployer's indenting wrapper",
        build: () => {
          const inner = recordingSink();
          return { sink: deployerStyleSink(inner), count: () => inner.calls.length };
        },
      },
    ];

    for (const { label, build } of paths) {
      const { sink, count } = build();
      const channel = createOutputChannel(channelFacts(sink));
      channel.warn('a title', ['first', 'second', 'third']);
      expect(count(), `${label}: warn must write exactly once`).toBe(1);
      channel.note('another title', ['only line']);
      expect(count(), `${label}: note must write exactly once`).toBe(2);
      channel.degraded(validNote());
      expect(count(), `${label}: degraded must write exactly once`).toBe(3);
    }
  });

  it('prefers a probed warn and falls back to log, without a TypeError on either path', () => {
    const rich = warnCapableSink();
    createOutputChannel(channelFacts(rich)).warn('routed to warn');
    expect(rich.warnCalls).toHaveLength(1);
    expect(rich.calls).toEqual([]);

    const plain = recordingSink();
    createOutputChannel(channelFacts(plain)).warn('routed to log');
    expect(plain.calls).toHaveLength(1);
  });

  it('probes with typeof rather than in, which is the discriminating case', () => {
    /*
     * The fixture that tells the two operators apart: an own `warn` property whose
     * value is not a function. `'warn' in sink` is `true`, so an `in`-based probe
     * would call it and raise a `TypeError` for exactly the users who asked for
     * less output. `typeof` reads `'undefined'` and falls through to `log`.
     */
    const calls: unknown[][] = [];
    const sink: LogSink = { log: (...args: unknown[]): void => void calls.push(args) };
    Object.defineProperty(sink, 'warn', { value: undefined, enumerable: true });
    expect('warn' in sink).toBe(true);

    const channel = createOutputChannel(channelFacts(sink));
    expect(() => channel.warn('must not raise a TypeError')).not.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('invokes the method with .call(sink, …), never detached', () => {
    // `console`'s methods are not safe to invoke detached on every host. A sink
    // whose `warn` reads `this` is the fixture that proves the receiver survives.
    const seen: string[] = [];
    const sink = {
      prefix: '[host]',
      log: (): void => void seen.push('log was used'),
      warn(message: unknown): void {
        seen.push(`${this.prefix} ${String(message)}`);
      },
    };
    createOutputChannel(channelFacts(sink)).warn('with a receiver');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('[host]');
    expect(seen[0]).toContain('Warning: with a receiver');
  });

  it('finds an inherited method too, because ownership differs between hosts', () => {
    // `console`'s methods and a closure-built wrapper's differ in ownership, so the
    // probe must not require an own property.
    const warnCalls: unknown[][] = [];
    const prototype = {
      warn(...args: unknown[]): void {
        warnCalls.push(args);
      },
    };
    const sink: LogSink = Object.assign(Object.create(prototype), {
      log: (): void => undefined,
    });
    createOutputChannel(channelFacts(sink)).warn('inherited');
    expect(warnCalls).toHaveLength(1);
  });

  it('declares exactly one method on LogSink, so sink.warn is unwritable in the package', () => {
    const types = sourceNamed('output/types.ts');
    // The type-level half. Without this, an unprobed `sink.warn(...)` would be a
    // `TypeError` under `--quiet`, under `tronbox test`, and through the deployer's
    // own wrapper — turning the required degraded-mode statement into a crash.
    const sink: LogSink = recordingSink();
    // @ts-expect-error LogSink declares `log` only, so `warn` is not on the type.
    const unwritable: unknown = sink.warn;
    expect(unwritable).toBeUndefined();
    expect(types.text).toContain('export interface LogSink {');
  });

  it('formats one string with the level prefix and four-space detail lines', () => {
    // TronBox's house style rather than upstream's: bare ASCII `"Warning: "` and
    // `indent(l, 4)`, matching `WorkflowCompile.js:writeBuildInfo`. No colour, and
    // no `chalk` dependency — requiring `chalk` probes `tty.isatty` at import time,
    // a frozen environment-dependent decision the plugin has no reason to take.
    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));
    channel.warn('a title', ['first', 'second']);
    expect(sink.calls[0]).toHaveLength(1);
    expect(sink.calls[0]?.[0]).toBe('Warning: a title\n    first\n    second');
    channel.note('a note title');
    expect(sink.calls[1]?.[0]).toBe('Note: a note title');
  });
});

// ---------------------------------------------------------------------------
// The option/result surface touches console at exactly one site
// ---------------------------------------------------------------------------

describe('the option/result surface touches console at exactly one site and writes to it nowhere', () => {
  it('calibrates its own instrument: a comment-and-string-blind count would report six', () => {
    /*
     * **The invariant's stated instrument is wrong and must not be built as
     * written.** It asks for *"a source-level scan asserting exactly one `console`
     * occurrence"*. Excluding comments but not string literals, `console.` appears
     * **six** times across the three directories: the three real references, plus
     * three inside two deliberately user-facing messages —
     * `EngineCallNotSynchronousError`'s message names `console.error` twice and
     * `BLANK_WRITE_SUMMARY` once. Naming the mechanism is what makes those messages
     * actionable, so weakening them to satisfy a grep would be backwards.
     *
     * This assertion is the calibration: it pins both numbers, so the instrument
     * below cannot be quietly replaced by the one the wording implies.
     */
    const literalMentions = sf10Sources().flatMap(source =>
      source.stringLiterals.filter(literal => literal.includes('console.')),
    );
    expect(literalMentions).toHaveLength(3);
    // Three hits across two distinct messages: the refusal's message is built from
    // two concatenated literals.
    const engine = sourceNamed('output/engine.ts');
    expect(
      engine.stringLiterals.filter(literal => literal.includes('console.')),
    ).toHaveLength(3);
  });

  it('references console exactly three times, all inside runCaptureWindow', () => {
    // The instrument that measures the property: AST value references, so comments
    // and string literals are structurally out of scope rather than filtered by a
    // pattern somebody has to keep correct.
    const references = sf10Sources().flatMap(source =>
      valueIdentifierNames(source)
        .filter(name => name === 'console')
        .map(() => source.relative),
    );
    expect(references).toEqual([
      'output/engine.ts',
      'output/engine.ts',
      'output/engine.ts',
    ]);

    const engine = sourceNamed('output/engine.ts');
    expect(enclosingFunctionsOf(engine, 'console')).toEqual([
      'runCaptureWindow',
      'runCaptureWindow',
      'runCaptureWindow',
    ]);
    // The three are the save, the swap and the restore — one read and two
    // assignments, which is what "one save-and-swap site" means.
    expect(engine.accessChains.filter(chain => chain === 'console.error')).toHaveLength(3);
  });

  it('writes to console nowhere — not in an error path, not in a catch', () => {
    // The invariant's real content. A write is a *call*; the swap is an
    // assignment, so this count is zero even though `console.error` appears three
    // times above.
    const calls = sf10Sources().flatMap(source => consoleCallSites(source));
    expect(calls).toEqual([]);
  });

  it('touches no console method across every non-engine fixture', () => {
    /*
     * The behavioural half. `build/components/Require.js:Require` always injects
     * the real `console` into the migration sandbox, so plugin output written to
     * `console` **ignores `--quiet` entirely** — the host's quiet mode bypassed
     * rather than honoured, from inside plugin code, and unsilenceable by the
     * plugin's own control.
     *
     * The engine window is excluded here by construction: it *is* the one site,
     * and its own restore-and-swap discipline is what the non-reentrancy and
     * always-restore guarantee covers.
     */
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'] as const;
    const spies = methods.map(method =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );

    const sink = recordingSink();
    const channel = createOutputChannel(channelFacts(sink));
    channel.warn('a warning', ['detail']);
    channel.note('a note');
    channel.degraded(validNote());
    channel.describe();
    void channel.recorded;
    try {
      channel.degraded(validNote('engine-warning', { summary: '' }));
    } catch {
      // the refusal path counts too
    }
    for (const code of degradedCodes) {
      channel.degraded(validNote(code));
    }

    const called = spies
      .map((spy, index) => ({ method: methods[index], calls: spy.mock.calls.length }))
      .filter(entry => entry.calls > 0);
    expect(called).toEqual([]);
  });

  it('is handed to packaging as a mechanical rule the whole package can be scanned with', () => {
    // Extends the environment seam's non-reentrancy and always-restore guarantee
    // from the seam to the whole package: the same instrument applied to
    // `src/environment/**` must find the seam clean too, which is what makes the
    // rule package-wide rather than the option/result surface's private discipline.
    const engineOnly = sf10Sources().filter(source =>
      valueIdentifierNames(source).includes('console'),
    );
    expect(engineOnly.map(source => source.relative)).toEqual(['output/engine.ts']);
  });
});

// ---------------------------------------------------------------------------
// The capture window admits only a non-thenable return
// ---------------------------------------------------------------------------

describe('the capture window admits only a non-thenable return, and refuses rather than awaiting', () => {
  const thenables: readonly { readonly label: string; readonly build: () => () => unknown }[] = [
    { label: 'a resolved promise', build: () => () => Promise.resolve('value') },
    {
      label: 'an async arrow',
      build: () => async () => {
        await Promise.resolve();
        return 'value';
      },
    },
    {
      label: 'a hand-rolled thenable',
      build: () => () => ({
        then: (resolve: (value: string) => void): void => resolve('value'),
      }),
    },
  ];

  it.each(thenables)('refuses $label, naming the call, with the swap restored', ({ build }) => {
    const channel = createOutputChannel(channelFacts(recordingSink()));
    const original = console.error;
    let thrown: unknown;
    try {
      captureEngineWarnings(channel, 'validateUpgradeSafety', build());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EngineCallNotSynchronousError);
    const error = thrown as EngineCallNotSynchronousError;
    expect(error.call).toBe('validateUpgradeSafety');
    expect(error.code).toBe('ENGINE_CALL_NOT_SYNCHRONOUS');
    expect(error.message).toContain('validateUpgradeSafety');
    // The refusal names the enumerated bypass rather than leaving the reader to
    // guess whether the export is capturable at all.
    expect(error.message).toContain('uncapturedEngineWarnings');
    expect(console.error).toBe(original);
  });

  it('does not refuse a non-callable then, because that is not a promise', () => {
    const channel = createOutputChannel(channelFacts(recordingSink()));
    const returned = captureEngineWarnings(channel, 'getErrors', () => ({ then: 1 }));
    expect(returned).toEqual({ then: 1 });
  });

  it('admits a synchronous undefined, null, and falsy returns', () => {
    // A window that treated a falsy return as "no value" would refuse
    // `assertUpgradeSafe`, whose declared return is `void`.
    const channel = createOutputChannel(channelFacts(recordingSink()));
    expect(captureEngineWarnings(channel, 'assertUpgradeSafe', () => undefined)).toBeUndefined();
    expect(captureEngineWarnings(channel, 'getErrors', () => null)).toBeNull();
    expect(captureEngineWarnings(channel, 'getErrors', () => 0)).toBe(0);
    expect(captureEngineWarnings(channel, 'getErrors', () => '')).toBe('');
    expect(captureEngineWarnings(channel, 'getErrors', () => false)).toBe(false);
  });

  it('refuses a function carrying a callable then, since a function is thenable-capable', () => {
    const channel = createOutputChannel(channelFacts(recordingSink()));
    const thenableFunction = (): void => undefined;
    Object.defineProperty(thenableFunction, 'then', { value: () => undefined });
    expect(() =>
      captureEngineWarnings(channel, 'validate', () => thenableFunction),
    ).toThrow(EngineCallNotSynchronousError);
  });

  it('proves the refusal is not vacuous: the twin loses output in one direction and fabricates it in the other', async () => {
    /*
     * The two failure directions the invariant names, both counted.
     *
     * **Direction 1 — loss.** A window that returns the promise has already closed
     * by the time the engine's continuation writes, so the write reaches the real
     * `console.error` and **no note is recorded**. The guarded window refuses
     * instead, so the caller is told rather than quietly under-reported.
     *
     * **Direction 2 — theft.** A window that `await`s inside the swap yields to the
     * event loop while `console.error` is swapped, so unrelated code's write is
     * captured and re-emitted as a plugin engine warning — a **fabricated**
     * degraded note attributed to the engine.
     */
    const { logWarning } = upstreamLogWriters();
    const failures: string[] = [];

    // Direction 1, against the twin.
    const lossChannel = createOutputChannel(channelFacts(recordingSink()));
    const escaped: unknown[][] = [];
    const originalForLoss = console.error;
    let pending: Promise<unknown> | undefined;
    try {
      const returned = captureWithoutThenableCheck(lossChannel, () =>
        Promise.resolve().then(() => {
          atChalkLevel(0, () => logWarning('A warning the window never saw', []));
          return 'done';
        }),
      );
      console.error = (...args: unknown[]): void => void escaped.push(args);
      pending = Promise.resolve(returned);
      await pending;
    } finally {
      console.error = originalForLoss;
    }
    if (lossChannel.recorded.length !== 0) {
      failures.push('twin direction 1 unexpectedly captured the write');
    }
    if (escaped.length !== 1) {
      failures.push(`twin direction 1 escaped ${String(escaped.length)} writes, expected 1`);
    }

    // Direction 2, against the twin.
    const theftChannel = createOutputChannel(channelFacts(recordingSink()));
    await captureAwaitingInside(
      theftChannel,
      async () => {
        await Promise.resolve();
        return 'engine value';
      },
      () => {
        console.error('an unrelated write from concurrent code');
      },
    );
    if (theftChannel.recorded.length !== 1) {
      failures.push('twin direction 2 did not fabricate a note');
    }

    expect(failures).toEqual([]);
    // Named counts: one lost write, one fabricated note, three refusal shapes.
    expect(escaped).toHaveLength(1);
    expect(theftChannel.recorded).toHaveLength(1);
    expect(theftChannel.recorded[0]?.summary).toContain('unrelated write');
    expect(thenables).toHaveLength(3);

    // And the guarded window does neither, on the same three shapes.
    const guardedChannel = createOutputChannel(channelFacts(recordingSink()));
    for (const { build } of thenables) {
      expect(() =>
        captureEngineWarnings(guardedChannel, 'validateUpgradeSafety', build()),
      ).toThrow(EngineCallNotSynchronousError);
    }
    expect(guardedChannel.recorded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No await and no async function inside the capture window
// ---------------------------------------------------------------------------

describe('no await and no async function inside the capture window', () => {
  it('has no async modifier and no await expression anywhere in engine.ts', () => {
    const engine = sourceNamed('output/engine.ts');
    expect(engine.hasAsyncModifier).toBe(false);
    expect(engine.hasAwaitExpression).toBe(false);
  });

  it('calibrates the instrument: the words appear in prose, and prose is not syntax', () => {
    // The same class of trap as the console-usage canary's. `engine.ts` explains
    // the hazard in its own doc comments, so a text grep for `await` or `async`
    // returns hits on a module that is provably free of both.
    const engine = sourceNamed('output/engine.ts');
    expect(engine.text).toMatch(/await/);
    expect(engine.text).toMatch(/async/);
    // …and the AST disagrees with the grep, which is the point.
    expect(engine.hasAwaitExpression).toBe(false);
  });

  it('holds for every module in the three directories, not only for engine.ts', () => {
    // Handed to packaging as the static half of the two-part mechanical check.
    for (const source of sf10Sources()) {
      expect(source.hasAsyncModifier, `${source.relative}`).toBe(false);
      expect(source.hasAwaitExpression, `${source.relative}`).toBe(false);
    }
  });

  it('is backed at runtime by the thenable refusal, for a caller that violates the same rule', () => {
    // The static half cannot reach a caller's thunk, which is exactly why the
    // runtime refusal exists and why it is strictly stronger than a `.d.ts` claim.
    const channel = createOutputChannel(channelFacts(recordingSink()));
    expect(() =>
      captureEngineWarnings(channel, 'a caller-supplied async thunk', async () => {
        await Promise.resolve();
      }),
    ).toThrow(EngineCallNotSynchronousError);
  });
});

// ---------------------------------------------------------------------------
// The warning-capable export set is enumerated, split, and its hole named
// ---------------------------------------------------------------------------

describe('the warning-capable export set is enumerated, split, and its hole named', () => {
  it('derives the two subsets from the table rather than declaring them separately', () => {
    expect(engineWarningCapableExports).toHaveLength(10);
    expect(capturableEngineExports).toHaveLength(8);
    expect(uncapturableEngineExports).toHaveLength(2);
    // Together they equal the table, so a new async warning-capable export cannot
    // land in neither list — which is exactly the property this test checks.
    expect(capturableEngineExports.length + uncapturableEngineExports.length).toBe(
      engineWarningCapableExports.length,
    );
    expect([...capturableEngineExports, ...uncapturableEngineExports].sort((a, b) =>
      a.name.localeCompare(b.name),
    )).toEqual([...engineWarningCapableExports].sort((a, b) => a.name.localeCompare(b.name)));
    // …and they are disjoint.
    const capturableNames = new Set(capturableEngineExports.map(entry => entry.name));
    for (const entry of uncapturableEngineExports) {
      expect(capturableNames.has(entry.name)).toBe(false);
    }
  });

  it('splits on declared synchrony and nothing else', () => {
    for (const entry of capturableEngineExports) {
      expect(entry.declaredReturn).toBe('synchronous');
      expect(entry.warningSite.length).toBeGreaterThan(0);
    }
    for (const entry of uncapturableEngineExports) {
      expect(entry.declaredReturn).toBe('promise');
    }
    expect(uncapturableEngineExports.map(entry => entry.name).sort()).toEqual([
      'addProxyToManifest',
      'validateUpgradeSafety',
    ]);
  });

  it('names every uncaptured warning\'s owner, so the bypass has one', () => {
    expect(uncapturedEngineWarnings).toHaveLength(1);
    const [hole] = uncapturedEngineWarnings;
    expect(hole?.engineExport).toBe('addProxyToManifest');
    expect(hole?.owner).toBe('the proxy deployment operations');
    // Every uncaptured warning belongs to an export the table calls uncapturable —
    // an entry for a *capturable* export would mean the capture had a hole nobody
    // had explained.
    const uncapturableNames = new Set(uncapturableEngineExports.map(entry => entry.name));
    for (const entry of uncapturedEngineWarnings) {
      expect(uncapturableNames.has(entry.engineExport)).toBe(true);
    }
  });

  it('freezes the table and both derived subsets', () => {
    expect(Object.isFrozen(engineWarningCapableExports)).toBe(true);
    expect(Object.isFrozen(capturableEngineExports)).toBe(true);
    expect(Object.isFrozen(uncapturableEngineExports)).toBe(true);
    expect(Object.isFrozen(uncapturedEngineWarnings)).toBe(true);
  });

  it('makes the wrong fix impossible rather than merely discouraged', () => {
    // The fix a reader reaches for first is wrapping the async call in the window.
    // The thenable refusal refuses it outright, which is what keeps the DOCUMENT
    // disposition honest — there is no way to accidentally "handle" the hole.
    const channel = createOutputChannel(channelFacts(recordingSink()));
    for (const entry of uncapturableEngineExports) {
      expect(() =>
        captureEngineWarnings(channel, entry.name, () => Promise.resolve()),
      ).toThrow(EngineCallNotSynchronousError);
    }
  });
});

// ---------------------------------------------------------------------------
// No channel write occurs while console.error is swapped
// ---------------------------------------------------------------------------

describe('no channel write occurs while console.error is swapped', () => {
  it('records exactly one note per upstream write through a console-backed sink', () => {
    /*
     * The hazard, verbatim: on the un-quieted CLI path the injected sink **is**
     * `console` (`build/index.js:var options = { logger: console }`), so a relay
     * running inside the window would feed its own stub — an unbounded loop in the
     * worst case and a duplicated, mislabelled note in the mild one.
     */
    const { logWarning } = upstreamLogWriters();
    const channel = createOutputChannel(channelFacts(consoleBackedSink()));
    const advisory: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => void advisory.push(args);
    try {
      captureEngineWarnings(channel, 'getErrors', () => {
        atChalkLevel(0, () => logWarning('One upstream warning', ['one detail']));
        return 'result';
      });
    } finally {
      console.error = original;
    }
    // One upstream write, one recorded note. Not two, and no recursion.
    expect(channel.recorded).toHaveLength(1);
    // The sink's own advisory write landed on the *restored* `console.error`,
    // which is the observable proof the flush happened after the restore.
    expect(advisory).toHaveLength(1);
    expect(String(advisory[0]?.[0])).toContain('One upstream warning');
  });

  it('buffers a whole batch and flushes it once, in order', () => {
    const { logWarning } = upstreamLogWriters();
    const channel = createOutputChannel(channelFacts(recordingSink()));
    captureEngineWarnings(channel, 'validate', () => {
      atChalkLevel(0, () => {
        logWarning('first', []);
        logWarning('second', []);
        logWarning('third', []);
      });
      return undefined;
    });
    expect(channel.recorded.map(note => note.summary)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('drains the buffer, so a second call cannot replay it', () => {
    const { logWarning } = upstreamLogWriters();
    const channel = createOutputChannel(channelFacts(recordingSink()));
    captureEngineWarnings(channel, 'validate', () => {
      atChalkLevel(0, () => logWarning('only once', []));
      return undefined;
    });
    captureEngineWarnings(channel, 'validate', () => undefined);
    expect(channel.recorded).toHaveLength(1);
  });

  it('proves the buffering is not vacuous: the in-window twin feeds its own stub', () => {
    /*
     * The named count: one upstream write, and the twin records **two** notes —
     * the real one plus its own advisory echo, captured by the stub that was still
     * installed. That is the duplicated, mislabelled note the invariant names, and
     * it is the mild case; with a sink that echoed more than once it is unbounded.
     */
    const { logWarning } = upstreamLogWriters();
    const twinChannel = createOutputChannel(channelFacts(consoleBackedSink()));
    const original = console.error;
    try {
      captureRelayingInsideWindow(twinChannel, () => {
        atChalkLevel(0, () => logWarning('One upstream warning', []));
        return undefined;
      });
    } finally {
      console.error = original;
    }
    expect(twinChannel.recorded.length).toBeGreaterThanOrEqual(2);

    // The same drive through the shipped window records exactly one.
    const guardedChannel = createOutputChannel(channelFacts(consoleBackedSink()));
    const advisory: unknown[][] = [];
    const secondOriginal = console.error;
    console.error = (...args: unknown[]): void => void advisory.push(args);
    try {
      captureEngineWarnings(guardedChannel, 'getErrors', () => {
        atChalkLevel(0, () => logWarning('One upstream warning', []));
        return undefined;
      });
    } finally {
      console.error = secondOriginal;
    }
    expect(guardedChannel.recorded).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The swap is non-reentrant and always restored
// ---------------------------------------------------------------------------

describe('the swap is non-reentrant and always restored', () => {
  it('restores the exact saved value on all three exit paths', () => {
    /*
     * An engine call that throws is the **common** case, not the exception, since
     * `assertUpgradeSafe` and `assertStorageUpgradeSafe` exist to throw. Leaving
     * the stub installed would swallow every later `console.error` in the
     * migration, including TronBox's own, into a dead buffer.
     */
    const channel = createOutputChannel(channelFacts(recordingSink()));
    const original = console.error;

    expect(captureEngineWarnings(channel, 'getErrors', () => 'ok')).toBe('ok');
    expect(console.error).toBe(original);

    expect(() =>
      captureEngineWarnings(channel, 'assertUpgradeSafe', () => {
        throw new Error('the engine refused');
      }),
    ).toThrow('the engine refused');
    expect(console.error).toBe(original);

    expect(() =>
      captureEngineWarnings(channel, 'validateUpgradeSafety', () => Promise.resolve()),
    ).toThrow(EngineCallNotSynchronousError);
    expect(console.error).toBe(original);
  });

  it('keeps the buffer across a throw, because upstream warns before it throws', () => {
    // Upstream writes its warnings for *allowed* errors before throwing on a
    // disallowed one, so dropping the buffer on the throw path would discard real
    // warnings. The buffer is caller-owned for exactly this reason.
    const { logWarning } = upstreamLogWriters();
    const channel = createOutputChannel(channelFacts(recordingSink()));
    expect(() =>
      captureEngineWarnings(channel, 'assertUpgradeSafe', () => {
        atChalkLevel(0, () => logWarning('An allowed error was tolerated', []));
        throw new Error('but this one was not');
      }),
    ).toThrow('but this one was not');
    expect(channel.recorded).toHaveLength(1);
    expect(channel.recorded[0]?.summary).toBe('An allowed error was tolerated');
  });

  it('refuses a nested invocation, naming both calls', () => {
    const channel = createOutputChannel(channelFacts(recordingSink()));
    const original = console.error;
    let thrown: unknown;
    captureEngineWarnings(channel, 'validate', () => {
      try {
        captureEngineWarnings(channel, 'getErrors', () => 'inner');
      } catch (error) {
        thrown = error;
      }
      return 'outer';
    });
    expect(thrown).toBeInstanceOf(EngineCaptureReentrantError);
    const error = thrown as EngineCaptureReentrantError;
    expect(error.call).toBe('getErrors');
    expect(error.activeCall).toBe('validate');
    expect(error.message).toContain('getErrors');
    expect(error.message).toContain('validate');
    expect(console.error).toBe(original);
  });

  it('reopens cleanly after a refusal, so the guard is not a one-way latch', () => {
    const channel = createOutputChannel(channelFacts(recordingSink()));
    captureEngineWarnings(channel, 'validate', () => {
      expect(() => captureEngineWarnings(channel, 'getErrors', () => 1)).toThrow(
        EngineCaptureReentrantError,
      );
      return 'outer';
    });
    // The module-scope guard is cleared in the `finally`, so a later window opens.
    expect(captureEngineWarnings(channel, 'getErrors', () => 'later')).toBe('later');
  });

  it('proves both guards are non-vacuous: the twins break two named cases each', () => {
    /*
     * **Twin 1 — no `finally`.** Of its two exit paths, the throwing one leaves the
     * stub installed. The shipped window restores on all three of its paths.
     *
     * **Twin 2 — no re-entrancy guard.** Nesting is allowed, and the inner
     * `finally` restores to the *outer stub* before flushing — so the inner flush's
     * advisory write is captured by the outer buffer and re-emitted as a
     * fabricated engine warning. One upstream write becomes two notes.
     */
    const { logWarning } = upstreamLogWriters();
    const twinFailures: string[] = [];

    const noFinallyChannel = createOutputChannel(channelFacts(recordingSink()));
    const originalForTwin = console.error;
    try {
      captureWithoutFinally(noFinallyChannel, () => {
        throw new Error('the engine refused');
      });
    } catch {
      if (console.error !== originalForTwin) {
        twinFailures.push('twin 1: the stub survived the throw');
      }
    } finally {
      console.error = originalForTwin;
    }

    const reentrantChannel = createOutputChannel(channelFacts(consoleBackedSink()));
    const originalForNesting = console.error;
    try {
      captureWithoutReentrancyGuard(reentrantChannel, () => {
        captureWithoutReentrancyGuard(reentrantChannel, () => {
          atChalkLevel(0, () => logWarning('One upstream warning', []));
          return undefined;
        });
        return undefined;
      });
    } finally {
      console.error = originalForNesting;
    }
    if (reentrantChannel.recorded.length > 1) {
      twinFailures.push('twin 2: nesting fabricated an extra note');
    }

    // Two named cases, one per twin.
    expect(twinFailures).toEqual([
      'twin 1: the stub survived the throw',
      'twin 2: nesting fabricated an extra note',
    ]);

    // The shipped window breaks neither.
    const guarded = createOutputChannel(channelFacts(consoleBackedSink()));
    const original = console.error;
    expect(() =>
      captureEngineWarnings(guarded, 'assertUpgradeSafe', () => {
        throw new Error('the engine refused');
      }),
    ).toThrow();
    expect(console.error).toBe(original);
    captureEngineWarnings(guarded, 'validate', () => {
      expect(() => captureEngineWarnings(guarded, 'getErrors', () => 1)).toThrow(
        EngineCaptureReentrantError,
      );
      return undefined;
    });
    expect(console.error).toBe(original);
  });

  it('keeps the re-entrancy guard as the one permitted extra module binding', () => {
    // Enumerated elsewhere as part of the package-wide audit of permitted
    // module-scope bindings, rather than discovered here; asserted here because
    // this is the guarantee that introduces it.
    const engine = sourceNamed('output/engine.ts');
    expect(engine.topLevelMutableBindings).toEqual(['activeCall']);
  });
});

// ---------------------------------------------------------------------------
// The relay preserves upstream text and level, and records both levels
// ---------------------------------------------------------------------------

describe('the relay preserves upstream text and level, and records both levels', () => {
  it('records identical text with colour forced on and off', () => {
    /*
     * Driven through upstream's **real** writers rather than a hand-written string.
     * `dist/utils/log.js:log` builds `chalk.yellow.bold(prefix + ':') + ' ' + title
     * + '\n'` with `indent(l, 4)` detail lines and passes the whole thing to
     * `console.error` as **one** argument — verified present at
     * `@openzeppelin/upgrades-core@1.46.0`. `chalk@4.1.2` auto-detects the
     * terminal, so the same upstream code path emits codes or not depending on the
     * environment; a recorded note whose text depended on whether a TTY was
     * attached would be untestable, which is why the strip is unconditional.
     */
    const { logWarning, logNote } = upstreamLogWriters();
    const capture = (level: number): readonly DegradedNote[] => {
      const channel = createOutputChannel(channelFacts(recordingSink()));
      captureEngineWarnings(channel, 'validate', () =>
        atChalkLevel(level, () => {
          logWarning('Potentially unsafe deployment of Box', [
            'You are using the unsafeAllow.delegatecall flag.',
            'Make sure you have manually checked the call.',
          ]);
          logNote('Reinitializers are not included in validations by default', [
            'Use validateUpgrade to check a reinitializer.',
          ]);
          return undefined;
        }),
      );
      return channel.recorded;
    };

    const coloured = capture(3);
    const plain = capture(0);
    expect(coloured).toEqual(plain);
    expect(coloured).toHaveLength(2);
    for (const note of coloured) {
      // No escape byte survives, in either direction.
      expect(note.summary).not.toMatch(//);
      for (const line of note.detail) {
        expect(line).not.toMatch(//);
      }
    }
  });

  it('preserves the level: a Warning is engine-warning and a Note is engine-note', () => {
    /*
     * Both are recorded, because a note that a class of construct was **excluded
     * from validation** is a reduced-fidelity validation statement by the
     * degraded-mode disclosure requirement's own definition —
     * `dist/validate/run/initializer.js:getPossibleInitializers`
     * reports *"Reinitializers are not included in validations by default"* through
     * `logNote`. Dropping it would leave a hole in that requirement; recording it
     * as a warning would mislabel it.
     */
    const { logWarning, logNote } = upstreamLogWriters();
    const channel = createOutputChannel(channelFacts(recordingSink()));
    captureEngineWarnings(channel, 'validate', () =>
      atChalkLevel(0, () => {
        logWarning('a warning title', ['warning detail']);
        logNote('a note title', ['note detail']);
        return undefined;
      }),
    );
    expect(channel.recorded.map(note => note.code)).toEqual([
      'engine-warning',
      'engine-note',
    ]);
    expect(channel.recorded[0]?.summary).toBe('a warning title');
    expect(channel.recorded[0]?.detail).toEqual(['warning detail']);
    expect(channel.recorded[1]?.summary).toBe('a note title');
    expect(channel.recorded[1]?.detail).toEqual(['note detail']);
    // Different remedies, because the two levels ask different things of the user.
    expect(channel.recorded[0]?.remedy).not.toBe(channel.recorded[1]?.remedy);
    expect(channel.recorded[1]?.remedy).toContain('Informational');
  });

  it('records an unrecognized prefix as engine-warning — the stricter level — and never drops it', () => {
    // If upstream adds a third level or changes its prefix, the plugin
    // over-reports rather than under-reports.
    const channel = createOutputChannel(channelFacts(recordingSink()));
    captureEngineWarnings(channel, 'validate', () => {
      console.error('Advisory: a level this plugin does not know');
      console.error('no prefix at all');
      return undefined;
    });
    expect(channel.recorded.map(note => note.code)).toEqual([
      'engine-warning',
      'engine-warning',
    ]);
    expect(channel.recorded[0]?.summary).toBe(
      'Advisory: a level this plugin does not know',
    );
    expect(channel.recorded[1]?.summary).toBe('no prefix at all');
  });

  it('discards no captured write, including a blank one', () => {
    const channel = createOutputChannel(channelFacts(recordingSink()));
    captureEngineWarnings(channel, 'validate', () => {
      console.error('');
      console.error('   ');
      console.error('Warning: a real one');
      return undefined;
    });
    expect(channel.recorded).toHaveLength(3);
    expect(channel.recorded[0]?.summary).toContain('empty line to console.error');
    expect(channel.recorded[1]?.summary).toContain('empty line to console.error');
    expect(channel.recorded[2]?.summary).toBe('a real one');
  });

  it('renders a non-string argument by type, without calling into it', () => {
    // Upstream writes exactly one string argument, so a non-string is not
    // upstream's format. `String(value)` would throw on a symbol and would invoke
    // a caller-supplied `toString` — either would make the relay itself fail inside
    // the one code path that must not.
    const channel = createOutputChannel(channelFacts(recordingSink()));
    const hostile = {
      toString(): string {
        throw new Error('toString must not be reached');
      },
    };
    expect(() =>
      captureEngineWarnings(channel, 'validate', () => {
        console.error(hostile);
        console.error(Symbol('s'));
        console.error(1, 'and a string');
        return undefined;
      }),
    ).not.toThrow();
    expect(channel.recorded).toHaveLength(3);
    expect(channel.recorded[0]?.summary).toBe('[object]');
    expect(channel.recorded[1]?.summary).toBe('[symbol]');
    expect(channel.recorded[2]?.summary).toBe('[number] and a string');
  });

  it('strips ANSI idempotently, so a re-strip changes nothing', () => {
    const { logWarning } = upstreamLogWriters();
    const first = createOutputChannel(channelFacts(recordingSink()));
    captureEngineWarnings(first, 'validate', () =>
      atChalkLevel(3, () => logWarning('already stripped once', [])),
    );
    const second = createOutputChannel(channelFacts(recordingSink()));
    captureEngineWarnings(second, 'validate', () => {
      console.error(`Warning: ${first.recorded[0]?.summary ?? ''}`);
      return undefined;
    });
    expect(second.recorded[0]?.summary).toBe(first.recorded[0]?.summary);
  });

  it('never makes channel.degraded throw from inside the relay', () => {
    // `engineNote` is total by construction — `summary` and `remedy` are always
    // non-empty — which matters because the relay runs in a `finally` where a
    // throw would mask the engine's own error.
    const channel = createOutputChannel(channelFacts(throwingSink()));
    expect(() =>
      captureEngineWarnings(channel, 'assertUpgradeSafe', () => {
        console.error('');
        throw new Error('the engine\'s own error must survive');
      }),
    ).toThrow("the engine's own error must survive");
    expect(channel.recorded).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DegradedCode is one closed union and every reduced-fidelity path has a member
// ---------------------------------------------------------------------------

describe('DegradedCode is one closed union and every reduced-fidelity path has a member', () => {
  it('covers every union member with at least one constructed note', () => {
    // The degraded-mode disclosure requirement's own *"each such path is covered by
    // at least one test"*, made mechanical by iterating data instead of a
    // hand-written list that silently falls behind.
    const channel = createOutputChannel(channelFacts(recordingSink()));
    for (const code of degradedCodes) {
      const note = channel.degraded(validNote(code));
      expect(note.code).toBe(code);
    }
    expect(channel.recorded.map(note => note.code)).toEqual([...degradedCodes]);
  });

  it('enumerates the six members the plugin ships, including the truncation code', () => {
    expect([...degradedCodes]).toEqual([
      'namespaced-ast-only',
      'storage-layout-unavailable',
      'artifact-name-indeterminate',
      'engine-warning',
      'engine-note',
      'notes-truncated',
    ]);
    // `notes-truncated` is an implementation addition, because the truncation
    // note **is** a `DegradedNote` and the closed-union guarantee requires exactly
    // one member per reduced-fidelity path. Reusing any of the other five would
    // mislabel it; omitting one would make truncation the silent degraded path the
    // degraded-mode disclosure requirement forbids.
    expect(degradedCodes).toContain('notes-truncated');
  });

  it('refuses a code outside the union at compile time', () => {
    // @ts-expect-error DegradedCode is closed — no sub-feature may invent a member.
    const invented: DegradedCode = 'namespace-check-skipped';
    expect(invented).toBe('namespace-check-skipped');
  });

  it('declares the union in exactly one module, which is what makes the audit one place', () => {
    const declaring = sf10Sources().filter(source =>
      source.text.includes('export type DegradedCode'),
    );
    expect(declaring.map(source => source.relative)).toEqual(['output/types.ts']);
  });

  it('declares no degradation-shaped boolean on any result type', () => {
    /*
     * The other half: no sub-feature may invent an out-of-band degraded signal —
     * not a boolean on a result, not a magic string, not a log line. Two lists, or
     * a boolean on one result, and the audit becomes a grep.
     */
    const results = sourceNamed('results/types.ts');
    const suspicious = /degraded|fallback|partial|approximate|unavailable|incomplete/i;
    const booleanMembers = results.text
      .split('\n')
      .filter(line => /:\s*boolean/.test(line))
      .map(line => line.trim());
    expect(booleanMembers).toEqual([]);
    // And no member name hints at a degraded signal by another spelling.
    const memberNames = results.identifiers
      .filter(use => use.isPropertyName && use.inTypePosition)
      .map(use => use.name);
    expect(memberNames.filter(name => suspicious.test(name))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DegradedNote fields are total and frozen
// ---------------------------------------------------------------------------

describe('DegradedNote fields are total and frozen', () => {
  it.each([
    { field: 'summary' as const, note: validNote('engine-warning', { summary: '' }) },
    { field: 'summary' as const, note: validNote('engine-warning', { summary: '   \t ' }) },
    { field: 'remedy' as const, note: validNote('engine-warning', { remedy: '' }) },
    { field: 'remedy' as const, note: validNote('engine-warning', { remedy: '\n' }) },
  ])('refuses an empty $field with a typed error naming the channel', ({ field, note }) => {
    /*
     * A note that says a path degraded but not what to do about it satisfies the
     * degraded-mode disclosure requirement's letter and defeats its purpose — the
     * user learns something is wrong and has no next step. The note's producer is
     * always plugin code, so this is a plugin defect, which is why the message
     * names the channel's provenance rather than an option.
     */
    const channel = createOutputChannel(
      channelFacts(recordingSink(), 'config-lineage', true),
    );
    let thrown: unknown;
    try {
      channel.degraded(note);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DegradedNoteInvalidError);
    const error = thrown as DegradedNoteInvalidError;
    expect(error.field).toBe(field);
    expect(error.code).toBe('DEGRADED_NOTE_INVALID');
    expect(error.message).toContain('config-lineage');
    // Refused *before* the record, so a malformed note can never reach `recorded`.
    expect(channel.recorded).toEqual([]);
  });

  it('refuses a non-array detail, which only a JavaScript producer can supply', () => {
    const channel = createOutputChannel(channelFacts(recordingSink()));
    const malformed: DegradedNote = validNote();
    Object.defineProperty(malformed, 'detail', {
      value: 'a single string',
      enumerable: true,
    });
    let thrown: unknown;
    try {
      channel.degraded(malformed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DegradedNoteInvalidError);
    expect((thrown as DegradedNoteInvalidError).field).toBe('detail');
    expect((thrown as DegradedNoteInvalidError).message).toContain('not an array');
  });

  it('accepts an empty detail, because it may be empty and never absent', () => {
    const channel = createOutputChannel(channelFacts(recordingSink()));
    const note = channel.degraded(validNote('engine-note', { detail: [] }));
    expect(note.detail).toEqual([]);
    expect(Array.isArray(note.detail)).toBe(true);
  });

  it('freezes the note and its detail before either reaches recorded', () => {
    const channel = createOutputChannel(channelFacts(recordingSink()));
    const note = channel.degraded(validNote());
    expect(Object.isFrozen(note)).toBe(true);
    expect(Object.isFrozen(note.detail)).toBe(true);
    expect(Reflect.set(note, 'summary', 'rewritten')).toBe(false);
    expect(() => Reflect.apply(Array.prototype.push, note.detail, ['x'])).toThrow(
      TypeError,
    );
    // An unfrozen note would let a later consumer mutate a record the caller already
    // read, so the recorded copy is frozen too.
    expect(Object.isFrozen(channel.recorded[0])).toBe(true);
  });

  it('copies the caller\'s detail array, so a later mutation cannot reach the record', () => {
    const detail = ['first'];
    const channel = createOutputChannel(channelFacts(recordingSink()));
    const note = channel.degraded(validNote('engine-warning', { detail }));
    detail.push('second');
    expect(note.detail).toEqual(['first']);
  });
});

// ---------------------------------------------------------------------------
// origin is provenance — no branch reads it, or hostQuietRequested, to decide
// whether to write
// ---------------------------------------------------------------------------

describe('origin is provenance — no branch reads it, or hostQuietRequested, to decide whether to write', () => {
  it('reads neither value in any condition, anywhere in the three directories', () => {
    /*
     * The instrument matches the property rather than the wording: the invariant
     * forbids reading either value **in a conditional that controls emission,
     * recording, or degraded-path selection**, and the channel legitimately copies
     * `origin` onto itself and legitimately interpolates both into `describe()`.
     * So the scan collects condition expressions — `if`, ternary, `&&`, `||`,
     * `??`, `switch`, loop guards — and asserts neither name appears in one.
     */
    for (const source of sf10Sources()) {
      for (const condition of conditionExpressions(source)) {
        expect(
          condition,
          `${source.relative}: no condition may read origin or hostQuietRequested`,
        ).not.toMatch(/\borigin\b|\bhostQuietRequested\b/);
      }
    }
  });

  it('produces identical writes and identical recorded across all four combinations', () => {
    /*
     * Neither value carries liveness, verified byte-identical on 4.9.0 and 4.8.0:
     * `migrate --quiet` replaces `options.logger` **before** `Config.detect`, so
     * `origin: 'deployer'` discards under `--quiet`; `lib/test.js` passes a noop
     * unconditionally, so `'deployer'` discards on every `tronbox test` run;
     * `Config` defaults `logger` to `{ log(){} }`, so `'config-lineage'` discards in
     * the one context it occurs. `hostQuietRequested` is worse — `Config`'s `props`
     * table has no `quiet` key and `lib/commands/test.js` does not declare `quiet`
     * at all, so a config-file `quiet: true` yields `config.quiet === true`
     * alongside `config.logger === console`. Any branch on either value is a coin
     * flip presented as a decision.
     */
    const observations = FACT_COMBINATIONS.map(combination => {
      const sink = recordingSink();
      const channel = createOutputChannel(
        channelFacts(sink, combination.origin, combination.hostQuietRequested),
      );
      channel.warn('a warning', ['detail']);
      channel.note('a note');
      channel.degraded(validNote('engine-note'));
      return {
        combination,
        writes: sink.calls.map(call => call[0]),
        recorded: channel.recorded,
        origin: channel.origin,
        description: channel.describe(),
      };
    });

    expect(observations).toHaveLength(4);
    const [first, ...rest] = observations;
    for (const observation of rest) {
      expect(observation.writes).toEqual(first?.writes);
      expect(observation.recorded).toEqual(first?.recorded);
    }
    expect(first?.writes).toHaveLength(3);
  });

  it('is not vacuous, because describe() reads both and every combination differs', () => {
    /*
     * **Without a composition site this invariant is vacuous** — the fields would
     * be stored and never read, and "neither is read in a conditional" would hold
     * trivially. `describe()` is that site, and it is the only place either
     * is read. Four distinct descriptions is the proof that both values reach it.
     */
    const descriptions = FACT_COMBINATIONS.map(combination =>
      createOutputChannel(
        channelFacts(recordingSink(), combination.origin, combination.hostQuietRequested),
      ).describe(),
    );
    expect(new Set(descriptions).size).toBe(4);
    for (const [index, combination] of FACT_COMBINATIONS.entries()) {
      expect(descriptions[index]).toContain(combination.origin);
      expect(descriptions[index]).toContain(String(combination.hostQuietRequested));
    }
  });

  it('reads hostQuietRequested only inside describe, and origin only there or as provenance', () => {
    const channel = sourceNamed('output/channel.ts');
    // The reads are property accesses off the injected `facts`, so they need the
    // chain-aware instrument rather than the identifier-based one used for the
    // console-usage canary.
    expect(enclosingFunctionsOfChain(channel, 'facts.hostQuietRequested')).toEqual([
      'describe',
    ]);
    /*
     * `facts.origin` is read twice: once inside `describe`, and once in
     * `createOutputChannel`'s returned object literal to publish `channel.origin` —
     * the provenance field the origin-is-provenance rule itself allows, since it
     * is a value a failure message can name rather than a branch. Both sites are
     * asserted so a third one cannot appear silently.
     */
    expect([...enclosingFunctionsOfChain(channel, 'facts.origin')].sort()).toEqual([
      'createOutputChannel',
      'describe',
    ]);
    // No other module in the three directories reads either fact at all.
    for (const source of sf10Sources()) {
      if (source.relative === 'output/channel.ts') {
        continue;
      }
      expect(
        source.accessChains.filter(chain => /\.(origin|hostQuietRequested)$/.test(chain)),
        `${source.relative} must not read the channel's provenance facts`,
      ).toEqual([]);
    }
  });

  it('exposes origin on the channel as provenance for a failure message', () => {
    for (const combination of FACT_COMBINATIONS) {
      const channel = createOutputChannel(
        channelFacts(recordingSink(), combination.origin, combination.hostQuietRequested),
      );
      expect(channel.origin).toBe(combination.origin);
    }
  });
});

// ---------------------------------------------------------------------------
// A result's notes is exactly the channel's recorded, in call order
// ---------------------------------------------------------------------------

describe('a result\'s notes is exactly the channel\'s recorded, in call order', () => {
  it('preserves call order with nothing added, reordered, deduplicated or dropped', () => {
    const channel = createOutputChannel(channelFacts(recordingSink()));
    const codes: readonly DegradedCode[] = [
      'storage-layout-unavailable',
      'namespaced-ast-only',
      'artifact-name-indeterminate',
    ];
    for (const code of codes) {
      channel.degraded(validNote(code, { summary: `note for ${code}` }));
    }
    const notes = operationNotes(channel.recorded);
    expect(notes.map(note => note.code)).toEqual([...codes]);
    expect(notes.map(note => note.summary)).toEqual(codes.map(code => `note for ${code}`));
    expect(Object.isFrozen(notes)).toBe(true);
  });

  it('does not deduplicate two identical notes', () => {
    // A note about a fallback appearing before the note about the condition that
    // caused it would be a diagnostic that misleads about causation — and a
    // dedupe would drop the second occurrence of a condition that recurred.
    const channel = createOutputChannel(channelFacts(recordingSink()));
    channel.degraded(validNote('engine-warning', { summary: 'the same thing twice' }));
    channel.degraded(validNote('engine-warning', { summary: 'the same thing twice' }));
    expect(operationNotes(channel.recorded)).toHaveLength(2);
  });

  it('snapshots at the return boundary, so later notes do not reach an issued result', () => {
    const channel = createOutputChannel(channelFacts(recordingSink()));
    channel.degraded(validNote('engine-warning', { summary: 'first' }));
    const issued = operationNotes(channel.recorded);
    channel.degraded(validNote('engine-note', { summary: 'second' }));
    expect(issued).toHaveLength(1);
    expect(channel.recorded).toHaveLength(2);
  });

  it('returns a fresh frozen snapshot on every read of recorded', () => {
    const channel = createOutputChannel(channelFacts(recordingSink()));
    channel.degraded(validNote());
    const first = channel.recorded;
    const second = channel.recorded;
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    // The notes themselves are the same objects — the snapshot is one level, which
    // is what keeps `notes` a view of what happened rather than a copy of it.
    expect(first[0]).toBe(second[0]);
  });
});
