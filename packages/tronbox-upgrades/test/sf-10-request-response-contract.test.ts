import { describe, expect, it } from 'vitest';

import type {
  DeployOpts,
  ProxyKindOption,
  StandaloneValidationOptions,
  ValidationOptions,
} from '@openzeppelin/upgrades-core';

import type {
  ContractAbstraction,
  OutputChannelSlot,
} from '../src/environment/types';
import {
  UnknownOptionError,
  proxyKinds,
  redeployModes,
  resolveUpgradeOptions,
  unsafeAllowKinds,
  type DeployBeaconOptions,
  type DeployBeaconProxyOptions,
  type DeployImplementationOptions,
  type DeployProxyOptions,
  type ForceImportOptions,
  type PrepareUpgradeOptions,
  type ProxyKind,
  type RedeployMode,
  type ResolvedUpgradeOptions,
  type UnsafeAllowKind,
  type UpgradeBeaconOptions,
  type UpgradeProxyOptions,
  type ValidateImplementationOptions,
  type ValidateUpgradeOptions,
} from '../src/options';
import type { HostChannelFacts } from '../src/output';
import {
  TransactionHashUnavailableError,
  operationNotes,
  transactionIdentity,
  type AdoptionOutcome,
  type AuthorityTransfer,
  type ContractHandle,
  type DeployedBeacon,
  type DeployedProxy,
  type ImplementationDeployment,
  type OperationResult,
  type UpgradedProxy,
  type ValidationOutcome,
} from '../src/results';
import { tronBoxIsInstalled, tronBoxVersionsUnderTest } from './helpers/locate';
import {
  DEPLOY_PROXY_OPTION_KEYS,
  UPGRADE_OPTION_KEYS,
  declaredMembers,
  resolveAsJavaScriptCaller,
  sf10Sources,
  sourceNamed,
  tronBoxAbstractionWithNetwork,
} from './helpers/sf-10-fixtures';
import { valueIdentifierNames } from './helpers/source-scan';

/**
 * SF-10 Request/Response Contract — SF-10 INV-1 … INV-7.
 *
 * Technique: entry-point integration plus type-level pins. For a library the
 * "request" is the caller's option object and the "response" is the resolved
 * options plus the operation result, so half of this category is checked by the
 * compiler under `tsc -p tsconfig.test.json` and half by driving
 * `resolveUpgradeOptions` and the result constructors.
 *
 * Every `describe` is prefixed `SF-10` because SF-0's suite numbers its own 49
 * invariants in the same range — a bare `INV-43` would sit in the same vitest
 * report next to a completely different property. Cross-references to SF-0's
 * numbering are written `SF-0 INV-n`, so an unprefixed number always belongs to the
 * suite it appears in and a prefixed one never does.
 *
 * Every `@ts-expect-error` in this file is load-bearing twice over: `npm test`
 * runs `tsc -p tsconfig.test.json` first, and an **unused** directive is a hard
 * compile failure. So a directive that stops being needed — because the type it
 * refuses was widened — fails the build rather than passing silently.
 */

// ---------------------------------------------------------------------------
// SF-10 INV-1
// ---------------------------------------------------------------------------

describe('SF-10 INV-1: the option surface composes upstream types and never re-declares a member narrower', () => {
  it('reaches every upstream member by extension, so each alias is assignable to what it composes', () => {
    /*
     * The pins are annotated `const` declarations rather than a generic
     * `Assignable<A, B>` helper, matching the shape SF-0's suite already uses.
     * A failure here is a compile error naming the member that diverged, which is
     * strictly more useful than a boolean.
     */
    const standaloneShaped: DeployImplementationOptions = {
      kind: 'uups',
      unsafeAllow: ['constructor'],
      constructorArgs: [1, 'two'],
      redeployImplementation: 'never',
      timeout: 1000,
      pollingInterval: 100,
    };
    const asUpstreamStandalone: StandaloneValidationOptions = standaloneShaped;
    const asUpstreamDeployOpts: DeployOpts = standaloneShaped;

    const upgradeShaped: PrepareUpgradeOptions = {
      kind: 'transparent',
      unsafeAllowRenames: true,
      unsafeSkipStorageCheck: false,
    };
    const asUpstreamValidation: ValidationOptions = upgradeShaped;

    const beaconProxyShaped: DeployBeaconProxyOptions = {
      kind: 'beacon',
      initializer: 'initialize',
      timeout: 0,
    };
    const asUpstreamKind: ProxyKindOption = beaconProxyShaped;
    // Divergence D-4: `DeployOpts` is composed in where the parity target omits
    // it, because on TRON confirmation is real (divergence D-1) and the omission
    // would leave one operation with no confirmation control.
    const beaconProxyDeployOpts: DeployOpts = beaconProxyShaped;

    const forceImportShaped: ForceImportOptions = { kind: 'uups' };
    const asUpstreamKindAgain: ProxyKindOption = forceImportShaped;

    const validateImplementationShaped: ValidateImplementationOptions = {
      unsafeAllow: ['delegatecall'],
    };
    const asUpstreamStandaloneAgain: StandaloneValidationOptions =
      validateImplementationShaped;

    const validateUpgradeShaped: ValidateUpgradeOptions = {
      unsafeAllowRenames: false,
    };
    const asUpstreamValidationAgain: ValidationOptions = validateUpgradeShaped;

    // Runtime assertions so none of the pins above is dead code the compiler
    // could shake out — the same reason SF-0 pairs each of its pins with one.
    expect(asUpstreamStandalone.kind).toBe('uups');
    expect(asUpstreamDeployOpts.timeout).toBe(1000);
    expect(asUpstreamValidation.unsafeAllowRenames).toBe(true);
    expect(asUpstreamKind.kind).toBe('beacon');
    expect(beaconProxyDeployOpts.timeout).toBe(0);
    expect(asUpstreamKindAgain.kind).toBe('uups');
    expect(asUpstreamStandaloneAgain.unsafeAllow).toEqual(['delegatecall']);
    expect(asUpstreamValidationAgain.unsafeAllowRenames).toBe(false);
  });

  it('composes the remaining aliases so all ten are covered, not just the interesting ones', () => {
    const deployProxy: DeployProxyOptions = { initializer: false };
    const upgradeProxy: UpgradeProxyOptions = { call: 'migrateV2' };
    const upgradeProxyStructured: UpgradeProxyOptions = {
      call: { fn: 'migrateV2', args: [7] },
    };
    const deployBeacon: DeployBeaconOptions = { redeployImplementation: 'always' };
    const upgradeBeacon: UpgradeBeaconOptions = { unsafeSkipStorageCheck: true };

    expect(deployProxy.initializer).toBe(false);
    expect(upgradeProxy.call).toBe('migrateV2');
    expect(upgradeProxyStructured.call).toEqual({ fn: 'migrateV2', args: [7] });
    expect(deployBeacon.redeployImplementation).toBe('always');
    expect(upgradeBeacon.unsafeSkipStorageCheck).toBe(true);
  });

  it('refuses a value outside the closed set at compile time, so a typo cannot type-check', () => {
    /*
     * The sibling's failure, made unwritable. `packages/hardhat-tron-upgrades/src/utils/options.ts:ValidationOptions`
     * widens the allowance set to `string[]`, so `'delegate-call'` type-checks
     * there and is then silently swallowed before it reaches the engine — a
     * safety opt-out the caller believes they set.
     */
    // @ts-expect-error SF-10 INV-1 / INV-2: 'delegate-call' is not an UnsafeAllowKind; upstream spells it 'delegatecall'.
    const hyphenated: UnsafeAllowKind = 'delegate-call';
    // @ts-expect-error SF-10 INV-1: the closed set is not widened to string.
    const widened: UnsafeAllowKind = 'anything-at-all';
    // @ts-expect-error SF-10 INV-2: ProxyKind is closed; case is not normalized (INV-9).
    const wrongCase: ProxyKind = 'Transparent';
    // @ts-expect-error SF-10 INV-2: RedeployMode is closed; 'onChange' is the parity target's own bug.
    const camelCase: RedeployMode = 'onChange';

    expect(hyphenated).toBe('delegate-call');
    expect(widened).toBe('anything-at-all');
    expect(wrongCase).toBe('Transparent');
    expect(camelCase).toBe('onChange');
  });

  it('declares no member on the portable surface whose name collides with an upstream member', () => {
    /*
     * The mechanical half of INV-1, and the reason it is scoped to four
     * declarations rather than to the file: `ResolvedUpgradeOptions` legitimately
     * declares `timeout` and `pollingInterval` because it is SF-10's *own* type,
     * not a mirror of upstream's. The property is about the **portable option
     * surface** — the four declarations a caller's object is typed against — where
     * every upstream member must arrive by `extends`.
     */
    const upstreamMemberNames = [
      'kind',
      'unsafeAllow',
      'unsafeAllowCustomTypes',
      'unsafeAllowLinkedLibraries',
      'unsafeAllowRenames',
      'unsafeSkipStorageCheck',
      'timeout',
      'pollingInterval',
    ];
    const types = sourceNamed('options/types.ts');

    // Exactly the three members the parity target adds, and nothing else.
    expect([...declaredMembers(types, 'StandaloneOptions')].sort()).toEqual([
      'constructorArgs',
      'redeployImplementation',
      'useDeployedImplementation',
    ]);
    // `UpgradeOptions` is composition alone — an empty body is the property.
    expect(declaredMembers(types, 'UpgradeOptions')).toEqual([]);
    expect(declaredMembers(types, 'InitializerOption')).toEqual(['initializer']);
    expect(declaredMembers(types, 'CallOption')).toEqual(['call']);

    for (const surface of [
      'StandaloneOptions',
      'UpgradeOptions',
      'InitializerOption',
      'CallOption',
    ]) {
      const declared = declaredMembers(types, surface);
      for (const upstreamName of upstreamMemberNames) {
        expect(
          declared,
          `${surface} must reach '${upstreamName}' by extension, never re-declare it`,
        ).not.toContain(upstreamName);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// SF-10 INV-2
// ---------------------------------------------------------------------------

describe('SF-10 INV-2: the closed value sets are derived from the installed engine and complete in both directions', () => {
  it('names the accepted set at runtime, because a refusal has to enumerate it', () => {
    // The compile-time halves — `satisfies` in one direction and
    // `NoMissingMembers<Exclude<…>>` in the other — cannot be asserted from
    // inside a passing suite; they are a compile error or they are nothing. The
    // negative control that proves they are not vacuous is a *separate* tsc
    // invocation, in `sf-10-exhaustiveness-negative-control.test.ts`.
    expect(unsafeAllowKinds).toHaveLength(14);
    expect(proxyKinds).toEqual(['uups', 'transparent', 'beacon']);
    expect(redeployModes).toEqual(['always', 'never', 'onchange']);
    expect(new Set(unsafeAllowKinds).size).toBe(unsafeAllowKinds.length);
  });

  it('declares the enumerations readonly and never mutates them from inside the package', () => {
    /*
     * **A gap found here and deliberately not asserted by polarity.**
     * The three enumerations are declared `as const satisfies readonly …[]`,
     * which is a *compile-time* guarantee — `as const` emits no `Object.freeze`,
     * so at runtime `unsafeAllowKinds`, `proxyKinds`, `redeployModes` and
     * `output/types.ts:degradedCodes` are ordinary mutable arrays, while every
     * other exported datum in the three directories (`optionsUnsupportedOnTron`,
     * `pluginOptionDefaults`, `defaultConstructorArgs`,
     * `recordedUpstreamValidationDefaults`, `engineWarningCapableExports` and its
     * two derived subsets, `uncapturedEngineWarnings`,
     * `unavailableContractMembers`) is explicitly frozen. Verified by execution
     * against the compiled output.
     *
     * That is exposure rather than a violation — no invariant states a freeze for
     * these four — so this test asserts the two properties that *do* hold, and the
     * gap is left recorded here as prose for the implementation to close rather
     * than pinned as an assertion. Asserting `isFrozen === false` would fail the
     * day the gap is closed, which is the wrong direction for a test to fail in.
     */
    // @ts-expect-error SF-10 INV-2: `push` is not on the readonly tuple's type, so no call site can compile.
    const mutator: unknown = unsafeAllowKinds.push;
    // …and it is present at runtime, which is the gap named above, stated as an
    // observation rather than mutated into existence. Nothing here changes the
    // array, so this test leaves no state behind.
    expect(typeof mutator).toBe('function');
    expect(unsafeAllowKinds).toHaveLength(14);

    // The structural half: no module in the three directories mutates any of
    // them, so the exposure is reachable only from outside the package.
    const mutators = ['push', 'pop', 'splice', 'shift', 'unshift', 'sort', 'reverse', 'fill'];
    for (const source of sf10Sources()) {
      const offending = source.accessChains.filter(chain =>
        ['unsafeAllowKinds', 'proxyKinds', 'redeployModes', 'degradedCodes'].some(name =>
          mutators.some(mutator => chain === `${name}.${mutator}`),
        ),
      );
      expect(offending, `${source.relative} must not mutate a closed enumeration`).toEqual(
        [],
      );
    }
  });

  it('hands a copy of the accepted set to a refusal, never the live enumeration', () => {
    /*
     * The containment property, and the one that makes the freeze gap above
     * survivable: a caller who edits the array they were handed in an error
     * cannot reach the plugin's own set. Verified for each of the three
     * enumerations at the site that names it.
     */
    const kindRefusal = (() => {
      try {
        resolveAsJavaScriptCaller({ kind: 'Transparent' }, UPGRADE_OPTION_KEYS);
      } catch (error) {
        return error as UnknownOptionError | { accepted: unknown };
      }
      throw new Error('expected a refusal');
    })();
    expect(kindRefusal.accepted).not.toBe(proxyKinds);
    expect(kindRefusal.accepted).toEqual([...proxyKinds]);

    const modeRefusal = (() => {
      try {
        resolveAsJavaScriptCaller(
          { redeployImplementation: 'onChange' },
          UPGRADE_OPTION_KEYS,
        );
      } catch (error) {
        return error as { accepted: unknown };
      }
      throw new Error('expected a refusal');
    })();
    expect(modeRefusal.accepted).not.toBe(redeployModes);
    expect(modeRefusal.accepted).toEqual([...redeployModes]);

    const allowRefusal = (() => {
      try {
        resolveAsJavaScriptCaller(
          { unsafeAllow: ['delegate-call'] },
          UPGRADE_OPTION_KEYS,
        );
      } catch (error) {
        return error as { accepted: unknown };
      }
      throw new Error('expected a refusal');
    })();
    expect(allowRefusal.accepted).not.toBe(unsafeAllowKinds);
    expect(allowRefusal.accepted).toEqual([...unsafeAllowKinds]);
  });

  it('accepts every member of the enumeration and refuses the near-miss, so the set is the guard', () => {
    // The behavioural proof that the enumeration *is* the accepted set, member by
    // member. This is what a widening would break, whatever protects the array.
    for (const kind of unsafeAllowKinds) {
      expect(() =>
        resolveAsJavaScriptCaller({ unsafeAllow: [kind] }, UPGRADE_OPTION_KEYS),
      ).not.toThrow();
    }
    for (const kind of proxyKinds) {
      expect(() =>
        resolveAsJavaScriptCaller({ kind }, UPGRADE_OPTION_KEYS),
      ).not.toThrow();
    }
    for (const mode of redeployModes) {
      expect(() =>
        resolveAsJavaScriptCaller(
          { redeployImplementation: mode },
          UPGRADE_OPTION_KEYS,
        ),
      ).not.toThrow();
    }
  });

  it('recovers UnsafeAllowKind through upstream public types, not by restating literals', () => {
    /*
     * The type-level shape of the derivation, pinned in both directions: a value
     * upstream accepts is an `UnsafeAllowKind`, and an `UnsafeAllowKind` is
     * assignable back into upstream's own array member. If SF-10 ever restated
     * the union as standalone literals, the second pin would still pass and the
     * first would drift — so both are needed.
     */
    const fromUpstream: NonNullable<ValidationOptions['unsafeAllow']> = [
      ...unsafeAllowKinds,
    ];
    const backToUpstream: ValidationOptions = { unsafeAllow: [...unsafeAllowKinds] };
    expect(fromUpstream).toEqual([...unsafeAllowKinds]);
    expect(backToUpstream.unsafeAllow).toHaveLength(14);
  });
});

// ---------------------------------------------------------------------------
// SF-10 INV-3
// ---------------------------------------------------------------------------

describe('SF-10 INV-3: ResolvedUpgradeOptions is total, frozen, and never holds undefined', () => {
  it('returns every field present with a defined value on the empty input', () => {
    const resolved = resolveUpgradeOptions(undefined, UPGRADE_OPTION_KEYS);
    expect(Object.keys(resolved).sort()).toEqual([
      'constructorArgs',
      'pollingInterval',
      'redeployImplementation',
      'timeout',
      'validation',
    ]);
    for (const [key, value] of Object.entries(resolved)) {
      expect(value, `resolved.${key} must never be undefined`).not.toBeUndefined();
    }
  });

  it('carries no own key whose value is undefined, on the validation object either', () => {
    const resolved = resolveUpgradeOptions(
      { kind: 'uups', unsafeAllow: ['constructor'] },
      UPGRADE_OPTION_KEYS,
    );
    const undefinedValued = Object.entries(resolved.validation)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);
    expect(undefinedValued).toEqual([]);
    // Upstream reads `opts.kind ?? 'transparent'`, so an own key carrying
    // `undefined` would quietly substitute the default for a caller who thought
    // they had set something. That is the runtime half of this property, and it
    // holds independently of `exactOptionalPropertyTypes`.
    expect(Object.hasOwn(resolved.validation, 'kind')).toBe(true);
    expect(resolved.validation.kind).toBe('uups');
  });

  it('freezes the result and both arrays, and refuses a mutation attempt', () => {
    const resolved = resolveUpgradeOptions(
      { constructorArgs: [1, 2], unsafeAllow: ['constructor'] },
      UPGRADE_OPTION_KEYS,
    );
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.constructorArgs)).toBe(true);
    expect(Object.isFrozen(resolved.validation)).toBe(true);
    expect(Object.isFrozen(resolved.validation.unsafeAllow)).toBe(true);

    /*
     * Probed through `Reflect` so the attempt needs no cast: `Reflect.set`
     * reports refusal as `false`, and `Reflect.apply(Array.prototype.push, …)`
     * reaches the frozen array's own `push` and throws, which is INV-16's
     * "a push on `resolved.validation.unsafeAllow` throws" verbatim.
     */
    expect(Reflect.set(resolved, 'timeout', 1)).toBe(false);
    expect(() =>
      Reflect.apply(Array.prototype.push, resolved.constructorArgs, [3]),
    ).toThrow(TypeError);
    expect(() =>
      Reflect.apply(Array.prototype.push, resolved.validation.unsafeAllow, ['constructor']),
    ).toThrow(TypeError);
    // A copy is of course writable — the freeze is on the plugin's array, not on
    // the caller's ability to work with the values.
    expect(() => [...resolved.constructorArgs].push(3)).not.toThrow();
    expect(resolved.timeout).toBe(60_000);
    expect(resolved.constructorArgs).toEqual([1, 2]);
  });

  it('makes an explicit undefined a compile error under exactOptionalPropertyTypes', () => {
    // Verified by compilation: TS2375. The runtime half is the
    // own-key assertion above; this is the half that stops a TypeScript caller
    // reaching the runtime hazard at all.
    // @ts-expect-error SF-10 INV-3: explicit undefined is not assignable under exactOptionalPropertyTypes (TS2375).
    const explicitUndefined: ValidationOptions = { kind: undefined };
    expect(Object.hasOwn(explicitUndefined, 'kind')).toBe(true);
  });

  it('declares every field required, so "defaults were applied" is a type-level fact', () => {
    // If a field were made optional, `Required<T>` would stop being assignable
    // *to* `T`'s own shape in the direction that matters and this pin would
    // break — which is the mechanism, and it is the same device INV-5 uses.
    const totality: ResolvedUpgradeOptions = resolveUpgradeOptions(
      {},
      UPGRADE_OPTION_KEYS,
    );
    const roundTrip: Required<ResolvedUpgradeOptions> = totality;
    const backAgain: ResolvedUpgradeOptions = roundTrip;
    expect(backAgain.redeployImplementation).toBe('onchange');
  });
});

// ---------------------------------------------------------------------------
// SF-10 INV-4
// ---------------------------------------------------------------------------

describe('SF-10 INV-4: undefined means absent — but only for a key the operation accepts', () => {
  it('rejects an unknown key whose value is undefined, naming the key', () => {
    /*
     * The typo escape hatch, closed. `Object.keys({ unsafeAllowRename:
     * undefined })` is `['unsafeAllowRename']`, so a rule that filtered
     * undefined-valued keys *first* would let the plural/singular typo through
     * silently — and `unsafeAllowRenames` is a storage-check opt-out, so the
     * caller believes they enabled a rename allowance and gets full strictness.
     */
    let thrown: unknown;
    try {
      resolveAsJavaScriptCaller(
        { unsafeAllowRename: undefined },
        UPGRADE_OPTION_KEYS,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnknownOptionError);
    const error = thrown as UnknownOptionError;
    expect(error.unknownKeys).toEqual(['unsafeAllowRename']);
    expect(error.message).toContain('unsafeAllowRename');
    // The correctly spelled key is in the accepted list, which is what makes the
    // diagnosis actionable rather than merely correct.
    expect(error.accepted).toContain('unsafeAllowRenames');
  });

  it('treats undefined as absent for a key the operation does accept', () => {
    const resolved = resolveAsJavaScriptCaller(
      { kind: undefined },
      UPGRADE_OPTION_KEYS,
    );
    expect(resolved.validation.kind).toBe('transparent');
  });

  it('rejects an accepted-elsewhere key the operation does not accept', () => {
    // Per-operation acceptance is what keeps the unknown-key rule useful:
    // `upgradeProxy` accepts `call` and `deployProxy` does not, and each passes
    // its own list — which is how the rule stays per-operation without SF-10
    // knowing the operation set.
    expect(() =>
      resolveAsJavaScriptCaller({ initializer: 'initialize' }, UPGRADE_OPTION_KEYS),
    ).toThrow(UnknownOptionError);
    expect(() =>
      resolveAsJavaScriptCaller(
        { initializer: 'initialize' },
        DEPLOY_PROXY_OPTION_KEYS,
      ),
    ).not.toThrow();
  });

  it('checks own keys regardless of value, so a null or falsy value is still a key', () => {
    for (const value of [null, false, 0, '', Number.NaN]) {
      expect(() =>
        resolveAsJavaScriptCaller({ typo: value }, UPGRADE_OPTION_KEYS),
      ).toThrow(UnknownOptionError);
    }
  });

  it("ignores inherited keys, because only own keys are the caller's statement", () => {
    // A JavaScript migration can pass an object with a prototype. An inherited
    // key is not something the caller wrote, so refusing it would refuse a
    // legitimate call — `Object.keys` is own-enumerable and gets this right.
    const prototype = { unsafeAllowRename: true };
    const supplied: object = Object.create(prototype);
    expect(() =>
      resolveAsJavaScriptCaller(supplied, UPGRADE_OPTION_KEYS),
    ).not.toThrow();
    // And the inherited value is not read into the result either.
    expect(
      resolveAsJavaScriptCaller(supplied, UPGRADE_OPTION_KEYS).validation
        .unsafeAllowRenames,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SF-10 INV-5
// ---------------------------------------------------------------------------

describe('SF-10 INV-5: every result type is total — no optional fields', () => {
  /*
   * The device is `Required<T>` assignable to `T` **and** `T` to `Required<T>`,
   * for each result type. Adding a single `?` breaks the second direction, which
   * is what makes the pin non-vacuous — the first direction holds for optional
   * members too.
   */
  it('pins each result type against its own Required<> in both directions', () => {
    const notes = operationNotes([]);
    const contract: ContractHandle = { address: 'TAddr' };
    const transaction = transactionIdentity('0xhash', 'deployProxy');

    const base: OperationResult = { notes };
    const baseBoth: Required<OperationResult> = base;
    const baseBack: OperationResult = baseBoth;

    const deployed: DeployedProxy = { notes, contract, address: 'TAddr', transaction };
    const deployedBoth: Required<DeployedProxy> = deployed;
    const deployedBack: DeployedProxy = deployedBoth;

    const upgraded: UpgradedProxy = {
      notes,
      contract,
      address: 'TAddr',
      transaction,
      implementation: 'TImpl',
    };
    const upgradedBoth: Required<UpgradedProxy> = upgraded;
    const upgradedBack: UpgradedProxy = upgradedBoth;

    const impl: ImplementationDeployment = { notes, address: 'TImpl', transaction };
    const implBoth: Required<ImplementationDeployment> = impl;
    const implBack: ImplementationDeployment = implBoth;

    const beacon: DeployedBeacon = {
      notes,
      contract,
      address: 'TBeacon',
      transaction,
      implementation: 'TImpl',
    };
    const beaconBoth: Required<DeployedBeacon> = beacon;
    const beaconBack: DeployedBeacon = beaconBoth;

    const validation: ValidationOutcome = { notes };
    const validationBoth: Required<ValidationOutcome> = validation;
    const validationBack: ValidationOutcome = validationBoth;

    const adoption: AdoptionOutcome = {
      notes,
      kind: 'implementation',
      address: 'TImpl',
      contract,
    };
    const adoptionBoth: Required<AdoptionOutcome> = adoption;
    const adoptionBack: AdoptionOutcome = adoptionBoth;

    const authority: AuthorityTransfer = {
      notes,
      transaction,
      previousOwner: 'TOld',
      newOwner: 'TNew',
    };
    const authorityBoth: Required<AuthorityTransfer> = authority;
    const authorityBack: AuthorityTransfer = authorityBoth;

    // One own-key sweep over every result: every declared key present, no
    // undefined value. This is the runtime half — an interface says nothing about
    // what a JavaScript producer actually built.
    const results: readonly object[] = [
      baseBack,
      deployedBack,
      upgradedBack,
      implBack,
      beaconBack,
      validationBack,
      adoptionBack,
      authorityBack,
    ];
    for (const result of results) {
      for (const [key, value] of Object.entries(result)) {
        expect(value, `${key} must be present and meaningful`).not.toBeUndefined();
      }
      expect(Object.hasOwn(result, 'notes')).toBe(true);
    }
  });

  it('gives the operations without a transaction a different type, not an optional field', () => {
    // Scenario 6 exactly: `forceImport` has no transaction, so a shared type with
    // `transaction?:` would force every caller of every operation to branch on
    // absence, and the one caller who forgets reads `undefined.hash`.
    const outcome: ValidationOutcome = { notes: operationNotes([]) };
    expect(Object.hasOwn(outcome, 'transaction')).toBe(false);
    // @ts-expect-error SF-10 INV-5: ValidationOutcome declares no `transaction` — the field does not exist to leave undefined.
    const noSuchField: unknown = outcome.transaction;
    expect(noSuchField).toBeUndefined();
  });

  it('keeps notes an array — possibly empty, never absent, always frozen', () => {
    const empty = operationNotes([]);
    expect(Array.isArray(empty)).toBe(true);
    expect(empty).toEqual([]);
    expect(Object.isFrozen(empty)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SF-10 INV-6
// ---------------------------------------------------------------------------

describe('SF-10 INV-6: TransactionIdentity.hash is supplied by the plugin, never read from the host accessor', () => {
  it('constructs a frozen identity from a plugin-supplied hash', () => {
    const identity = transactionIdentity('0xdeadbeef', 'deployProxy');
    expect(identity.hash).toBe('0xdeadbeef');
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it('refuses every falsy or non-string hash with a typed error naming the operation', () => {
    /*
     * The 4.8.0 fixture the invariant asks for, generalized. Verified by
     * execution on both installed trees:
     * `Contract._properties.transactionHash`'s getter throws on a falsy value in
     * 4.9.0 (`if (!transactionHash)`) but only on `null` in 4.8.0
     * (`if (transactionHash === null)`) — so on 4.8.0 an absent hash reads back
     * as `undefined`. That is what would reach this constructor, and it is
     * refused rather than carried onto the result.
     */
    const refused: readonly unknown[] = [undefined, null, '', 0, false, Number.NaN, {}];
    for (const hash of refused) {
      let thrown: unknown;
      try {
        transactionIdentity(hash, 'upgradeProxy');
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `hash ${String(hash)} must be refused`).toBeInstanceOf(
        TransactionHashUnavailableError,
      );
      const error = thrown as TransactionHashUnavailableError;
      expect(error.operation).toBe('upgradeProxy');
      expect(error.code).toBe('TRANSACTION_HASH_UNAVAILABLE');
      expect(error.message).toContain('upgradeProxy');
    }
  });

  it.each(tronBoxVersionsUnderTest.filter(tronBoxIsInstalled))(
    'reproduces the real absent-hash divergence on %s, which is why the plugin supplies the value',
    installName => {
      /*
       * The real host fixture, not a synthetic falsy value. The generalized test
       * above proves the constructor refuses `undefined`; this proves `undefined` is
       * what one of the two supported minors actually hands back — the fact that
       * makes reading the accessor unsafe rather than merely inelegant.
       *
       * Verified by execution, both trees installed side by side:
       *   4.9.0 -> throws `Could not find transaction hash for Box`
       *   4.8.0 -> returns `undefined`
       * Both accessors are non-configurable, so the plugin cannot repair either in
       * place.
       */
      const abstraction = tronBoxAbstractionWithNetwork(installName);
      const descriptor = Object.getOwnPropertyDescriptor(
        abstraction,
        'transactionHash',
      );
      expect(descriptor?.configurable).toBe(false);
      expect(typeof descriptor?.get).toBe('function');

      let read: unknown;
      let readThrew = false;
      try {
        read = (abstraction as { transactionHash?: unknown }).transactionHash;
      } catch {
        readThrew = true;
      }

      if (installName === 'tronbox-4.9.0') {
        expect(readThrew).toBe(true);
      } else {
        // The silent-wrong-answer case, on the real host: a field left `undefined`
        // that a caller would read as "not applicable".
        expect(readThrew).toBe(false);
        expect(read).toBeUndefined();
      }

      // Either way, that value never reaches a result: the envelope refuses it and
      // names the operation.
      let thrown: unknown;
      try {
        transactionIdentity(readThrew ? undefined : read, 'deployProxy');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TransactionHashUnavailableError);
      expect((thrown as TransactionHashUnavailableError).operation).toBe(
        'deployProxy',
      );
    },
  );

  it('drives both installed minors, so the divergence claim is not vacuous', () => {
    expect(tronBoxVersionsUnderTest.filter(tronBoxIsInstalled)).toEqual([
      'tronbox-4.9.0',
      'tronbox-4.8.0',
    ]);
  });

  it('names no host accessor anywhere in src/results/**', () => {
    // The structural half. If any module here read `handle.transactionHash`, the
    // guarantee would become the host's — and the host does not offer one on both
    // minors. The scan is over value references and access chains, so a doc
    // comment explaining the hazard is not a violation.
    const results = sf10Sources().filter(source =>
      source.relative.startsWith('results'),
    );
    expect(results.length).toBeGreaterThan(0);
    for (const source of results) {
      expect(
        source.accessChains.filter(chain => chain.endsWith('.transactionHash')),
        `${source.relative} must not read a host transaction-hash accessor`,
      ).toEqual([]);
      expect(
        valueIdentifierNames(source).filter(name => name === 'transactionHash'),
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// SF-10 INV-7
// ---------------------------------------------------------------------------

describe('SF-10 INV-7: the structural minima are pinned, and the pin asserts what is actually true', () => {
  it('pins OutputChannelSlot to HostChannelFacts with no import in either direction', () => {
    /*
     * The pin lives here rather than in `src/` precisely so it creates no import
     * edge: SF-10 INV-43 makes `src/output/**` import nothing at all, and this
     * assignment is what keeps the duplicated declaration from drifting.
     */
    const slot: OutputChannelSlot = {
      logger: { log: () => undefined },
      origin: 'config-lineage',
      hostQuietRequested: true,
    };
    const pin: HostChannelFacts = slot;
    expect(pin.origin).toBe('config-lineage');
    expect(pin.hostQuietRequested).toBe(true);
    expect(typeof pin.logger.log).toBe('function');
  });

  it('records the stronger contract-handle pin as an executable @ts-expect-error, not as prose', () => {
    const abstraction: ContractAbstraction = {
      contractName: 'Box',
      sourcePath: '/project/contracts/Box.sol',
    };
    /*
     * **The originally specified pin cannot compile.** It read
     * "`ContractAbstraction` satisfies `ContractHandle`":
     * `address` is required on `ContractHandle` and absent from SF-0's type
     * (TS2741). Left as written, the implementation would either delete the pin — losing
     * the drift protection that is the whole justification for declaring the
     * minima twice — or cast through it, losing the guarantee silently. So the
     * refusal is recorded as a directive the compiler enforces.
     */
    // @ts-expect-error SF-10 INV-7 / DEV-4: `address` is required on ContractHandle and absent from SF-0's ContractAbstraction (TS2741).
    const stronger: ContractHandle = abstraction;
    expect(stronger.contractName).toBe('Box');
  });

  it('pins the weaker form that does hold, and states that it is a loose pin', () => {
    const abstraction: ContractAbstraction = {
      contractName: 'Box',
      sourcePath: '/project/contracts/Box.sol',
    };
    const weaker: Omit<ContractHandle, 'address'> = abstraction;
    expect(weaker.contractName).toBe('Box');

    /*
     * Worth knowing, and stated here rather than discovered later: this pin is
     * **weak by construction**. `keyof ContractHandle` is `string | number`
     * because of the index signature, so `Omit<…, 'address'>` removes nothing and
     * almost any object satisfies the target. It still fails if SF-0 renames
     * `ContractAbstraction` or changes its shape incompatibly — which is the
     * drift it was declared to catch — but it is not a tight pin, and the
     * assertion below is what keeps that fact from being forgotten.
     */
    const removesNothing: Omit<ContractHandle, 'address'> = { address: 'TAddr' };
    expect(removesNothing.address).toBe('TAddr');
  });
});
