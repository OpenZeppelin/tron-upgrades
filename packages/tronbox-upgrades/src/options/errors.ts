/**
 * The option-error hierarchy: one closed family, one class per distinguishable
 * cause.
 *
 * All four extend `UpgradesOptionError` and each carries a `readonly code`
 * narrowed to a string literal, so a caller branches on `code` and nothing
 * requires parsing a message. The hazard is concrete — a caller who writes `catch
 * (e) { if (/unsafeAllow/.test(e.message)) … }` makes the actionable-diagnosis
 * requirement's *"each distinct error path has a test asserting its message
 * content"* the **caller's** coupling rather than the plugin's contract.
 *
 * Every message names the failing option, the received value, and either
 * the accepted set or the correct alternative — and the same facts are present as
 * structured readonly fields, so nothing user-facing is available only by parsing
 * prose. Message form mirrors the one place in the upstream family that already
 * does this right, `core/src/cli/validate.ts:getUnsafeAllowKinds`.
 */

/**
 * The character budget for a rendered `received` value.
 *
 * The error path must be at least as robust as the happy path. A `constructorArgs`
 * element containing a cyclic reference is a legal JS object graph built from legal
 * Solidity input, and `JSON.stringify` of it throws `TypeError: Converting circular
 * structure to JSON` — replacing a precise diagnostic with a crash. A large value
 * floods the terminal so the actual diagnosis scrolls away.
 */
const RECEIVED_MAX_CHARS = 120;

function truncate(text: string): string {
  return text.length <= RECEIVED_MAX_CHARS
    ? text
    : `${text.slice(0, RECEIVED_MAX_CHARS)}… (${text.length} characters total)`;
}

/**
 * Renders a caller-supplied value for a message: a primitive verbatim and quoted,
 * a non-primitive as a bounded type-and-shape description.
 *
 * Never `JSON.stringify` of an arbitrary caller value, never a
 * deep walk, never more than the budget above. No host-supplied object can
 * be serialized here, because nothing beyond a type name and an array length is
 * ever read.
 *
 * `String(value)` is deliberately avoided for non-strings: it throws on a symbol
 * and invokes a caller-supplied `toString`, either of which would make the error
 * path itself fail.
 */
export function renderReceived(value: unknown): string {
  switch (typeof value) {
    case 'string':
      // `JSON.stringify` of a string cannot throw and gives the quoting the message format wants.
      return truncate(JSON.stringify(value));
    case 'number':
      if (Object.is(value, -0)) {
        return '-0';
      }
      return String(value);
    case 'bigint':
      return `${value.toString()}n`;
    case 'boolean':
      return String(value);
    case 'undefined':
      return 'undefined';
    case 'symbol':
      return 'a symbol';
    case 'function':
      return 'a function';
    default:
      break;
  }

  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    try {
      return `an array of ${String(value.length)} element(s)`;
    } catch {
      // Reading `length` is a [[Get]], so a Proxy whose trap throws reaches here.
      // Reported rather than swallowed: the message still says what the value was,
      // and the renderer itself must never throw.
      return 'an array (length unavailable)';
    }
  }
  return 'an object';
}

function formatAccepted(accepted: readonly string[] | string): string {
  return typeof accepted === 'string' ? accepted : accepted.join(', ');
}

/** The one base packaging re-exports as this family's root. */
export class UpgradesOptionError extends Error {}

/**
 * A value outside its accepted set. Never coerced.
 *
 * The concrete case this guards against:
 * `plugin-truffle/src/utils/deploy-impl.ts:deployImpl` tests only `=== 'always'`
 * and `=== 'never'`, so `'onChange'` silently behaves as `'onchange'` there — the
 * caller asked for one policy and got another with no diagnostic. Same class:
 * upstream's `processExceptions` iterates the *known* kinds asking
 * `unsafeAllow.includes(...)`, so `['delegate-call']` allows nothing and says
 * nothing.
 */
export class OptionValueError extends UpgradesOptionError {
  readonly code = 'OPTION_VALUE_INVALID' as const;
  readonly option: string;
  readonly received: unknown;
  readonly accepted: readonly string[] | string;
  /**
   * The operation whose per-operation narrowing rejected the value, or `null` when
   * the refusal is not operation-specific. Total rather than optional, so a caller
   * never has to interpret absence.
   */
  readonly operation: string | null;

  constructor(
    option: string,
    received: unknown,
    accepted: readonly string[] | string,
    operation: string | null = null,
  ) {
    super(
      `Invalid option: ${option}${
        operation === null ? '' : ` (for ${operation})`
      } was ${renderReceived(received)}. ` +
        `Accepted: ${formatAccepted(accepted)}. ` +
        'The value is refused rather than coerced, because a silently ' +
        'reinterpreted option is a safety change no output would surface.',
    );
    this.name = 'OptionValueError';
    this.option = option;
    this.received = received;
    this.accepted = accepted;
    this.operation = operation;
  }
}

/**
 * A key the operation does not accept.
 *
 * A recorded divergence from the parity target, and not an invention:
 * `core/src/cli/validate.ts:validateOptions` already rejects unknown keys with
 * `Invalid options: …` — the same package, at its
 * CLI entry point. This lifts that discipline onto the plugin API path, because a
 * silently ignored `unsafeAllowRename` typo is a safety flip that no amount of
 * output would have surfaced: the caller believes they enabled a rename allowance
 * and gets full strictness, or the reverse on the next refactor.
 */
export class UnknownOptionError extends UpgradesOptionError {
  readonly code = 'OPTION_UNKNOWN' as const;
  readonly unknownKeys: readonly string[];
  readonly accepted: readonly string[];

  constructor(unknownKeys: readonly string[], accepted: readonly string[]) {
    const frozenUnknown = Object.freeze([...unknownKeys]);
    const frozenAccepted = Object.freeze([...accepted]);
    super(
      `Invalid options: ${frozenUnknown.join(', ')}. ` +
        `This operation accepts: ${frozenAccepted.join(', ')}. ` +
        'Unknown keys are refused rather than ignored, because a mistyped ' +
        'option name is indistinguishable from an option that was never set.',
    );
    this.name = 'UnknownOptionError';
    this.unknownKeys = frozenUnknown;
    this.accepted = frozenAccepted;
  }
}

/**
 * Two options that express one allowance and disagree. Refused, not resolved.
 *
 * **Verified present at `@openzeppelin/upgrades-core@1.46.0`**, the upstream
 * asymmetry that makes this necessary: `dist/validate/overrides.js:withValidationDefaults`
 * computes `unsafeAllowLinkedLibraries = opts.unsafeAllowLinkedLibraries ??
 * unsafeAllow.includes('external-library-linking')` and then, if it is truthy,
 * `unsafeAllow.push('external-library-linking')`. So an explicit `false` yields
 * `unsafeAllowLinkedLibraries === false` **while the array still grants the
 * allowance** — the two channels disagree and the array wins in effect. A caller
 * who wrote `false` to *revoke* an inherited allowance gets it granted. Resolving
 * that silently is the never-coerce rule broken on a real upstream quirk.
 */
export class OptionConflictError extends UpgradesOptionError {
  readonly code = 'OPTION_CONFLICT' as const;
  readonly options: readonly string[];
  readonly because: string;
  readonly instead: string;

  constructor(options: readonly string[], because: string, instead: string) {
    const frozenOptions = Object.freeze([...options]);
    super(
      `Conflicting options: ${frozenOptions.join(' and ')}. ${because} ` +
        `${instead}`,
    );
    this.name = 'OptionConflictError';
    this.options = frozenOptions;
    this.because = because;
    this.instead = instead;
  }
}

/**
 * An option the parity target defines whose semantics TRON cannot honour, naming
 * the TRON-correct alternative — scenario 3's mechanism.
 *
 * See {@link optionsUnsupportedOnTron} for why it has no instance on this surface.
 */
export class OptionUnsupportedOnTronError extends UpgradesOptionError {
  readonly code = 'OPTION_UNSUPPORTED_ON_TRON' as const;
  readonly option: string;
  readonly because: string;
  readonly instead: string;

  constructor(option: string, because: string, instead: string) {
    super(
      `Option "${option}" is not supported on TRON. ${because} ${instead}`,
    );
    this.name = 'OptionUnsupportedOnTronError';
    this.option = option;
    this.because = because;
    this.instead = instead;
  }
}

/** One portable-surface option refused on TRON grounds. */
export interface TronOptionRefusal {
  readonly option: string;
  readonly because: string;
  readonly instead: string;
}

/**
 * The registry of portable-surface options refused on TRON grounds. **Empty in
 * v1, and the emptiness is a finding rather than a gap.**
 *
 * Everything on this surface is source-level validation policy or timing, all of
 * which TRON honours. The first real instance is `txOverrides`'s EVM-only fields,
 * which is the deploy seam's surface — the Hardhat sibling already rejects them in
 * `src/utils/options.ts:txOverridesOf`.
 *
 * `resolve.ts` walks this list on every resolution, so the mechanism is live
 * rather than decorative: adding the first instance is one entry here and needs no
 * change to the resolver. A test asserts the list is empty and names the reason,
 * so a later reader cannot take the absence for a missing deliverable and invent a
 * TRON refusal for an option TRON honours.
 */
export const optionsUnsupportedOnTron: readonly TronOptionRefusal[] =
  Object.freeze([]);
