import { describe, expect, it } from 'vitest';

import {
  OptionConflictError,
  OptionUnsupportedOnTronError,
  OptionValueError,
  UnknownOptionError,
  UpgradesOptionError,
  optionsUnsupportedOnTron,
  proxyKinds,
  redeployModes,
  renderReceived,
  requireProxyKind,
  resolveInitializer,
  unsafeAllowKinds,
} from '../src/options';
import {
  DegradedNoteInvalidError,
  EngineCallNotSynchronousError,
  EngineCaptureReentrantError,
} from '../src/output';
import {
  HostInstanceSharedError,
  ResultCapabilityUnavailableError,
  TransactionHashUnavailableError,
  UnavailableMemberAbsentError,
} from '../src/results';
import {
  UPGRADE_OPTION_KEYS,
  resolveAsJavaScriptCaller,
  sf10Sources,
  sourceNamed,
  throwSites,
} from './helpers/surface-fixtures';
import { valueIdentifierNames } from './helpers/source-scan';

/**
 * Error Semantics for the option/result surface — every typed error class and
 * the message contract each one honors.
 *
 * Technique: fault injection. Every guard on the resolution path gets an input
 * that drives it, and every assertion names the class rather than using a bare
 * `toThrow()` — a weak assertion here would let the wrong error through, which is
 * precisely the failure the fixed check order below exists to prevent (a typo
 * reported as a bad default).
 *
 * The eleven error classes below are the whole closed family. `code` is the
 * caller's branch, so the codes are asserted for uniqueness as a set rather than
 * one at a time: two classes sharing a code would make a caller's `switch`
 * silently wrong, and no per-class assertion would catch it.
 */

/**
 * Every error class the option/result surface declares, with the code it carries.
 *
 * Written out rather than derived from the modules, so adding a class without
 * adding a row here fails the completeness assertion below instead of being swept
 * along by a loop over whatever happens to be exported.
 */
const ERROR_FAMILY = [
  { name: 'OptionValueError', code: 'OPTION_VALUE_INVALID', optionFamily: true },
  { name: 'UnknownOptionError', code: 'OPTION_UNKNOWN', optionFamily: true },
  { name: 'OptionConflictError', code: 'OPTION_CONFLICT', optionFamily: true },
  {
    name: 'OptionUnsupportedOnTronError',
    code: 'OPTION_UNSUPPORTED_ON_TRON',
    optionFamily: true,
  },
  { name: 'DegradedNoteInvalidError', code: 'DEGRADED_NOTE_INVALID', optionFamily: false },
  {
    name: 'EngineCallNotSynchronousError',
    code: 'ENGINE_CALL_NOT_SYNCHRONOUS',
    optionFamily: false,
  },
  {
    name: 'EngineCaptureReentrantError',
    code: 'ENGINE_CAPTURE_REENTRANT',
    optionFamily: false,
  },
  {
    name: 'ResultCapabilityUnavailableError',
    code: 'RESULT_CAPABILITY_UNAVAILABLE',
    optionFamily: false,
  },
  {
    name: 'UnavailableMemberAbsentError',
    code: 'UNAVAILABLE_MEMBER_ABSENT',
    optionFamily: false,
  },
  {
    name: 'TransactionHashUnavailableError',
    code: 'TRANSACTION_HASH_UNAVAILABLE',
    optionFamily: false,
  },
  { name: 'HostInstanceSharedError', code: 'HOST_INSTANCE_SHARED', optionFamily: false },
] as const;

/** One constructed instance of each, so the assertions run against real objects. */
function everyError(): readonly { readonly name: string; readonly error: Error }[] {
  return [
    { name: 'OptionValueError', error: new OptionValueError('kind', 'Nope', ['uups']) },
    { name: 'UnknownOptionError', error: new UnknownOptionError(['typo'], ['kind']) },
    {
      name: 'OptionConflictError',
      error: new OptionConflictError(['a', 'b'], 'because.', 'instead.'),
    },
    {
      name: 'OptionUnsupportedOnTronError',
      error: new OptionUnsupportedOnTronError('txOverrides', 'because.', 'instead.'),
    },
    {
      name: 'DegradedNoteInvalidError',
      error: new DegradedNoteInvalidError('summary', 'a test channel'),
    },
    {
      name: 'EngineCallNotSynchronousError',
      error: new EngineCallNotSynchronousError('validateUpgradeSafety'),
    },
    {
      name: 'EngineCaptureReentrantError',
      error: new EngineCaptureReentrantError('getErrors', 'validate'),
    },
    {
      name: 'ResultCapabilityUnavailableError',
      error: new ResultCapabilityUnavailableError('events', {
        because: 'because.',
        instead: 'instead.',
      }),
    },
    {
      name: 'UnavailableMemberAbsentError',
      error: new UnavailableMemberAbsentError('logs'),
    },
    {
      name: 'TransactionHashUnavailableError',
      error: new TransactionHashUnavailableError('deployProxy'),
    },
    {
      name: 'HostInstanceSharedError',
      error: new HostInstanceSharedError('address', 'the migration owns every handle'),
    },
  ];
}

// ---------------------------------------------------------------------------
// every rejection is a typed error from one closed hierarchy with a stable code
// ---------------------------------------------------------------------------

describe('every rejection is a typed error from one closed hierarchy with a stable code', () => {
  it('gives every class a code, a name, and Error ancestry', () => {
    const instances = everyError();
    expect(instances).toHaveLength(ERROR_FAMILY.length);
    for (const { name, error } of instances) {
      const row = ERROR_FAMILY.find(entry => entry.name === name);
      expect(row, `${name} is not in ERROR_FAMILY`).toBeDefined();
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(name);
      expect(error.constructor.name).toBe(name);
      // `code` is not on `Error`, so it is read through the instance's own
      // property rather than through a widened type.
      expect(Object.getOwnPropertyDescriptor(error, 'code')?.value).toBe(row?.code);
      expect(error.message.length).toBeGreaterThan(0);
      // A stack is what makes the error attributable in a migration the user did
      // not write; `Error` gives it, and no class overrides it away.
      expect(typeof error.stack).toBe('string');
    }
  });

  it('keeps every code unique, so a caller branching on code cannot be silently wrong', () => {
    const codes = ERROR_FAMILY.map(entry => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('roots the four option errors in one base that packaging can re-export', () => {
    for (const { name, error } of everyError()) {
      const row = ERROR_FAMILY.find(entry => entry.name === name);
      expect(
        error instanceof UpgradesOptionError,
        `${name} ancestry must match its declared family`,
      ).toBe(row?.optionFamily);
    }
  });

  it('throws nothing but an enumerated class anywhere in the three directories', () => {
    /*
     * The mechanical half, and the reason it collects every `throw` rather than
     * grepping for `new Error`: `throw 'text'`, `throw error` and
     * `throw { code: … }` are all forbidden too, and a grep for one spelling
     * proves nothing about the others.
     */
    const permitted = new Set<string>(ERROR_FAMILY.map(entry => entry.name));
    const sites = sf10Sources().flatMap(source => throwSites(source));
    expect(sites.length).toBeGreaterThan(0);
    const offending = sites.filter(site => !permitted.has(site.thrown));
    expect(
      offending.map(site => `${site.relative}:${site.line} throws ${site.thrown}`),
    ).toEqual([]);
  });

  it('produces an enumerated class from every failure path a fixture can drive', () => {
    // The behavioural counterpart: the classes are not merely declared, each is
    // reachable from an input a caller can actually supply.
    const drives: readonly { readonly label: string; readonly run: () => unknown }[] = [
      {
        label: 'unknown key',
        run: () => resolveAsJavaScriptCaller({ typo: 1 }, UPGRADE_OPTION_KEYS),
      },
      {
        label: 'bad closed-set value',
        run: () => resolveAsJavaScriptCaller({ kind: 'Nope' }, UPGRADE_OPTION_KEYS),
      },
      {
        label: 'contradiction',
        run: () =>
          resolveAsJavaScriptCaller(
            {
              unsafeAllowLinkedLibraries: false,
              unsafeAllow: ['external-library-linking'],
            },
            UPGRADE_OPTION_KEYS,
          ),
      },
      {
        label: 'numeric bound',
        run: () => resolveAsJavaScriptCaller({ timeout: -1 }, UPGRADE_OPTION_KEYS),
      },
      {
        label: 'shape',
        run: () =>
          resolveAsJavaScriptCaller({ constructorArgs: 'nope' }, UPGRADE_OPTION_KEYS),
      },
      {
        label: 'per-operation narrowing',
        run: () => requireProxyKind('beacon', ['uups', 'transparent'], 'deployProxy'),
      },
      {
        label: 'initializer shape',
        run: () => resolveInitializer('', 1),
      },
    ];
    for (const { label, run } of drives) {
      let thrown: unknown;
      try {
        run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${label} must throw`).toBeInstanceOf(UpgradesOptionError);
      expect(thrown, `${label} must be an Error`).toBeInstanceOf(Error);
    }
  });
});

// ---------------------------------------------------------------------------
// never coerce — a value outside its accepted set is refused, not repaired
// ---------------------------------------------------------------------------

describe('never coerce — a value outside its accepted set is refused, not repaired', () => {
  /*
   * The enumerated adversarial set from the invariant, verbatim, plus the cases
   * the readers add. Every one is a value some caller has written: `'onChange'`
   * is the parity target's own live bug — `plugin-truffle/src/utils/deploy-impl.ts:deployImpl`
   * tests only `=== 'always'` and `=== 'never'`, so `'onChange'` silently behaves
   * as `'onchange'` there — and `['delegate-call']` is the hyphenation upstream's
   * `processExceptions` ignores without a word.
   */
  const refusals: readonly {
    readonly label: string;
    readonly supplied: object;
    readonly option: string;
  }[] = [
    { label: "'onChange' is not normalized", supplied: { redeployImplementation: 'onChange' }, option: 'redeployImplementation' },
    { label: "'Transparent' case is not folded", supplied: { kind: 'Transparent' }, option: 'kind' },
    { label: "' uups' is not trimmed", supplied: { kind: ' uups' }, option: 'kind' },
    { label: '-1 ms is not clamped to the bound', supplied: { timeout: -1 }, option: 'timeout' },
    { label: '1.5 ms is not rounded', supplied: { pollingInterval: 1.5 }, option: 'pollingInterval' },
    { label: 'NaN is not defaulted', supplied: { timeout: Number.NaN }, option: 'timeout' },
    { label: 'Infinity is not clamped', supplied: { timeout: Number.POSITIVE_INFINITY }, option: 'timeout' },
    { label: "['delegate-call'] loses no member silently", supplied: { unsafeAllow: ['delegate-call'] }, option: 'unsafeAllow' },
    { label: 'a numeric timeout string is not parsed', supplied: { timeout: '1000' }, option: 'timeout' },
    { label: 'a non-boolean flag is not coerced', supplied: { unsafeAllowRenames: 'yes' }, option: 'unsafeAllowRenames' },
    { label: 'a non-array unsafeAllow is not wrapped', supplied: { unsafeAllow: 'constructor' }, option: 'unsafeAllow' },
    { label: 'a non-array constructorArgs is not wrapped', supplied: { constructorArgs: 1 }, option: 'constructorArgs' },
    { label: 'an empty initializer name is not treated as false', supplied: { initializer: '' }, option: 'initializer' },
    { label: 'a whitespace initializer name is not trimmed to empty', supplied: { initializer: '   ' }, option: 'initializer' },
    { label: 'initializer: true is not read as the default name', supplied: { initializer: true }, option: 'initializer' },
  ];

  it.each(refusals)('refuses: $label', ({ supplied, option }) => {
    let thrown: unknown;
    try {
      resolveAsJavaScriptCaller(supplied, [...UPGRADE_OPTION_KEYS, 'initializer']);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OptionValueError);
    const error = thrown as OptionValueError;
    expect(error.option).toBe(option);
    // The message contract: the refusal names the accepted alternative, not
    // merely the failure.
    const accepted =
      typeof error.accepted === 'string' ? error.accepted : error.accepted.join(', ');
    expect(accepted.length).toBeGreaterThan(0);
  });

  it('accepts 0 milliseconds, because 0 means wait indefinitely rather than "unset"', () => {
    // The boundary in the other direction: the bound is inclusive on purpose, per
    // `dist/deployment.d.ts:DeployOpts`. A test that only drove -1 would pass
    // against an implementation that also refused 0.
    const resolved = resolveAsJavaScriptCaller(
      { timeout: 0, pollingInterval: 0 },
      UPGRADE_OPTION_KEYS,
    );
    expect(resolved.timeout).toBe(0);
    expect(resolved.pollingInterval).toBe(0);
  });

  it('produces no resolved value the caller did not pass', () => {
    /*
     * The other half of "never coerce", and the one an enumerated refusal list
     * cannot cover: for every accepted value, what comes back is what went in.
     * A single normalizing branch would pass every refusal test above and fail
     * here.
     */
    for (const kind of proxyKinds) {
      expect(
        resolveAsJavaScriptCaller({ kind }, UPGRADE_OPTION_KEYS).validation.kind,
      ).toBe(kind);
    }
    for (const mode of redeployModes) {
      expect(
        resolveAsJavaScriptCaller({ redeployImplementation: mode }, UPGRADE_OPTION_KEYS)
          .redeployImplementation,
      ).toBe(mode);
    }
    for (const timeout of [0, 1, 999, 60_000, 3_600_000]) {
      expect(
        resolveAsJavaScriptCaller({ timeout }, UPGRADE_OPTION_KEYS).timeout,
      ).toBe(timeout);
    }
    for (const kind of unsafeAllowKinds) {
      const resolved = resolveAsJavaScriptCaller(
        { unsafeAllow: [kind] },
        UPGRADE_OPTION_KEYS,
      );
      // Upstream may *add* derived members (that is the aliasing behavior
      // verified in the idempotency tests), but it must never drop the one the
      // caller wrote.
      expect(resolved.validation.unsafeAllow).toContain(kind);
    }
  });

  it('never falls back to a default on an invalid value', () => {
    // The specific shape of coercion this surface must never perform: a bad value
    // silently becoming the default is a safety change with no diagnostic.
    for (const supplied of [{ kind: 'Nope' }, { redeployImplementation: 'sometimes' }]) {
      expect(() =>
        resolveAsJavaScriptCaller(supplied, UPGRADE_OPTION_KEYS),
      ).toThrow(OptionValueError);
    }
  });

  it('narrows per operation without normalizing, naming the operation that refused', () => {
    expect(() => requireProxyKind('uups', ['uups', 'transparent'], 'deployProxy')).not.toThrow();
    let thrown: unknown;
    try {
      requireProxyKind('beacon', ['uups', 'transparent'], 'deployProxy');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OptionValueError);
    const error = thrown as OptionValueError;
    expect(error.operation).toBe('deployProxy');
    expect(error.message).toContain('deployProxy');
    expect(error.accepted).toEqual(['uups', 'transparent']);
  });
});

// ---------------------------------------------------------------------------
// every message names the failing input and the alternative, and the fields
// carry the same facts
// ---------------------------------------------------------------------------

describe('every message names the failing input and the alternative, and the fields carry the same facts', () => {
  it('names the option, the received value and the accepted set in one message', () => {
    const error = new OptionValueError('redeployImplementation', 'onChange', [
      'always',
      'never',
      'onchange',
    ]);
    expect(error.message).toContain('redeployImplementation');
    expect(error.message).toContain('"onChange"');
    expect(error.message).toContain('always, never, onchange');
  });

  it('reaches every fact in every message as a structured readonly field', () => {
    /*
     * The requirement made mechanical: for each class, the facts the message
     * states are also fields, so a programmatic caller never has to parse prose.
     * The check is that each field's rendered value actually appears in the
     * message — the direction that catches a message that stopped mentioning one.
     */
    const cases: readonly {
      readonly error: Error;
      readonly facts: readonly string[];
    }[] = [
      {
        error: new OptionValueError('kind', 'Nope', ['uups'], 'deployProxy'),
        facts: ['kind', 'Nope', 'uups', 'deployProxy'],
      },
      {
        error: new UnknownOptionError(['unsafeAllowRename'], ['unsafeAllowRenames']),
        facts: ['unsafeAllowRename', 'unsafeAllowRenames'],
      },
      {
        error: new OptionConflictError(
          ['unsafeAllowLinkedLibraries: false', "unsafeAllow: ['external-library-linking']"],
          'The explicit false revokes the allowance.',
          'Remove one of them.',
        ),
        facts: [
          'unsafeAllowLinkedLibraries: false',
          "unsafeAllow: ['external-library-linking']",
          'The explicit false revokes the allowance.',
          'Remove one of them.',
        ],
      },
      {
        error: new OptionUnsupportedOnTronError(
          'txOverrides',
          'TRON prices resources rather than gas.',
          'Use feeLimit instead.',
        ),
        facts: [
          'txOverrides',
          'TRON prices resources rather than gas.',
          'Use feeLimit instead.',
        ],
      },
      {
        error: new ResultCapabilityUnavailableError('events', {
          because: 'It decodes nothing.',
          instead: 'Read the receipt.',
        }),
        facts: ['events', 'It decodes nothing.', 'Read the receipt.'],
      },
      {
        error: new HostInstanceSharedError(
          'address',
          'the migration owns every handle it was passed',
        ),
        facts: ['address', 'the migration owns every handle it was passed'],
      },
      {
        error: new TransactionHashUnavailableError('forceImport'),
        facts: ['forceImport'],
      },
      {
        error: new EngineCallNotSynchronousError('validateUpgradeSafety'),
        facts: ['validateUpgradeSafety'],
      },
      {
        error: new EngineCaptureReentrantError('getErrors', 'validate'),
        facts: ['getErrors', 'validate'],
      },
      {
        error: new UnavailableMemberAbsentError('logs'),
        facts: ['logs'],
      },
      {
        error: new DegradedNoteInvalidError('remedy', 'the plugin output channel'),
        facts: ['remedy', 'the plugin output channel'],
      },
    ];
    // Every class in the family has a case, so a new class cannot skip this.
    expect(cases).toHaveLength(ERROR_FAMILY.length);
    for (const { error, facts } of cases) {
      for (const fact of facts) {
        expect(error.message, `${error.name} must name '${fact}'`).toContain(fact);
      }
    }
  });

  it('mirrors the one upstream message form that already does this right', () => {
    // `core/src/cli/validate.ts:getUnsafeAllowKinds` writes
    // `Invalid option: --unsafeAllow "…". Supported values … are: …`. The plugin's
    // form is the same three parts in the same order.
    const error = new OptionValueError('unsafeAllow', 'delegate-call', [
      ...unsafeAllowKinds,
    ]);
    expect(error.message.startsWith('Invalid option: unsafeAllow')).toBe(true);
    expect(error.message).toContain('Accepted:');
    expect(error.message).toContain('delegatecall');
  });

  it('freezes the array-valued fields, so a reader cannot edit the diagnosis', () => {
    const unknown = new UnknownOptionError(['a'], ['b']);
    expect(Object.isFrozen(unknown.unknownKeys)).toBe(true);
    expect(Object.isFrozen(unknown.accepted)).toBe(true);
    const conflict = new OptionConflictError(['a', 'b'], 'because.', 'instead.');
    expect(Object.isFrozen(conflict.options)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the check order is fixed and enumerated
// ---------------------------------------------------------------------------

describe('the check order is fixed and enumerated', () => {
  /*
   * Every assertion drives an input violating **two** adjacent steps and asserts
   * the *earlier* one. That is the only form that distinguishes a fixed order
   * from a control-flow accident: a single-violation input passes against any
   * order at all.
   *
   * The implemented order is five checks plus defaults — (1) unknown and
   * TRON-refused keys, (2) closed-set values, (3) contradictions, (4) numeric
   * bounds, (5) shapes, (6) defaults — which is this section's enumeration with
   * the TRON refusal folded into step 1, because whether a key is admissible at
   * all belongs before any value is examined.
   */
  it('reports the unknown key, not the out-of-range value (step 1 before step 2)', () => {
    let thrown: unknown;
    try {
      resolveAsJavaScriptCaller(
        { unsafeAllowRename: true, kind: 'Nope' },
        UPGRADE_OPTION_KEYS,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnknownOptionError);
    expect(thrown).not.toBeInstanceOf(OptionValueError);
  });

  it('reports the unknown key regardless of key insertion order', () => {
    // Insertion order is the only thing an object literal can vary, and a
    // resolver that walked keys instead of steps would be order-sensitive here.
    let thrown: unknown;
    try {
      resolveAsJavaScriptCaller(
        { kind: 'Nope', unsafeAllowRename: true },
        UPGRADE_OPTION_KEYS,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnknownOptionError);
  });

  it('reports the invalid value, not the contradiction (step 2 before step 3)', () => {
    let thrown: unknown;
    try {
      resolveAsJavaScriptCaller(
        {
          kind: 'Nope',
          unsafeAllowLinkedLibraries: false,
          unsafeAllow: ['external-library-linking'],
        },
        UPGRADE_OPTION_KEYS,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OptionValueError);
    expect((thrown as OptionValueError).option).toBe('kind');
    expect(thrown).not.toBeInstanceOf(OptionConflictError);
  });

  it('reports the contradiction, not the numeric bound (step 3 before step 4)', () => {
    let thrown: unknown;
    try {
      resolveAsJavaScriptCaller(
        {
          unsafeAllowLinkedLibraries: false,
          unsafeAllow: ['external-library-linking'],
          timeout: -1,
        },
        UPGRADE_OPTION_KEYS,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OptionConflictError);
  });

  it('reports the numeric bound, not the shape (step 4 before step 5)', () => {
    let thrown: unknown;
    try {
      resolveAsJavaScriptCaller(
        { timeout: -1, constructorArgs: 'not an array' },
        UPGRADE_OPTION_KEYS,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OptionValueError);
    expect((thrown as OptionValueError).option).toBe('timeout');
  });

  it('applies no default when an earlier step failed (step 5 before step 6)', () => {
    // The consequence of the ordering rather than the ordering itself: a failing
    // shape must not leave a half-resolved object anywhere, and the only
    // observable of that is that nothing is returned at all.
    let returned: unknown = 'sentinel';
    try {
      returned = resolveAsJavaScriptCaller(
        { constructorArgs: 'not an array' },
        UPGRADE_OPTION_KEYS,
      );
    } catch {
      // expected
    }
    expect(returned).toBe('sentinel');
  });

  it('keeps the order as data, so adding a check means adding a list entry', () => {
    // The structural half. `checkSteps` is module-private by design — it is not
    // part of the surface — so the assertion is that it exists as a frozen
    // top-level array literal whose entries are named, which is what makes the
    // order reviewable in one place.
    const resolve = sourceNamed('options/resolve.ts');
    const checkSteps = resolve.topLevelConsts.find(entry => entry.name === 'checkSteps');
    expect(checkSteps).toBeDefined();
    expect(checkSteps?.text).toContain('Object.freeze');
    for (const stepName of [
      'unknown-and-refused-keys',
      'closed-set-values',
      'cross-option-contradictions',
      'numeric-bounds',
      'shapes',
    ]) {
      expect(resolve.stringLiterals).toContain(stepName);
    }
  });
});

// ---------------------------------------------------------------------------
// a contradiction between two channels expressing one allowance is refused,
// not resolved
// ---------------------------------------------------------------------------

describe('a contradiction between two channels expressing one allowance is refused, not resolved', () => {
  /*
   * The upstream asymmetry that makes this necessary, verified at
   * `@openzeppelin/upgrades-core@1.46.0`:
   * `dist/validate/overrides.js:withValidationDefaults` computes
   * `unsafeAllowLinkedLibraries = opts.unsafeAllowLinkedLibraries ??
   * unsafeAllow.includes('external-library-linking')` and then pushes the member
   * back in when the derived flag is truthy. So an explicit `false` yields
   * `unsafeAllowLinkedLibraries === false` **while the array still grants the
   * allowance** — the two channels disagree and the array wins in effect.
   */
  const pairs: readonly {
    readonly label: string;
    readonly first: object;
    readonly second: object;
    readonly named: readonly string[];
  }[] = [
    {
      label: 'linked libraries',
      first: {
        unsafeAllowLinkedLibraries: false,
        unsafeAllow: ['external-library-linking'],
      },
      second: {
        unsafeAllow: ['external-library-linking'],
        unsafeAllowLinkedLibraries: false,
      },
      named: ['unsafeAllowLinkedLibraries', 'external-library-linking'],
    },
    {
      label: 'custom types',
      first: {
        unsafeAllowCustomTypes: false,
        unsafeAllow: ['struct-definition', 'enum-definition'],
      },
      second: {
        unsafeAllow: ['enum-definition', 'struct-definition'],
        unsafeAllowCustomTypes: false,
      },
      named: ['unsafeAllowCustomTypes', 'struct-definition', 'enum-definition'],
    },
    {
      label: 'two spellings of the redeploy policy',
      first: { useDeployedImplementation: true, redeployImplementation: 'never' },
      second: { redeployImplementation: 'never', useDeployedImplementation: true },
      named: ['useDeployedImplementation', 'redeployImplementation'],
    },
  ];

  it.each(pairs)('refuses $label in both orderings, naming both channels', ({
    first,
    second,
    named,
  }) => {
    for (const supplied of [first, second]) {
      let thrown: unknown;
      try {
        resolveAsJavaScriptCaller(supplied, UPGRADE_OPTION_KEYS);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(OptionConflictError);
      const error = thrown as OptionConflictError;
      for (const name of named) {
        expect(error.message).toContain(name);
      }
      // The message contract: which one to keep is on the error, not only in
      // the prose.
      expect(error.instead.length).toBeGreaterThan(0);
      expect(error.because.length).toBeGreaterThan(0);
    }
  });

  it('resolves the non-contradictory combinations, so the check is not over-broad', () => {
    /*
     * The three cases the invariant names: `true` + present, absent + present,
     * `false` + absent. Without these, a rule that refused *any* co-occurrence
     * would pass every assertion above while breaking every legitimate caller —
     * including the linked-library opt-out v1 ships.
     */
    const permitted: readonly object[] = [
      {
        unsafeAllowLinkedLibraries: true,
        unsafeAllow: ['external-library-linking'],
      },
      { unsafeAllow: ['external-library-linking'] },
      { unsafeAllowLinkedLibraries: false },
      { unsafeAllowCustomTypes: true, unsafeAllow: ['struct-definition', 'enum-definition'] },
      { unsafeAllow: ['struct-definition', 'enum-definition'] },
      { unsafeAllowCustomTypes: false },
      // Only *one* of the custom-type members present is not the contradiction:
      // upstream derives the flag from both, so one member does not grant it.
      { unsafeAllowCustomTypes: false, unsafeAllow: ['struct-definition'] },
      { useDeployedImplementation: true },
      { redeployImplementation: 'never' },
    ];
    for (const supplied of permitted) {
      expect(
        () => resolveAsJavaScriptCaller(supplied, UPGRADE_OPTION_KEYS),
        `${JSON.stringify(supplied)} must resolve`,
      ).not.toThrow();
    }
  });

  it('collapses the deprecated spelling into one field once it is the only one set', () => {
    // `useDeployedImplementation: true` is the parity target's own stated
    // equivalent of `redeployImplementation: 'never'`, so exactly one field
    // expresses the policy downstream.
    expect(
      resolveAsJavaScriptCaller({ useDeployedImplementation: true }, UPGRADE_OPTION_KEYS)
        .redeployImplementation,
    ).toBe('never');
    expect(
      resolveAsJavaScriptCaller({ useDeployedImplementation: false }, UPGRADE_OPTION_KEYS)
        .redeployImplementation,
    ).toBe('onchange');
    const resolved = resolveAsJavaScriptCaller(
      { useDeployedImplementation: true },
      UPGRADE_OPTION_KEYS,
    );
    expect(Object.hasOwn(resolved, 'useDeployedImplementation')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// received is rendered bounded and type-only for non-primitives
// ---------------------------------------------------------------------------

describe('received is rendered bounded and type-only for non-primitives', () => {
  /** The renderer's documented budget, plus the suffix it appends when it truncates. */
  const BUDGET = 120;

  it('renders each primitive verbatim, quoting strings', () => {
    expect(renderReceived('onChange')).toBe('"onChange"');
    expect(renderReceived(42)).toBe('42');
    expect(renderReceived(-0)).toBe('-0');
    expect(renderReceived(1.5)).toBe('1.5');
    expect(renderReceived(Number.NaN)).toBe('NaN');
    expect(renderReceived(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(renderReceived(10n)).toBe('10n');
    expect(renderReceived(true)).toBe('true');
    expect(renderReceived(undefined)).toBe('undefined');
    expect(renderReceived(null)).toBe('null');
  });

  it('renders a symbol and a function by type, never by calling into them', () => {
    // `String(symbol)` throws, and `String(value)` on an object invokes a
    // caller-supplied `toString` — either would make the error path itself fail.
    expect(renderReceived(Symbol('secret-ish'))).toBe('a symbol');
    expect(
      renderReceived(() => {
        throw new Error('toString must not be reached');
      }),
    ).toBe('a function');
    const hostile = {
      toString() {
        throw new Error('toString must not be reached');
      },
    };
    expect(renderReceived(hostile)).toBe('an object');
  });

  it('survives a cyclic object, a huge array and a throwing Proxy without throwing', () => {
    interface Cyclic {
      self?: Cyclic;
    }
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    expect(renderReceived(cyclic)).toBe('an object');

    const huge = new Array<number>(1_000_000).fill(7);
    const rendered = renderReceived(huge);
    expect(rendered).toBe('an array of 1000000 element(s)');
    expect(rendered.length).toBeLessThanOrEqual(BUDGET + 40);

    const throwingObject = new Proxy(
      {},
      {
        get() {
          throw new Error('get trap fired');
        },
      },
    );
    expect(renderReceived(throwingObject)).toBe('an object');

    // An array-backed Proxy *is* `Array.isArray`, so reading `length` reaches the
    // trap. The renderer reports that rather than swallowing it, and does not
    // throw — which is the property: the error path must be at least as robust as
    // the happy path.
    const throwingArray = new Proxy([1, 2, 3], {
      get(target, property) {
        if (property === 'length') {
          throw new Error('length trap fired');
        }
        return Reflect.get(target, property);
      },
    });
    expect(renderReceived(throwingArray)).toBe('an array (length unavailable)');
  });

  it('bounds a long string to the documented budget and says how long it was', () => {
    const long = 'x'.repeat(500);
    const rendered = renderReceived(long);
    expect(rendered.length).toBeLessThan(long.length);
    expect(rendered).toContain('… (502 characters total)');
  });

  it('keeps the whole error path bounded, end to end', () => {
    // The renderer is only interesting because a real refusal reaches it.
    interface Cyclic {
      self?: Cyclic;
    }
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    for (const value of [cyclic, new Array<number>(1_000_000).fill(1)]) {
      let thrown: unknown;
      try {
        resolveAsJavaScriptCaller({ kind: value }, UPGRADE_OPTION_KEYS);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(OptionValueError);
      const error = thrown as OptionValueError;
      expect(error.message.length).toBeLessThan(600);
      // The value itself is on the error for a programmatic caller; only the
      // *message* is bounded.
      expect(error.received).toBe(value);
    }
  });

  it('never serializes a caller value into the message', () => {
    // The mechanism, not the symptom: `JSON.stringify` appears in `errors.ts`
    // only for the string case, where it cannot throw and is the quoting the
    // message contract asks for. A deep walk anywhere would show up as a second
    // call site.
    const errors = sourceNamed('options/errors.ts');
    const stringifyCalls = errors.accessChains.filter(chain => chain === 'JSON.stringify');
    expect(stringifyCalls).toHaveLength(1);
    expect(valueIdentifierNames(errors)).not.toContain('structuredClone');
  });
});

// ---------------------------------------------------------------------------
// OptionUnsupportedOnTronError has zero instances, and the emptiness is
// asserted
// ---------------------------------------------------------------------------

describe('OptionUnsupportedOnTronError has zero instances, and the emptiness is asserted', () => {
  it('ships an empty, frozen refusal registry — a finding, not a gap', () => {
    /*
     * The reason the list is empty, recorded here so a later reader cannot take
     * the absence for a missing deliverable and invent a TRON refusal for an
     * option TRON honours: everything on this surface is source-level validation
     * policy or timing, all of which TRON honours. The first real instance is
     * `txOverrides`'s EVM-only fields, which is the deploy seam's surface.
     */
    expect(optionsUnsupportedOnTron).toEqual([]);
    expect(Object.isFrozen(optionsUnsupportedOnTron)).toBe(true);
  });

  it('exports a constructible error carrying option, because and instead', () => {
    const error = new OptionUnsupportedOnTronError(
      'txOverrides.maxFeePerGas',
      'TRON prices bandwidth and energy rather than gas.',
      'Use feeLimit and the TRON resource options instead.',
    );
    expect(error.option).toBe('txOverrides.maxFeePerGas');
    expect(error.because).toContain('TRON prices');
    expect(error.instead).toContain('feeLimit');
    expect(error.code).toBe('OPTION_UNSUPPORTED_ON_TRON');
    expect(error).toBeInstanceOf(UpgradesOptionError);
  });

  it('walks the registry on every resolution, so the mechanism is live rather than decorative', () => {
    /*
     * With an empty registry there is no behavioural observable, which is exactly
     * why this is asserted structurally: the resolver references the registry and
     * constructs the error, so adding the first instance is one entry in
     * `errors.ts` and needs no change to `resolve.ts`. Without this assertion the
     * emptiness test above would still pass against a resolver that had dropped
     * the walk entirely.
     */
    const resolve = sourceNamed('options/resolve.ts');
    expect(valueIdentifierNames(resolve)).toContain('optionsUnsupportedOnTron');
    expect(
      throwSites(resolve).map(site => site.thrown),
    ).toContain('OptionUnsupportedOnTronError');
  });
});
