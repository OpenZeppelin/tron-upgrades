import util from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  HostInstanceSharedError,
  ResultCapabilityUnavailableError,
  UnavailableMemberAbsentError,
  hostSharingGuard,
  installGuarded,
  sealUnavailable,
  unavailableContractMembers,
  type LimitationRegistry,
} from '../src/results';
import {
  addPropStyleTarget,
  sourceNamed,
  tronBoxAbstraction,
} from './helpers/sf-10-fixtures';
import { tronBoxIsInstalled, tronBoxVersionsUnderTest } from './helpers/locate';

/**
 * SF-10 Auth Boundary — SF-10 INV-19 … INV-22.
 *
 * SF-10 has no caller-authorization boundary: it signs nothing, spends nothing and
 * reads no chain. Its trust boundary is the other one this design cares about —
 * **what the plugin is permitted to do to objects it does not own** — so this file
 * is the auth-boundary category applied to host-object augmentation.
 *
 * Technique: auth-boundary testing with an **unguarded twin**. For each guard, the
 * same fixtures are driven through a local re-implementation that omits exactly the
 * refusal, and the twin is asserted to break on a *named count* of cases. A guard
 * whose deletion changes nothing observable is a guard no test is really checking.
 *
 * Both installed TronBox trees are used where the property is about the host's own
 * object. `tronbox-4.9.0` and `tronbox-4.8.0` are installed side by side as aliased
 * trees, which is what makes a per-minor fact verifiable without leaving the
 * workspace.
 */

const installedVersions = tronBoxVersionsUnderTest.filter(tronBoxIsInstalled);

/**
 * A `ResolverIntercept`-shaped cache, modelled on the verified host mechanism.
 *
 * `build/components/Resolver/intercept.js:ResolverIntercept` holds `this.cache = {}`
 * keyed by normalized import path and `contracts()` returns `Object.values(cache)`
 * — byte-identical on 4.9.0 and 4.8.0 — which `Migrate` hands to
 * `artifactor.saveAll`. That is the path along which an unguarded augmentation
 * reaches the artifact on disk, so the fixture reproduces the two operations that
 * matter: cache membership, and enumeration for the write-back.
 */
function interceptCache(entries: Readonly<Record<string, object>>): {
  readonly cache: Readonly<Record<string, object>>;
  contracts(): readonly object[];
} {
  const cache = { ...entries };
  return {
    cache,
    contracts: () => Object.values(cache),
  };
}

/**
 * `installGuarded` with the refusal removed and nothing else changed.
 *
 * This is the non-vacuity instrument for INV-19, not an alternative
 * implementation: it exists so the tests below can assert that deleting the guard
 * breaks a named set of cases. If this twin behaved the same as the real function
 * on every fixture, the guard would be decorative and the tests asserting it would
 * be proving nothing.
 */
function installUnguarded(
  target: object,
  member: string,
  descriptor: PropertyDescriptor,
): void {
  Object.defineProperty(target, member, {
    enumerable: false,
    configurable: false,
    ...descriptor,
  });
}

// ---------------------------------------------------------------------------
// SF-10 INV-19
// ---------------------------------------------------------------------------

describe('SF-10 INV-19: the host-object augmentation policy — never mutate an instance the host shares', () => {
  it('augments an object the guard reports as the plugin\'s own', () => {
    const clone = { contractName: 'Box' };
    const cached = { contractName: 'Box' };
    const intercept = interceptCache({ './contracts/Box.sol': cached });
    const guard = hostSharingGuard(
      'the migration owns every handle TronBox passed it as an argument',
      intercept.contracts(),
    );

    installGuarded(clone, 'address', { value: 'TAddr' }, guard);
    expect(Reflect.get(clone, 'address')).toBe('TAddr');
    // Non-enumerable by default, so `JSON.stringify` and `Object.keys` see nothing
    // new — a caller that needs otherwise has to say so explicitly.
    expect(Object.keys(clone)).toEqual(['contractName']);
    expect(Object.getOwnPropertyDescriptor(clone, 'address')?.enumerable).toBe(false);
  });

  it('refuses a cached instance, naming the member and the guard\'s evidence', () => {
    const cached = { contractName: 'Box' };
    const intercept = interceptCache({ './contracts/Box.sol': cached });
    const evidence = 'ResolverIntercept.contracts() enumerates every cached abstraction';
    const guard = hostSharingGuard(evidence, intercept.contracts());
    const snapshot = structuredClone(cached);

    let thrown: unknown;
    try {
      installGuarded(cached, 'address', { value: 'TAddr' }, guard);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HostInstanceSharedError);
    const error = thrown as HostInstanceSharedError;
    expect(error.member).toBe('address');
    expect(error.evidence).toBe(evidence);
    expect(error.message).toContain('address');
    expect(error.message).toContain(evidence);
    expect(error.code).toBe('HOST_INSTANCE_SHARED');

    // Byte-identical afterwards: it never proceeds and never falls back to
    // mutating.
    expect(cached).toEqual(snapshot);
    expect(Object.getOwnPropertyDescriptor(cached, 'address')).toBeUndefined();
    expect(Object.keys(cached)).toEqual(['contractName']);
  });

  it('proves the refusal is not vacuous: the unguarded twin poisons two named cases', () => {
    /*
     * The two cases that break when the refusal is deleted, counted:
     *
     * 1. the cached abstraction itself gains the member, and
     * 2. `ResolverIntercept.contracts()` — the array `Migrate` hands to
     *    `artifactor.saveAll` — now enumerates a poisoned object, so the member is
     *    written into the artifact on disk and read by every later consumer.
     *
     * The guarded function breaks neither. If this test ever passes with the same
     * outcome for both functions, the guard has stopped doing anything.
     */
    const failures: string[] = [];

    const cachedGuarded = { contractName: 'Box' };
    const guardedIntercept = interceptCache({ './contracts/Box.sol': cachedGuarded });
    const guard = hostSharingGuard('the cache is enumerable', guardedIntercept.contracts());
    expect(() =>
      installGuarded(cachedGuarded, 'address', { value: 'TPoisoned' }, guard),
    ).toThrow(HostInstanceSharedError);
    if (Object.getOwnPropertyDescriptor(cachedGuarded, 'address') !== undefined) {
      failures.push('guarded: the cached abstraction was mutated');
    }
    if (
      guardedIntercept
        .contracts()
        .some(entry => Object.getOwnPropertyDescriptor(entry, 'address') !== undefined)
    ) {
      failures.push('guarded: the write-back enumeration carries the member');
    }
    expect(failures).toEqual([]);

    const cachedUnguarded = { contractName: 'Box' };
    const unguardedIntercept = interceptCache({
      './contracts/Box.sol': cachedUnguarded,
    });
    installUnguarded(cachedUnguarded, 'address', { value: 'TPoisoned' });

    const twinFailures: string[] = [];
    if (Object.getOwnPropertyDescriptor(cachedUnguarded, 'address') !== undefined) {
      twinFailures.push('unguarded: the cached abstraction was mutated');
    }
    if (
      unguardedIntercept
        .contracts()
        .some(entry => Object.getOwnPropertyDescriptor(entry, 'address') !== undefined)
    ) {
      twinFailures.push('unguarded: the write-back enumeration carries the member');
    }
    expect(twinFailures).toHaveLength(2);
  });

  it('makes the guard a required parameter, so a call site cannot omit it', () => {
    /*
     * The type-level half, and the reason it is required rather than optional: an
     * optional guard defaulting to "no check" would make the common call site the
     * unguarded one, which is the silent-degradation class this policy exists to
     * eliminate. Required means the compiler forces every call site to name where
     * its shared-instance knowledge comes from.
     */
    const target = { contractName: 'Box' };
    let thrown: unknown;
    try {
      // @ts-expect-error SF-10 INV-19: the guard is required — an omitted guard does not compile.
      installGuarded(target, 'address', { value: 'TAddr' });
    } catch (error) {
      thrown = error;
    }
    /*
     * And the JavaScript half, which is the one that matters for the consumer base:
     * a call site that omits the guard **crashes on the guard read** rather than
     * installing unguarded. The order inside `installGuarded` is what buys this —
     * `guard.isHostShared(target)` runs before `Object.defineProperty`, so an
     * absent guard can never end in a completed mutation. A defaulted guard, or a
     * guard read after the install, would both turn this into a silent
     * augmentation.
     */
    expect(thrown).toBeInstanceOf(TypeError);
    expect(Object.getOwnPropertyDescriptor(target, 'address')).toBeUndefined();
    expect(Object.keys(target)).toEqual(['contractName']);
  });

  it('drops non-object members from the guard\'s knowledge set', () => {
    // A primitive cannot be the target of a mutation, so keeping it would make the
    // set look larger than the knowledge behind it.
    const held = { contractName: 'Box' };
    const guard = hostSharingGuard('mixed bag', [held, 'a string', 42, null, undefined]);
    expect(guard.isHostShared(held)).toBe(true);
    expect(guard.isHostShared({ contractName: 'Box' })).toBe(false);
    // A function is object-like and can be mutated, so it stays in the set — which
    // matters because TronBox's contract abstractions *are* callable host objects.
    const callable = (): void => undefined;
    const callableGuard = hostSharingGuard('a callable abstraction', [callable]);
    expect(callableGuard.isHostShared(callable)).toBe(true);
  });

  it('freezes the guard, so the evidence cannot be rewritten after the fact', () => {
    const guard = hostSharingGuard('stated once', []);
    expect(Object.isFrozen(guard)).toBe(true);
    expect(Reflect.set(guard, 'evidence', 'rewritten')).toBe(false);
    expect(guard.evidence).toBe('stated once');
  });

  it('is the one property-installation site in src/results/**', () => {
    /*
     * The mechanical rule SF-11 inherits: `Object.defineProperty`,
     * `Object.defineProperties`, `Object.setPrototypeOf`, `delete` and new-member
     * assignment on a host-supplied object are permitted only through
     * `installGuarded`. Asserted as a count so a second site cannot appear without
     * failing here.
     */
    const mutators = [
      'Object.defineProperty',
      'Object.defineProperties',
      'Object.setPrototypeOf',
      'Reflect.defineProperty',
      'Reflect.setPrototypeOf',
      'Reflect.deleteProperty',
    ];
    for (const relative of ['results/types.ts', 'results/limitations.ts', 'results/index.ts']) {
      const source = sourceNamed(relative);
      for (const mutator of mutators) {
        expect(
          source.accessChains.filter(chain => chain === mutator),
          `${relative} must have no property-installation site`,
        ).toEqual([]);
      }
    }
    const augmentation = sourceNamed('results/augmentation.ts');
    expect(
      augmentation.accessChains.filter(chain => chain === 'Object.defineProperty'),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SF-10 INV-20
// ---------------------------------------------------------------------------

describe('SF-10 INV-20: the result contract seals by proxying, not by mutating', () => {
  it('refuses the registered member, naming the mechanism and the alternative', () => {
    const target = addPropStyleTarget();
    const sealed = sealUnavailable(target);

    let thrown: unknown;
    try {
      // `void` so the read is the operation under test rather than an unused value.
      void sealed.events;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ResultCapabilityUnavailableError);
    const error = thrown as ResultCapabilityUnavailableError;
    expect(error.member).toBe('events');
    expect(error.code).toBe('RESULT_CAPABILITY_UNAVAILABLE');
    // The mechanism: an unconditional empty array a caller would read as "the
    // transaction emitted no events".
    expect(error.message).toContain('empty array');
    // The alternative: the receipt, reachable from the hash the result carries.
    expect(error.message).toContain('transaction receipt');
    expect(error.limitation.because.length).toBeGreaterThan(0);
    expect(error.limitation.instead.length).toBeGreaterThan(0);
  });

  it('forwards everything else unchanged, including an ABI-derived call', () => {
    const target = addPropStyleTarget();
    const sealed = sealUnavailable(target);
    expect(sealed.address).toBe(target.address);
    expect(sealed.contractName).toBe('Box');
    expect(sealed.isDeployed()).toBe(true);
    expect(sealed.retrieve()).toBe('an ABI-derived call');
    // A member the host never had reads as plain `undefined`, which is honest.
    expect(sealed.logs).toBeUndefined();
  });

  it('is not the target, but keeps the target\'s prototype so instanceof holds', () => {
    class HostAbstraction {
      readonly address = 'TAddr';
    }
    const target: object = new HostAbstraction();
    Object.defineProperty(target, 'events', {
      enumerable: false,
      configurable: false,
      get: () => [],
    });
    const sealed = sealUnavailable(target);
    expect(sealed).not.toBe(target);
    expect(Object.getPrototypeOf(sealed)).toBe(Object.getPrototypeOf(target));
    expect(sealed instanceof HostAbstraction).toBe(true);
  });

  it('does not refuse an inherited Object.prototype member', () => {
    // `hasOwnProperty` rather than an index lookup on the registry: a plain object
    // literal inherits `constructor`, `toString` and friends, so an index lookup
    // would refuse `handle.constructor` and report it as an unavailable capability.
    const sealed = sealUnavailable(addPropStyleTarget());
    expect(typeof sealed.constructor).toBe('function');
    expect(typeof sealed.toString).toBe('function');
    expect(typeof sealed.hasOwnProperty).toBe('function');
  });

  it('leaves both serializers working', () => {
    const sealed = sealUnavailable(addPropStyleTarget());
    expect(() => JSON.stringify(sealed)).not.toThrow();
    expect(() => util.inspect(sealed)).not.toThrow();
    expect(() => util.inspect(sealed, { depth: null })).not.toThrow();
    expect(() => ({ ...sealed })).not.toThrow();
  });

  it('proves the designed mechanism cannot run — DEV-1, executable rather than quoted', () => {
    /*
     * The specified `defineUnavailable(target, member, limitation)` installs a
     * throwing accessor on the returned handle. It **throws for the one and only
     * member registered**, because `Contract.addProp` builds every
     * `_properties` member with `configurable: false` and `Utils.bootstrap`
     * applies it to the abstraction *and to every clone*. The deploy path would
     * fail after a successful on-chain deployment, which is the worst possible
     * place to fail.
     *
     * A test using a plain data property for `events` would pass against a
     * mechanism that cannot run at all, which is why the fixture installs it the
     * way the host does.
     */
    const target = addPropStyleTarget();
    expect(
      Object.getOwnPropertyDescriptor(target, 'events')?.configurable,
    ).toBe(false);
    expect(() =>
      Object.defineProperty(target, 'events', {
        get: () => {
          throw new Error('the designed refusal');
        },
      }),
    ).toThrow(TypeError);

    // And the `get` trap *is* legal here for precisely the reason
    // `defineProperty` is not: `events` is a non-configurable accessor **with a
    // defined getter**, and the `[[Get]]` proxy invariant constrains only
    // non-configurable data properties and getter-less accessors.
    expect(() => sealUnavailable(target)).not.toThrow();
  });

  it.each(installedVersions)(
    'reproduces the non-configurable accessor and the proxy refusal on %s',
    installName => {
      const abstraction = tronBoxAbstraction(installName);
      const descriptor = Object.getOwnPropertyDescriptor(abstraction, 'events');
      expect(descriptor?.configurable).toBe(false);
      expect(descriptor?.enumerable).toBe(false);
      expect(typeof descriptor?.get).toBe('function');

      // The designed mechanism, against the real host object.
      expect(() =>
        Object.defineProperty(abstraction, 'events', { value: [] }),
      ).toThrow(/Cannot redefine property: events/);

      // The shipped mechanism, against the same object.
      const sealed = sealUnavailable(abstraction);
      expect(() => sealed.events).toThrow(ResultCapabilityUnavailableError);
      expect(sealed.contractName).toBe('Box');
      expect(typeof sealed.isDeployed).toBe('function');
      expect(Object.getPrototypeOf(sealed)).toBe(Object.getPrototypeOf(abstraction));
    },
  );

  it('has both supported minors installed, so the per-minor cases above actually ran', () => {
    // Without this, a missing install would turn every per-minor assertion into a
    // silent skip — which is the shape of a test suite that stops covering the
    // thing it was written for.
    expect([...installedVersions]).toEqual([...tronBoxVersionsUnderTest]);
  });
});

// ---------------------------------------------------------------------------
// SF-10 INV-21
// ---------------------------------------------------------------------------

describe('SF-10 INV-21: the sealed handle is never handed back to the host', () => {
  it('gives the host the target and never the proxy', () => {
    /*
     * A spy host recording every object it receives, and an identity check against
     * the returned handle. The hazard: the host writes the artifact from an object
     * whose `events` accessor throws, so `artifactor.saveAll` fails on a successful
     * deployment — or worse, the host's own read of a trapped member turns a
     * plugin refusal into a host crash the user cannot attribute.
     */
    const received: object[] = [];
    const target = addPropStyleTarget();
    const host = {
      require: (): object => {
        received.push(target);
        return target;
      },
      contracts: (): readonly object[] => {
        received.push(target);
        return [target];
      },
      saveAll: (contracts: readonly object[]): void => {
        received.push(...contracts);
      },
    };

    // The plugin's shape: every host interaction completes, *then* the proxy is
    // created at the return boundary.
    const fromHost = host.require();
    host.saveAll(host.contracts());
    const sealed = sealUnavailable(fromHost);

    expect(received.length).toBeGreaterThan(0);
    for (const entry of received) {
      expect(entry).not.toBe(sealed);
      expect(entry).toBe(target);
    }
    // And the host never reads a trapped member, because it never holds the proxy.
    expect(() => host.saveAll(received)).not.toThrow();
  });

  it('creates the proxy at the return boundary, so no earlier plugin path can hold it', () => {
    // The structural half: `sealUnavailable` is called from nowhere inside
    // `src/results/**` — the operations call it at their return statement — so
    // there is no SF-10 path that could pass the proxy onward.
    for (const relative of [
      'results/types.ts',
      'results/augmentation.ts',
      'results/index.ts',
    ]) {
      const source = sourceNamed(relative);
      expect(
        source.accessChains.filter(chain => chain.includes('sealUnavailable')),
        `${relative} must not consume the sealed handle`,
      ).toEqual([]);
    }
    const limitations = sourceNamed('results/limitations.ts');
    // Declared once, called nowhere in this directory.
    expect(limitations.text).toContain('export function sealUnavailable');
  });
});

// ---------------------------------------------------------------------------
// SF-10 INV-22
// ---------------------------------------------------------------------------

describe('SF-10 INV-22: a member is registered as unavailable only if the host actually has it', () => {
  it('registers events, because the host has it', () => {
    expect(Object.keys(unavailableContractMembers)).toEqual(['events']);
    expect(() => sealUnavailable(addPropStyleTarget())).not.toThrow();
  });

  it('refuses a fabricated member, naming that the host has no such member', () => {
    const fabricated: LimitationRegistry = Object.freeze({
      logs: Object.freeze({
        because: 'a fabricated non-capability',
        instead: 'nothing, because there is nothing to disclaim',
      }),
    });
    let thrown: unknown;
    try {
      sealUnavailable(addPropStyleTarget(), fabricated);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnavailableMemberAbsentError);
    const error = thrown as UnavailableMemberAbsentError;
    expect(error.member).toBe('logs');
    expect(error.code).toBe('UNAVAILABLE_MEMBER_ABSENT');
    // Registering it would disclaim a capability the host never offered, making
    // the limitation list a fiction. The message has to say that, because the
    // reader's first instinct is that the registry is simply out of date.
    expect(error.message).toContain('no such member');
    expect(error.message).toContain('undefined, which is honest');
  });

  it('checks at seal time, before the proxy exists', () => {
    // A host change is reported where it happens rather than at the caller's first
    // read — which on the deploy path is after a successful on-chain deployment.
    const fabricated: LimitationRegistry = Object.freeze({
      neverPresent: Object.freeze({ because: 'x', instead: 'y' }),
    });
    let returned: unknown = 'sentinel';
    try {
      returned = sealUnavailable(addPropStyleTarget(), fabricated);
    } catch {
      // expected
    }
    expect(returned).toBe('sentinel');
  });

  it('accepts a member the target has only through its prototype', () => {
    // `member in target` is the right operator: a host member installed on the
    // prototype is still a member the host has, and refusing it would refuse a
    // legitimate registration.
    const prototype = { queued: () => [] };
    const target: object = Object.create(prototype);
    const registry: LimitationRegistry = Object.freeze({
      queued: Object.freeze({ because: 'because.', instead: 'instead.' }),
    });
    const sealed = sealUnavailable(target, registry);
    expect(() => sealed.queued).toThrow(ResultCapabilityUnavailableError);
  });

  it.each(installedVersions)(
    'scopes the registry precisely on %s: events is present, logs and decodeLogs are not',
    installName => {
      /*
       * The scoping **is** the finding. `Contract._properties` declares
       * `events: function events(){ return [] }` — an unconditional empty array,
       * byte-identical on both minors — which a caller reasonably reads as "the
       * transaction emitted no events". `logs` and `decodeLogs` do not exist at
       * all: zero occurrences in the compiled module on either minor, verified this
       * stage. So `result.contract.logs` is plain `undefined`, which is honest,
       * whereas `result.contract.events` is a misleading `[]`.
       */
      const abstraction = tronBoxAbstraction(installName);
      expect('events' in abstraction).toBe(true);
      expect('logs' in abstraction).toBe(false);
      expect('decodeLogs' in abstraction).toBe(false);
      // The misleading value, read directly off the host so the reason for the
      // registry is not merely asserted.
      expect(Reflect.get(abstraction, 'events')).toEqual([]);

      const fabricated: LimitationRegistry = Object.freeze({
        logs: Object.freeze({ because: 'x', instead: 'y' }),
      });
      expect(() => sealUnavailable(abstraction, fabricated)).toThrow(
        UnavailableMemberAbsentError,
      );
    },
  );

  it('freezes the v1 registry and its one entry', () => {
    expect(Object.isFrozen(unavailableContractMembers)).toBe(true);
    expect(Object.isFrozen(unavailableContractMembers.events)).toBe(true);
  });
});
