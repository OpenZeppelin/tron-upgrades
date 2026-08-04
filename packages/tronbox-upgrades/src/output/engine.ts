import type { DegradedCode, DegradedNote, OutputChannel } from './types';

/**
 * Routes `@openzeppelin/upgrades-core`'s own warning output onto the plugin's
 * channel, so engine warnings honour TronBox's quiet mode and the plugin's
 * silencing control instead of going straight to the terminal.
 *
 * **Why capture rather than reconstruct.** Upstream's `dist/utils/log.js` writes
 * every `logWarning` and `logNote` to `console.error` behind a private
 * module-level flag, with no redirect hook, no dedupe and no reset — verified
 * present at `@openzeppelin/upgrades-core@1.46.0`. Capturing preserves upstream's
 * exact text; reconstructing would fork it.
 *
 * **Why the bypass matters.** Without this, an engine warning reaches the terminal
 * through `console.error` with ANSI colour from `chalk`, bypassing both TronBox's
 * quiet mode and the plugin's own control — the exact bypass SF-10 scenario 5
 * forbids, arriving through a dependency rather than through plugin code. TronBox
 * injects the real `console` into the migration sandbox
 * (`src/components/Require.js`), so nothing downstream of it honours `--quiet`.
 *
 * INV-26: the save-and-swap in {@link runCaptureWindow} is the **only** reference
 * to `console` in `src/options/**`, `src/output/**` and `src/results/**`, and no
 * module in the three directories ever *writes* to it.
 *
 * INV-28: no `await`, no `for await`, no `yield`, and no `async` function in this
 * module. The runtime backstop for a caller that violates the same rule is
 * INV-27's thenable refusal below.
 */

/** One `upgrades-core` root export that can reach `dist/utils/log.js`. */
export interface EngineWarningCapableExport {
  readonly name: string;
  /**
   * `'synchronous'` exports are capturable and must be called inside the window.
   * `'promise'` exports are **not** capturable — see
   * {@link uncapturedEngineWarnings}.
   */
  readonly declaredReturn: 'synchronous' | 'promise';
  /** Where the write originates, as a path-and-symbol citation. */
  readonly warningSite: string;
}

/**
 * INV-29: the warning-capable root-export set, recorded as data and split by
 * declared synchrony.
 *
 * **Verified present at `@openzeppelin/upgrades-core@1.46.0`**, as installed:
 * every listed export exists on the root, and `addProxyToManifest`
 * and `validateUpgradeSafety` are both `AsyncFunction`. The table exists because
 * the hand-written seven-name list it replaced was wrong in both directions — it
 * named two exports that cannot warn at all (`withValidationDefaults`,
 * `inferProxyKind`) and omitted four that can, two of which return `Promise`
 * today. A hand-written list is what made a present-state error look like a
 * future risk; a table with a canary over it is what makes the next change a
 * failing test.
 *
 * A test derives or asserts this against the installed `dist` and fails when it
 * changes. Failing loudly on an `upgrades-core` bump is the whole point, and it is
 * what makes {@link uncapturedEngineWarnings}'s revisit *triggered* rather than
 * remembered.
 */
export const engineWarningCapableExports: readonly EngineWarningCapableExport[] =
  Object.freeze([
    {
      name: 'getErrors',
      declaredReturn: 'synchronous',
      warningSite:
        'dist/validate/overrides.js:processExceptions, via dist/validate/query.js',
    },
    {
      name: 'assertUpgradeSafe',
      declaredReturn: 'synchronous',
      warningSite: 'same, via getErrors',
    },
    {
      name: 'getStorageUpgradeReport',
      declaredReturn: 'synchronous',
      warningSite:
        'dist/storage/index.js:getStorageUpgradeReport (logWarning and logNote)',
    },
    {
      name: 'assertStorageUpgradeSafe',
      declaredReturn: 'synchronous',
      warningSite: 'same, via getStorageUpgradeReport',
    },
    {
      name: 'getStorageUpgradeErrors',
      declaredReturn: 'synchronous',
      warningSite: 'same, via assertStorageUpgradeSafe',
    },
    {
      name: 'validate',
      declaredReturn: 'synchronous',
      warningSite:
        'dist/validate/run.js:assertNotNamespace; ' +
        'dist/validate/run/initializer.js:getPossibleInitializers; ' +
        'dist/storage/namespace.js:warnIfCustomLayoutAndNamespacesFound',
    },
    {
      name: 'UpgradeableContract',
      declaredReturn: 'synchronous',
      warningSite: 'dist/standalone.js constructor, via getErrors',
    },
    {
      name: 'silenceWarnings',
      declaredReturn: 'synchronous',
      warningSite:
        'dist/utils/log.js:silenceWarnings — writes its own farewell notice ' +
        'before setting the flag',
    },
    {
      name: 'addProxyToManifest',
      declaredReturn: 'promise',
      warningSite: 'dist/add-proxy-to-manifest.js:addProxyToManifest',
    },
    {
      name: 'validateUpgradeSafety',
      declaredReturn: 'promise',
      warningSite: 'via validate',
    },
  ]);

/**
 * The subset the capture window covers. Derived from
 * {@link engineWarningCapableExports}, never declared separately, so the two
 * subsets cannot drift from the table or from each other.
 */
export const capturableEngineExports: readonly EngineWarningCapableExport[] =
  Object.freeze(
    engineWarningCapableExports.filter(
      entry => entry.declaredReturn === 'synchronous',
    ),
  );

/** The subset the capture window cannot cover (INV-30). Derived, as above. */
export const uncapturableEngineExports: readonly EngineWarningCapableExport[] =
  Object.freeze(
    engineWarningCapableExports.filter(
      entry => entry.declaredReturn === 'promise',
    ),
  );

/** A warning that reaches the terminal outside the plugin's channel. */
export interface UncapturedEngineWarning {
  readonly engineExport: string;
  /** The first line, verbatim, so a user can match what they actually saw. */
  readonly text: string;
  /** The indented lines that follow it, verbatim. */
  readonly detail: readonly string[];
  /** The condition under which upstream emits it. */
  readonly trigger: string;
  /** The sub-feature that owns documenting and testing this bypass. */
  readonly owner: string;
}

/**
 * INV-30: the enumerated hole, with the specific text named.
 *
 * The capture mechanism covers {@link capturableEngineExports} and no more.
 * Warnings from an asynchronous engine export are **not** captured: they reach
 * the terminal through `console.error` with ANSI colour from `chalk@4.1.2`,
 * bypassing both TronBox's quiet mode and `silenceWarnings()`.
 *
 * **The disposition is DOCUMENT, not remedy** — settled deliberately. The rejected
 * alternative was to pre-check `manifest.getAdmin()` and emit the plugin's own
 * note before calling, which duplicates upstream's condition and can drift; **a
 * drifted duplicate is worse than an honest gap**, because it emits a confidently
 * wrong note instead of no note. INV-29's canary is what makes that decision safe
 * rather than lazy: a new async warning site becomes a failing test.
 *
 * The text below is recorded **in full and verbatim** rather than hedged, because
 * hedged phrasing ("some warnings may bypass") is unactionable — a user who sees
 * an unexpected line outside the plugin's channel has to be able to *match* it.
 * Verified present at `@openzeppelin/upgrades-core@1.46.0` by reading
 * `dist/add-proxy-to-manifest.js:addProxyToManifest`.
 *
 * The fix a reader will reach for first — wrapping the async call in the window —
 * is not available: INV-27 refuses a thenable return outright, which makes the
 * wrong fix impossible rather than merely discouraged.
 */
export const uncapturedEngineWarnings: readonly UncapturedEngineWarning[] =
  Object.freeze([
    {
      engineExport: 'addProxyToManifest',
      text: 'A proxy admin was previously deployed on this network',
      detail: Object.freeze([
        "This is not natively used with the current kind of proxy ('<kind>').",
        'Changes to the admin will have no effect on this new proxy.',
      ]),
      trigger:
        "kind !== 'transparent' && await manifest.getAdmin() is truthy — on " +
        'the path of every non-transparent proxy deployment',
      owner: 'SF-5',
    },
  ]);

/** INV-27: an engine call returned a thenable, so the window was not synchronous. */
export class EngineCallNotSynchronousError extends Error {
  readonly code = 'ENGINE_CALL_NOT_SYNCHRONOUS' as const;
  readonly call: string;

  constructor(call: string) {
    super(
      `The engine call "${call}" returned a thenable inside the ` +
        'warning-capture window. The window is synchronous by construction: it ' +
        'swaps console.error for the duration of one call, so a promise ' +
        'escaping it would leave the swap capturing unrelated writes with no ' +
        'symptom. console.error has been restored and the call refused rather ' +
        'than awaited. Call a synchronous engine export inside the window; if ' +
        'this export is asynchronous, its warnings are not capturable — see ' +
        'uncapturedEngineWarnings for the enumerated bypass.',
    );
    this.name = 'EngineCallNotSynchronousError';
    this.call = call;
  }
}

/** INV-32: a capture window was already open. Refused rather than nested. */
export class EngineCaptureReentrantError extends Error {
  readonly code = 'ENGINE_CAPTURE_REENTRANT' as const;
  readonly call: string;
  readonly activeCall: string;

  constructor(call: string, activeCall: string) {
    super(
      `Refusing to open a warning-capture window for "${call}" while the ` +
        `window for "${activeCall}" is still open. Nesting would make the ` +
        "inner restore write back the outer stub, and the outer restore " +
        "write back the original, losing one window's captured writes.",
    );
    this.name = 'EngineCaptureReentrantError';
    this.call = call;
    this.activeCall = activeCall;
  }
}

/**
 * INV-45: the one permitted module-scope mutable binding outside
 * `output/silence.ts`, enumerated there rather than discovered here. Holds the
 * open window's call name so INV-32's refusal can name both calls.
 */
let activeCall: string | undefined;

const WARNING_PREFIX = 'Warning: ';
const NOTE_PREFIX = 'Note: ';

/**
 * Every CSI escape sequence, not only the SGR colours `chalk` happens to emit
 * today. Stripping is unconditional and idempotent (INV-33): `chalk@4.1.2`
 * auto-detects the terminal, so the same upstream code path emits codes or not
 * depending on the environment, and a recorded note whose text depended on
 * whether a TTY was attached would be untestable. TronBox's own `logger.log`
 * house style is uncoloured.
 */
const ANSI_ESCAPE = /\u001B\[[0-9;]*[A-Za-z]/g;

const WARNING_REMEDY =
  'The text above is the upgrade-safety engine\'s own, relayed unchanged. ' +
  'Address the construct it names, or opt out deliberately through ' +
  'unsafeAllow after confirming by hand that it is safe.';

const NOTE_REMEDY =
  'Informational: the engine states that it reduced what it validated. Read ' +
  'the text above and verify the construct it names by other means if you ' +
  'rely on it being checked.';

const BLANK_WRITE_SUMMARY =
  'The upgrade-safety engine wrote an empty line to console.error';

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

/**
 * Renders one captured `console.error` invocation.
 *
 * Upstream writes exactly **one** string argument —
 * `dist/utils/log.js:log` builds `parts.join('\n')` and passes it alone, verified
 * present at 1.46.0 — so a non-string argument is not upstream's format and is
 * rendered by type alone. INV-41: nothing here can serialize a host object, and
 * nothing here can throw. `String(value)` is deliberately avoided: it throws on a
 * symbol and invokes a caller-supplied `toString`, either of which would make the
 * relay itself fail inside the one code path that must not.
 */
function renderCapturedWrite(args: readonly unknown[]): string {
  return args
    .map(arg => (typeof arg === 'string' ? arg : `[${typeof arg}]`))
    .join(' ');
}

/**
 * INV-33: upstream's text and level, preserved.
 *
 * A `Warning` becomes `'engine-warning'` and a `Note` becomes `'engine-note'`;
 * both are recorded, because a note that a class of construct was **excluded from
 * validation** is a reduced-fidelity validation statement by SC-003's own
 * definition. An unrecognized prefix is recorded as `'engine-warning'` — the
 * stricter of the two — and never dropped: if upstream adds a third level or
 * changes its prefix, the plugin over-reports rather than under-reports.
 *
 * Total by construction: `summary` and `remedy` are always non-empty, so this can
 * never make `channel.degraded` throw, which matters because the relay runs in a
 * `finally` where a throw would mask the engine's own error.
 */
function engineNote(captured: string): DegradedNote {
  const stripped = stripAnsi(captured);

  let code: DegradedCode = 'engine-warning';
  let body = stripped;
  if (stripped.startsWith(NOTE_PREFIX)) {
    code = 'engine-note';
    body = stripped.slice(NOTE_PREFIX.length);
  } else if (stripped.startsWith(WARNING_PREFIX)) {
    body = stripped.slice(WARNING_PREFIX.length);
  }

  const lines = body.split('\n');
  const title = (lines[0] ?? '').trim();
  const detail = lines
    .slice(1)
    .map(line => line.replace(/^ {0,4}/, '').trimEnd())
    .filter(line => line !== '');

  return Object.freeze({
    code,
    summary: title === '' ? BLANK_WRITE_SUMMARY : title,
    detail: Object.freeze(detail),
    remedy: code === 'engine-note' ? NOTE_REMEDY : WARNING_REMEDY,
  });
}

function isThenable(value: unknown): boolean {
  if (
    (typeof value !== 'object' || value === null) &&
    typeof value !== 'function'
  ) {
    return false;
  }
  // INV-27: only a *callable* `then` counts. A plain `{ then: 1 }` is not a
  // promise and must not be refused.
  return typeof (value as { then?: unknown }).then === 'function';
}

type CaptureOutcome<T> =
  | { readonly synchronous: true; readonly value: T }
  | { readonly synchronous: false };

/**
 * The window itself, and the only site in the package that touches `console`
 * (INV-26).
 *
 * INV-32: the exact saved value is restored in a `finally`, on **every** exit
 * path — normal return, a thrown engine error, and a thrown `.then` access. An
 * engine call that throws is the common case, not the exception, since
 * `assertUpgradeSafe` and `assertStorageUpgradeSafe` exist to throw; leaving the
 * stub installed would swallow every later `console.error` in the migration,
 * including TronBox's own, into a dead buffer.
 *
 * `captured` is owned by the caller so the buffer survives a throw from `fn` —
 * upstream writes its warnings for *allowed* errors before throwing on a
 * disallowed one, so dropping the buffer on the throw path would discard real
 * warnings (INV-33).
 *
 * Extracted from {@link captureEngineWarnings} rather than inlined so that the
 * successful outcome carries `T` without a cast: a single function would need
 * `let value: T | undefined` plus an `as T` at the return, which is unsound for
 * any `T` that includes `undefined`.
 */
function runCaptureWindow<T>(
  call: string,
  captured: string[],
  fn: () => T,
): CaptureOutcome<T> {
  const saved = console.error;
  activeCall = call;
  try {
    console.error = (...args: unknown[]): void => {
      captured.push(renderCapturedWrite(args));
    };
    const value = fn();
    return isThenable(value)
      ? { synchronous: false }
      : { synchronous: true, value };
  } finally {
    console.error = saved;
    activeCall = undefined;
  }
}

/**
 * Relays the buffered writes onto the channel, after the swap is gone.
 *
 * Drains the buffer so a second call cannot replay it. `channel.degraded`
 * swallows its own write failure (INV-23) and {@link engineNote} is total, so
 * this cannot throw — which is required, because it runs in a `finally` where a
 * throw would replace the engine's own error with the relay's.
 */
function flush(channel: OutputChannel, captured: string[]): void {
  for (const write of captured.splice(0, captured.length)) {
    channel.degraded(engineNote(write));
  }
}

/**
 * Runs a **synchronous** `upgrades-core` call with its warning output captured and
 * re-emitted on this channel.
 *
 * @param channel the plugin's channel; captured writes are relayed onto it
 * @param call the engine export's name, for INV-27's and INV-32's messages. One
 *   of {@link capturableEngineExports}' names, or a short label naming the
 *   composite call. Required rather than derived from `fn.name`, which is `''` for
 *   the arrow functions every call site uses — a refusal that cannot name the call
 *   fails INV-10.
 * @param fn the engine call. Must not be `async` and must not `await` (INV-28).
 *
 * The safety argument is a **runtime refusal**, not a reading of the shipped
 * `.d.ts` (INV-27). If `fn` returns a thenable, `console.error` is restored and
 * the call is refused rather than awaited: an `await` inside the window would
 * yield to the event loop while `console.error` is swapped, so any concurrent
 * code's write would be captured and re-emitted as a plugin engine warning —
 * output theft in one direction and a fabricated degraded note in the other, with
 * no symptom. The refusal holds on a minor bump that a `.d.ts` claim would
 * silently lose to, and it holds for entry points nobody enumerated.
 *
 * INV-31: captured writes are **buffered** and flushed only after
 * `console.error` has been restored. This is structural rather than dependent on
 * which method the emitter's probe picked: on the un-quieted CLI path the injected
 * sink *is* `console`, so a relay running inside the window would feed its own
 * stub — a duplicated, mislabelled note in the mild case and an unbounded loop in
 * the worst.
 *
 * INV-24: silencing never reaches this function. The capture still runs and the
 * notes are still recorded; only the advisory write is suppressed, at the
 * emitter. A `silenceWarnings()` that short-circuited the capture would let
 * upstream's writes escape to `console.error` and bypass the host's quiet mode —
 * the plugin's own control creating the bypass it exists to prevent.
 */
export function captureEngineWarnings<T>(
  channel: OutputChannel,
  call: string,
  fn: () => T,
): T {
  if (activeCall !== undefined) {
    throw new EngineCaptureReentrantError(call, activeCall);
  }

  const captured: string[] = [];
  try {
    const outcome = runCaptureWindow(call, captured, fn);
    if (!outcome.synchronous) {
      throw new EngineCallNotSynchronousError(call);
    }
    return outcome.value;
  } finally {
    // INV-31: `runCaptureWindow`'s own `finally` has already restored
    // `console.error` by the time this runs, on every path — including the
    // refusal above and a throw from `fn`. Exactly one flush per call.
    flush(channel, captured);
  }
}
