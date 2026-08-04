import {
  withValidationDefaults,
  type ValidationOptions,
} from '@openzeppelin/upgrades-core';

import {
  DEFAULT_INITIALIZER,
  MILLISECOND_OPTION_MINIMUM,
  defaultConstructorArgs,
  pluginOptionDefaults,
} from './defaults';
import {
  OptionConflictError,
  OptionUnsupportedOnTronError,
  OptionValueError,
  UnknownOptionError,
  optionsUnsupportedOnTron,
} from './errors';
import {
  proxyKinds,
  redeployModes,
  unsafeAllowKinds,
  type InitializerResolution,
  type ProxyKind,
  type RedeployMode,
  type ResolvedUpgradeOptions,
  type UnsafeAllowKind,
  type UpgradeOptions,
} from './types';

/**
 * Option resolution: validate every supplied value against its accepted set, then
 * apply defaults. Pure, synchronous, and total (INV-15, INV-40).
 *
 * INV-18 / INV-44: reads no ambient state — no `process.env`, no clock, no config
 * file, no filesystem, no network — so a replayed operation resolves to the same
 * value by construction. That is why SF-10 declares no replay disposition: it
 * changes no state, and SC-007 stays each operation's obligation.
 */

/**
 * A caller's option object seen as data. Deliberately `object` rather than
 * `Record<string, unknown>`: the declared option interfaces have no index
 * signature, so widening them at the entry point would mean asserting a shape
 * claim about the caller's value. The only thing that actually needs the index view
 * is the single read in {@link read}, which is where it is confined.
 *
 * A JavaScript migration can pass any key with any value, which is why every check
 * below is a runtime one.
 */
type SuppliedOptions = object;

function own(supplied: SuppliedOptions, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(supplied, key);
}

/**
 * INV-4: `undefined` means absent — **but only for a key the operation accepts.**
 *
 * The unknown-key check below operates on own keys regardless of value, and only
 * after a key is known to be accepted does `undefined` read as absent. Getting the
 * order wrong is a one-line mistake that defeats D-2 entirely and produces no
 * output: `Object.keys({ unsafeAllowRename: undefined })` is
 * `['unsafeAllowRename']`, so a rule that filtered undefined-valued keys first
 * would let the plural/singular typo through silently — and `unsafeAllowRenames`
 * is a storage-check opt-out.
 */
function read(supplied: SuppliedOptions, key: string): unknown {
  // Indexing an arbitrary object with a string key always yields `unknown`; the
  // view is what needs stating, not the value's type. Every caller of this
  // function narrows what comes back before using it.
  return own(supplied, key)
    ? (supplied as Record<string, unknown>)[key]
    : undefined;
}

function isProxyKind(value: unknown): value is ProxyKind {
  return (proxyKinds as readonly unknown[]).includes(value);
}

function isRedeployMode(value: unknown): value is RedeployMode {
  return (redeployModes as readonly unknown[]).includes(value);
}

function isUnsafeAllowKind(value: unknown): value is UnsafeAllowKind {
  return (unsafeAllowKinds as readonly unknown[]).includes(value);
}

/*
 * The readers below each validate one option and return its narrowed value, or
 * `undefined` when the option is absent. They are pure, so a check step and the
 * build phase call the same function — the check step discards the value, the build
 * phase uses it. That is what keeps the two phases from disagreeing about what
 * counts as valid, and it is why no `as` cast appears anywhere in this module.
 */

function readProxyKind(supplied: SuppliedOptions): ProxyKind | undefined {
  const value = read(supplied, 'kind');
  if (value === undefined) {
    return undefined;
  }
  if (!isProxyKind(value)) {
    throw new OptionValueError('kind', value, [...proxyKinds]);
  }
  return value;
}

/**
 * Returns a **fresh** array (INV-16). Upstream's `withValidationDefaults` aliases
 * whatever array it is handed and pushes into it, so every array crossing into
 * upstream must be one the plugin owns.
 */
function readUnsafeAllow(
  supplied: SuppliedOptions,
): UnsafeAllowKind[] | undefined {
  const value = read(supplied, 'unsafeAllow');
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new OptionValueError(
      'unsafeAllow',
      value,
      'an array of validation-error kinds',
    );
  }
  const unrecognized = value.filter(member => !isUnsafeAllowKind(member));
  if (unrecognized.length > 0) {
    // Named individually rather than as "the array is invalid": upstream's plugin
    // path silently ignores an unrecognized member, so the caller's belief that
    // they granted an allowance is exactly what has to be corrected.
    throw new OptionValueError('unsafeAllow', unrecognized[0], [
      ...unsafeAllowKinds,
    ]);
  }
  return value.filter(isUnsafeAllowKind);
}

function readBooleanOption(
  supplied: SuppliedOptions,
  key: string,
): boolean | undefined {
  const value = read(supplied, key);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new OptionValueError(key, value, ['true', 'false']);
  }
  return value;
}

function readRedeployMode(
  supplied: SuppliedOptions,
): RedeployMode | undefined {
  const value = read(supplied, 'redeployImplementation');
  if (value === undefined) {
    return undefined;
  }
  if (!isRedeployMode(value)) {
    throw new OptionValueError('redeployImplementation', value, [
      ...redeployModes,
    ]);
  }
  return value;
}

/**
 * INV-9 step 4: finite, integer, at or above the bound. `NaN`, `Infinity`,
 * negative and fractional values are all refused naming the bound. Upstream
 * validates none of this, in either plugin.
 */
function readMilliseconds(
  supplied: SuppliedOptions,
  key: string,
): number | undefined {
  const value = read(supplied, key);
  if (value === undefined) {
    return undefined;
  }
  const accepted =
    `a non-negative integer number of milliseconds ` +
    `(>= ${String(MILLISECOND_OPTION_MINIMUM)}; 0 waits indefinitely)`;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MILLISECOND_OPTION_MINIMUM
  ) {
    throw new OptionValueError(key, value, accepted);
  }
  return value;
}

/**
 * INV-39: checked as an array and **never** deep-walked, deep-cloned, deep-frozen
 * or serialized. Constructor arguments are arbitrary caller data — a struct with a
 * self-reference is legal Solidity input built from a legal JS object graph — so a
 * deep clone or a validating `JSON.stringify` would hang or throw on it, and the
 * failure would surface as an options error on a perfectly valid deployment. The
 * copy is one level.
 */
function readConstructorArgs(
  supplied: SuppliedOptions,
): unknown[] | undefined {
  const value = read(supplied, 'constructorArgs');
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new OptionValueError(
      'constructorArgs',
      value,
      'an array of constructor arguments',
    );
  }
  return [...value];
}

function readInitializerOption(
  supplied: SuppliedOptions,
): string | false | undefined {
  const value = read(supplied, 'initializer');
  if (value === undefined) {
    return undefined;
  }
  return validateInitializer(value);
}

function validateInitializer(value: unknown): string | false {
  const accepted = 'a non-empty function name, or false for no initialization';
  if (value === false) {
    return false;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OptionValueError('initializer', value, accepted);
  }
  return value;
}

/** One pair of options that express a single allowance and can disagree. */
interface Contradiction {
  readonly options: readonly string[];
  readonly holds: (supplied: SuppliedOptions) => boolean;
  readonly because: string;
  readonly instead: string;
}

/**
 * INV-12: the three enumerated contradiction pairs, as data, checked before
 * defaults. Each is a case where two channels express one allowance and upstream
 * resolves the disagreement silently in favour of one of them.
 */
const contradictions: readonly Contradiction[] = Object.freeze([
  {
    options: ['unsafeAllowLinkedLibraries: false', "unsafeAllow: ['external-library-linking']"],
    holds: supplied =>
      readBooleanOption(supplied, 'unsafeAllowLinkedLibraries') === false &&
      (readUnsafeAllow(supplied) ?? []).includes('external-library-linking'),
    because:
      'The explicit false revokes the allowance while the array still grants ' +
      'it, and upstream resolves that in favour of the array — so the ' +
      'allowance would be granted to a caller who asked to revoke it.',
    instead:
      "Remove 'external-library-linking' from unsafeAllow to revoke it, or " +
      'drop unsafeAllowLinkedLibraries to keep it.',
  },
  {
    options: [
      'unsafeAllowCustomTypes: false',
      "unsafeAllow: ['struct-definition', 'enum-definition']",
    ],
    holds: supplied => {
      const unsafeAllow = readUnsafeAllow(supplied) ?? [];
      return (
        readBooleanOption(supplied, 'unsafeAllowCustomTypes') === false &&
        unsafeAllow.includes('struct-definition') &&
        unsafeAllow.includes('enum-definition')
      );
    },
    because:
      'The explicit false revokes the allowance while the array still grants ' +
      'it, and upstream resolves that in favour of the array.',
    instead:
      "Remove 'struct-definition' and 'enum-definition' from unsafeAllow to " +
      'revoke it, or drop unsafeAllowCustomTypes to keep it.',
  },
  {
    options: ['useDeployedImplementation', 'redeployImplementation'],
    holds: supplied =>
      read(supplied, 'useDeployedImplementation') !== undefined &&
      read(supplied, 'redeployImplementation') !== undefined,
    because:
      'They are two spellings of one policy, and useDeployedImplementation is ' +
      'deprecated.',
    instead:
      "Keep redeployImplementation only — useDeployedImplementation: true is " +
      "redeployImplementation: 'never'.",
  },
]);

/** One ordered validation step. INV-11: the order is data, not control flow. */
interface CheckStep {
  readonly name: string;
  readonly check: (
    supplied: SuppliedOptions,
    accepted: readonly string[],
  ) => void;
}

/**
 * INV-11: the fixed, enumerated check order. The first failing step throws, and no
 * step is skipped because an earlier one passed. Adding a check means adding a list
 * entry, which is what keeps the order a decision rather than a control-flow
 * accident.
 *
 * Why the order is this order: a typo'd key reported as a bad default points the
 * user at the wrong line, and a contradiction reported between an invalid value and
 * a valid one names a conflict that does not exist.
 *
 * Step 6 — apply defaults — is {@link buildResolved}, which runs after every step
 * here has passed. `withValidationDefaults` is called last, on a fresh copy.
 */
const checkSteps: readonly CheckStep[] = Object.freeze([
  {
    // Both key-level refusals live here, because both are questions about whether
    // a key is admissible at all, and both must be answered before any value is
    // examined. INV-14's TRON registry is empty in v1; walking it anyway is what
    // makes adding the first instance a one-line edit to a named list.
    name: 'unknown-and-refused-keys',
    check: (supplied, accepted) => {
      const unknown = Object.keys(supplied).filter(
        key => !accepted.includes(key),
      );
      if (unknown.length > 0) {
        throw new UnknownOptionError(unknown, accepted);
      }
      for (const refusal of optionsUnsupportedOnTron) {
        if (own(supplied, refusal.option)) {
          throw new OptionUnsupportedOnTronError(
            refusal.option,
            refusal.because,
            refusal.instead,
          );
        }
      }
    },
  },
  {
    name: 'closed-set-values',
    check: supplied => {
      readProxyKind(supplied);
      readUnsafeAllow(supplied);
      readRedeployMode(supplied);
      readBooleanOption(supplied, 'unsafeAllowCustomTypes');
      readBooleanOption(supplied, 'unsafeAllowLinkedLibraries');
      readBooleanOption(supplied, 'unsafeAllowRenames');
      readBooleanOption(supplied, 'unsafeSkipStorageCheck');
      readBooleanOption(supplied, 'useDeployedImplementation');
    },
  },
  {
    name: 'cross-option-contradictions',
    check: supplied => {
      for (const contradiction of contradictions) {
        if (contradiction.holds(supplied)) {
          throw new OptionConflictError(
            contradiction.options,
            contradiction.because,
            contradiction.instead,
          );
        }
      }
    },
  },
  {
    name: 'numeric-bounds',
    check: supplied => {
      readMilliseconds(supplied, 'timeout');
      readMilliseconds(supplied, 'pollingInterval');
    },
  },
  {
    name: 'shapes',
    check: supplied => {
      readConstructorArgs(supplied);
      readInitializerOption(supplied);
    },
  },
]);

/** INV-11 step 6: defaults, with `withValidationDefaults` last on a fresh copy. */
function buildResolved(supplied: SuppliedOptions): ResolvedUpgradeOptions {
  /*
   * Built by conditional key insertion, never by spreading a partially-undefined
   * source (INV-3). Under `exactOptionalPropertyTypes: true` an explicit
   * `undefined` assignment would not even compile, but the runtime shape matters
   * independently: upstream reads `opts.kind ?? 'transparent'`, so an own key
   * carrying `undefined` would quietly substitute the default for a caller who
   * thought they had set something.
   */
  const validationInput: ValidationOptions = {};

  const kind = readProxyKind(supplied);
  if (kind !== undefined) {
    validationInput.kind = kind;
  }
  const unsafeAllow = readUnsafeAllow(supplied);
  if (unsafeAllow !== undefined) {
    validationInput.unsafeAllow = unsafeAllow;
  }
  const unsafeAllowCustomTypes = readBooleanOption(
    supplied,
    'unsafeAllowCustomTypes',
  );
  if (unsafeAllowCustomTypes !== undefined) {
    validationInput.unsafeAllowCustomTypes = unsafeAllowCustomTypes;
  }
  const unsafeAllowLinkedLibraries = readBooleanOption(
    supplied,
    'unsafeAllowLinkedLibraries',
  );
  if (unsafeAllowLinkedLibraries !== undefined) {
    validationInput.unsafeAllowLinkedLibraries = unsafeAllowLinkedLibraries;
  }
  const unsafeAllowRenames = readBooleanOption(supplied, 'unsafeAllowRenames');
  if (unsafeAllowRenames !== undefined) {
    validationInput.unsafeAllowRenames = unsafeAllowRenames;
  }
  const unsafeSkipStorageCheck = readBooleanOption(
    supplied,
    'unsafeSkipStorageCheck',
  );
  if (unsafeSkipStorageCheck !== undefined) {
    validationInput.unsafeSkipStorageCheck = unsafeSkipStorageCheck;
  }

  // INV-46: upstream owns these six defaults, so they cannot drift by construction.
  const validation = withValidationDefaults(validationInput);
  Object.freeze(validation.unsafeAllow);
  Object.freeze(validation);

  const constructorArgs = readConstructorArgs(supplied);
  const timeout = readMilliseconds(supplied, 'timeout');
  const pollingInterval = readMilliseconds(supplied, 'pollingInterval');

  return Object.freeze({
    validation,
    constructorArgs:
      constructorArgs === undefined
        ? defaultConstructorArgs
        : Object.freeze(constructorArgs),
    redeployImplementation: resolveRedeployMode(supplied),
    timeout: timeout ?? pluginOptionDefaults.timeout,
    pollingInterval: pollingInterval ?? pluginOptionDefaults.pollingInterval,
  });
}

/**
 * `useDeployedImplementation` does not survive resolution: it collapses into
 * `redeployImplementation` per the parity target's own stated equivalence
 * (*"@deprecated Use redeployImplementation = 'never' instead"*), so exactly one
 * field expresses the policy downstream. The two cannot both be set — that is
 * INV-12's third contradiction, already refused by check step 3.
 */
function resolveRedeployMode(supplied: SuppliedOptions): RedeployMode {
  const explicit = readRedeployMode(supplied);
  if (explicit !== undefined) {
    return explicit;
  }
  const deprecated = readBooleanOption(supplied, 'useDeployedImplementation');
  if (deprecated === true) {
    return 'never';
  }
  return pluginOptionDefaults.redeployImplementation;
}

/**
 * Resolves the portable option surface.
 *
 * @param options the caller's object, or `undefined` for none. Never mutated —
 *   including every array it owns (INV-15).
 * @param accepted the operation's own key list. This is how unknown-key rejection
 *   stays per-operation without SF-10 knowing the operation set: `upgradeProxy`
 *   accepts `call`, `deployProxy` does not, and each passes its own list, which
 *   lives next to the operation that owns it.
 *
 * @throws {UnknownOptionError} a key the operation does not accept
 * @throws {OptionUnsupportedOnTronError} a key TRON cannot honour (no v1 instance)
 * @throws {OptionValueError} a value outside its accepted set — never coerced
 * @throws {OptionConflictError} two options expressing one allowance, disagreeing
 */
export function resolveUpgradeOptions(
  options: UpgradeOptions | undefined,
  accepted: readonly string[],
): ResolvedUpgradeOptions {
  const supplied: SuppliedOptions = options ?? {};
  for (const step of checkSteps) {
    step.check(supplied, accepted);
  }
  return buildResolved(supplied);
}

/**
 * The **only** sanctioned way to hand resolved options to an `upgrades-core` entry
 * point. Returns a fresh object with a fresh `unsafeAllow`, both owned by the
 * plugin (INV-16).
 *
 * **Why this exists, established by execution against
 * `@openzeppelin/upgrades-core@1.46.0`:** upstream re-applies its own defaults to
 * whatever it is given. `dist/validate/overrides.js:processExceptions` — reached
 * from `getErrors` and therefore from `assertUpgradeSafe` — opens with
 * `withValidationDefaults(opts)`, which aliases `opts.unsafeAllow` and then
 * `push`es into it when either derived flag is truthy. Passing
 * `resolved.validation` directly therefore throws **`TypeError: Cannot add
 * property 2, object is not extensible`** on a frozen array, and it throws for
 * exactly the callers who set an expert opt-out — the linked-library opt-out v1
 * ships, or `unsafeAllowCustomTypes`. Verified: `processExceptions` on a resolved
 * object with `unsafeAllowCustomTypes: true` throws; the same call on this
 * function's output succeeds and leaves the caller's array untouched.
 *
 * Neither INV-3's freeze nor INV-16's fresh-copy rule is negotiable, and the two
 * are only compatible if the copy has a single home. The freeze is what makes a
 * call site that forgets fail **loudly** at the boundary instead of silently
 * accumulating allowances the author never wrote — which is the same failure
 * INV-15 records in the other direction: two `withValidationDefaults` calls on one
 * caller-owned array leave `['external-library-linking']` as three copies of
 * itself, re-verified at 1.46.0.
 */
export function engineValidationOptions(
  resolved: ResolvedUpgradeOptions,
): Required<ValidationOptions> {
  return {
    ...resolved.validation,
    unsafeAllow: [...resolved.validation.unsafeAllow],
  };
}

/**
 * The `initializer` rule, mirroring
 * `plugin-truffle/src/utils/initializer-data.ts:getInitializerData`.
 *
 * `false` means no initialization; a name means call it; omitted means call
 * `'initialize'` unless there are no arguments, in which case there is nothing to
 * initialize with. The result is a discriminated union rather than a nullable
 * string, so a caller cannot read "no initialization" as "call `undefined`".
 */
export function resolveInitializer(
  initializer: string | false | undefined,
  argCount: number,
): InitializerResolution {
  if (initializer === undefined) {
    return argCount === 0
      ? { kind: 'none' }
      : { kind: 'call', fn: DEFAULT_INITIALIZER };
  }
  const validated = validateInitializer(initializer);
  return validated === false
    ? { kind: 'none' }
    : { kind: 'call', fn: validated };
}

/**
 * Per-operation `kind` narrowing, mirroring the parity target's runtime refusals —
 * `deployProxy` refuses `'beacon'` (upstream's own `BeaconProxyUnsupportedError`),
 * `deployBeaconProxy` accepts only `'beacon'`.
 *
 * Separate from {@link resolveUpgradeOptions} because the closed-set check is
 * universal and the narrowing is not: which kinds an operation supports is the
 * operation's knowledge, so it passes its own list rather than SF-10 enumerating
 * the operation set.
 */
export function requireProxyKind(
  kind: ProxyKind,
  allowed: readonly ProxyKind[],
  operation: string,
): void {
  if (!allowed.includes(kind)) {
    throw new OptionValueError('kind', kind, [...allowed], operation);
  }
}
