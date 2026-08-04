import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  buildArtifactAmbiguityIndex,
  configLineageFields,
  EnvironmentInconsistentError,
  EnvironmentIncompleteError,
  fileSystemBuildInfoReader,
  REDACTED_HOST_HANDLE,
  resolveEnvironment,
  slotNames,
  TronBoxEnvironmentError,
  type ArtifactCandidate,
  type Inconsistency,
} from '../src/environment';
// Deep imports: none of these is on the seam's public face. **Corrected by SF-1
// Tests (2026-07-31)** — the comment previously called `unsatisfiedSlot` /
// `sealSlot` an open question, and that question has since been settled in both
// directions, asymmetrically:
//
// - `unsatisfiedSlot` **is** on the face now (`src/environment/index.ts:23`), added
//   as the one-line additive SF-0 amendment SF-1 needed so `src/chain/errors.ts`
//   could mint the `chain` slot's failures through the only sanctioned route
//   (SF-0's INV-14, SF-1's INV-18). It is no longer a deep import at all.
// - `sealSlot` is **deliberately not** on the face, and that is a settled design
//   property rather than an open question: SF-1 holds no handle in any field of any
//   exported object (INV-3 / INV-9 / INV-42), so it meets SF-0's INV-40 guarantee by
//   construction rather than by redaction and has no need of it. SF-1 was expected to
//   concluded the adapter would require sealing; it does not.
//
// `test/` already deep-imports `errors`, `artifacts`, `network` and `types`, so the
// remaining deep imports below follow the established convention rather than widening
// `index.ts` to make a test convenient.
import {
  inspectConfigLineages,
  resolutionSharingGuard,
} from '../src/environment/config-lineage';
import {
  hostSharingGuard,
  HostInstanceSharedError,
  InternalPathRecorder,
  sealSlot,
} from '../src/environment/handles';
import {
  networkEntry,
  SENTINEL_FILE_CONTENT,
  SENTINEL_MNEMONIC,
  SENTINEL_PRIVATE_KEY,
} from './helpers/config-fixtures';
import { allFixtureProbes } from './helpers/fixture-catalogue';
import {
  artifactsOnlyHandles,
  migrateShapedHandles,
  testShapedHandles,
} from './helpers/handles';
import {
  collectLeaves,
  collectStrings,
  ownEnumerableRoutes,
  projectedSurface,
  serializedTree,
  shallowestRouteDepth,
  sortedOwnKeys,
} from './helpers/introspect';
import { makeTempDir } from './helpers/locate';
import { projectPathsFixture } from './helpers/paths-fixtures';
import {
  collidingReader,
  filesReader,
  singleContractReader,
  throwingReader,
  DEFAULT_BUILD_INFO_DIR,
} from './helpers/readers';
import {
  callSites,
  environmentSources,
  typedInterpolations,
  valueIdentifierNames,
} from './helpers/source-scan';

/**
 * Sensitive Data Handling — INV-40, INV-41, INV-42.
 *
 * The technique is leak probing, and the fixtures are built so the secret is
 * genuinely one property away from the values SF-0 legitimately projects rather
 * than parked somewhere unreachable. `build/components/Config.js:Config`'s
 * `privateKey` getter always returns `null` — safe, and useless as a presence
 * check — while the real key lives on `network_config.privateKey`, and
 * `network_config` is the merged object the seam reads `txDefaults` from. So the
 * credential is *in the same object* as legitimate output.
 *
 * Every fixture in `helpers/fixture-catalogue.ts` configures
 * {@link SENTINEL_PRIVATE_KEY} on the selected network, which is what makes
 * INV-40's own stated test — "run that assertion across **all** fixtures, not
 * one" — mechanical rather than aspirational.
 *
 * INV-40 states two mechanisms and ranks them, and the tests below are
 * organized to match. The **primary** mechanism is structural — a host handle never
 * reaches a formatter, and every message is composed from the seam's own projected
 * slots — which is what makes the guarantee hold for `util.inspect`, `console.log`,
 * template interpolation and own-enumerable traversal alike. `handles.ts:sealSlot`'s
 * `toJSON` is a **backstop** covering serialization only. So each channel is swept
 * separately: `JSON.stringify` (the backstop), `util.inspect(…, { depth: null })`
 * (the channel `toJSON` is invisible to), and an AST scan asserting no handle is
 * interpolated anywhere in `src/environment/**` (the mechanism itself).
 *
 * An earlier pass recorded the un-narrowed reading as an expected failure, because
 * "no credential in any slot field" cannot hold alongside INV-29's `scheduling`
 * exposure. INV-40 now states the invariant's *subject* instead of narrowing
 * INV-29, so the property is now stated truthfully and every test here passes.
 */

const SECRET_SENTINELS: readonly string[] = [
  SENTINEL_PRIVATE_KEY,
  SENTINEL_MNEMONIC,
];

function caught(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, and it returned normally');
}

/**
 * Every string reachable from a **live** object graph by own enumerable
 * properties — the pre-serialization view, which is what INV-40's literal
 * wording ranges over. Distinct from {@link collectStrings}, which walks the
 * post-`toJSON` tree.
 */
function liveStrings(root: unknown): readonly string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      found.push(node);
      return;
    }
    if (node === null || typeof node !== 'object' || seen.has(node)) {
      return;
    }
    seen.add(node);
    for (const value of Object.values(node)) {
      visit(value);
    }
  };
  visit(root);
  return found;
}

function inconsistentFrom(act: () => unknown): EnvironmentInconsistentError {
  const error = caught(act);
  expect(error).toBeInstanceOf(EnvironmentInconsistentError);
  if (!(error instanceof EnvironmentInconsistentError)) {
    throw new Error('unreachable');
  }
  return error;
}

// ---------------------------------------------------------------------------
// INV-40
// ---------------------------------------------------------------------------

describe('INV-40: no secret enters a slot, provenance, or a message', () => {
  it('leaks no sentinel through any observable of any fixture in the catalogue', () => {
    // INV-40's own stated test, run across every fixture. A leak that only shows
    // up on the disagreement path, or only inside an `IndeterminateReason`, is
    // exactly what a single-fixture assertion misses.
    const probes = allFixtureProbes();
    expect(probes.length).toBeGreaterThan(20);
    for (const probe of probes) {
      for (const observable of probe.observable) {
        for (const sentinel of SECRET_SENTINELS) {
          expect(
            observable.includes(sentinel),
            `${probe.name} (${probe.outcome}) leaked a sentinel`,
          ).toBe(false);
        }
      }
    }
  });

  it('exercises both outcomes in that sweep, so it is not vacuous', () => {
    // A catalogue that happened to resolve every fixture would leave every error
    // message unswept. Both outcomes have to be present for the sweep to mean
    // what it claims.
    const outcomes = new Set(allFixtureProbes().map(probe => probe.outcome));
    expect([...outcomes].sort()).toEqual(['resolved', 'threw']);
  });

  it('leaks no mnemonic configured beside the key on the network entry', () => {
    // A second credential shape, on the same object. `Config.prototype.merge`
    // assigns every key of the supplied options onto the Config, so an
    // undeclared credential key lands as a plain own property and is reachable by
    // the same traversal as `privateKey`.
    const shape = migrateShapedHandles({
      networks: {
        development: networkEntry({
          extra: { mnemonic: SENTINEL_MNEMONIC, apiKey: SENTINEL_MNEMONIC },
        }),
      },
    });
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    const strings = collectStrings(serializedTree(env));
    for (const sentinel of SECRET_SENTINELS) {
      expect(strings).not.toContain(sentinel);
    }
    expect(collectStrings(serializedTree(env.provenance))).not.toContain(
      SENTINEL_MNEMONIC,
    );
  });

  it('reports key presence as a boolean derived from presence alone', () => {
    const cases: readonly [string, unknown, boolean][] = [
      ['a configured 64-hex key', SENTINEL_PRIVATE_KEY, true],
      ['a short but non-empty key', 'aa', true],
      ['an empty-string key', '', false],
      ['a null key', null, false],
      ['a numeric key', 1234, false],
    ];
    for (const [label, privateKey, expected] of cases) {
      const shape = migrateShapedHandles({
        networks: { development: networkEntry({ privateKey }) },
      });
      const env = resolveEnvironment(shape.handles, { require: ['network'] });
      expect(env.network.signingKeyConfigured, label).toBe(expected);
      expect(typeof env.network.signingKeyConfigured, label).toBe('boolean');
    }
  });

  it('reports false, not a failure, when the network entry carries no key at all', () => {
    const shape = migrateShapedHandles({
      networks: { development: networkEntry({ omit: ['privateKey'] }) },
    });
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(env.network.signingKeyConfigured).toBe(false);
  });

  it('diagnoses a throwing privateKey accessor rather than treating it as absent', () => {
    // A raising getter is a different state from an absent key (INV-17), and
    // collapsing it into `false` would report "no signing key configured" for a
    // project that has one.
    const entry = networkEntry();
    delete entry.privateKey;
    Object.defineProperty(entry, 'privateKey', {
      get: (): never => {
        throw new Error('the keystore is locked');
      },
      enumerable: true,
      configurable: true,
    });
    const shape = migrateShapedHandles({
      networks: { development: entry },
    });
    const error = caught(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error).toBeInstanceOf(EnvironmentIncompleteError);
    if (!(error instanceof EnvironmentIncompleteError)) {
      throw new Error('unreachable');
    }
    expect(error.message).toContain('networks.development.privateKey');
    expect(error.message).toContain('threw when read');
    expect(error.message).not.toContain('the keystore is locked');
  });

  it('reads the key once and never re-reads it after the check', () => {
    // "The value is never read into a variable that outlives the check": a lazy
    // re-read would show up as a rising counter, and a retained copy would show
    // up in the serialization sweep. Both are asserted, because neither alone
    // covers the other.
    let reads = 0;
    const entry = networkEntry();
    delete entry.privateKey;
    Object.defineProperty(entry, 'privateKey', {
      get: (): string => {
        reads += 1;
        return SENTINEL_PRIVATE_KEY;
      },
      enumerable: true,
      configurable: true,
    });
    const shape = migrateShapedHandles({
      networks: { development: entry },
    });
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    const afterResolution = reads;
    expect(afterResolution).toBeGreaterThan(0);
    expect(env.network.signingKeyConfigured).toBe(true);

    JSON.stringify(env);
    void env.network.txDefaults;
    void env.provenance.internalPathsRead;
    expect(reads).toBe(afterResolution);
    expect(collectStrings(serializedTree(env))).not.toContain(
      SENTINEL_PRIVATE_KEY,
    );
  });

  it('names the type, never the value, when a credential-shaped value is wrong-typed', () => {
    // `config-lineage.ts:describe` names the *type* of an offending value. A
    // message quoting the value would leak whatever the user put there, and a
    // `from` holding an object with a `privateKey` is a realistic mistake.
    const shape = migrateShapedHandles({
      from: { privateKey: SENTINEL_PRIVATE_KEY },
    });
    const error = caught(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error).toBeInstanceOf(EnvironmentIncompleteError);
    if (!(error instanceof EnvironmentIncompleteError)) {
      throw new Error('unreachable');
    }
    expect(error.message).toContain('must be a string or absent');
    expect(error.message).toContain('of type object');
    expect(error.message).not.toContain(SENTINEL_PRIVATE_KEY);
    expect(error.message).not.toContain('privateKey');
  });

  it('types no slot field to hold a key, and exposes no networks map', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    const leaves = collectLeaves(serializedTree(env));
    for (const leaf of leaves) {
      expect(
        /privateKey|mnemonic|secret|apiKey|password/i.test(leaf.path),
        `${leaf.path} is a credential-shaped field`,
      ).toBe(false);
    }
    expect(sortedOwnKeys(env.network)).toEqual([
      'artifactNetworkId',
      'configuredId',
      'name',
      'sender',
      'signingKeyConfigured',
      'txDefaults',
    ]);
  });

  it('reads privateKey by literal name in exactly one module, and only for presence', () => {
    const sources = environmentSources();
    const readers = sources.filter(source =>
      source.readPropertyKeys.includes('privateKey'),
    );
    expect(readers.map(source => source.relative)).toEqual(['network.ts']);

    // Every use of the read result, enumerated. The three permitted consumers are
    // the failure branch (`.ok` / `.reason`) and the presence predicate
    // (`typeof .value === 'string' && .value.length > 0`). Anything else — an
    // assignment into a slot field, a spread of the entry, a template literal —
    // would add a chain outside this set and fail here.
    const permitted = new Set([
      'privateKeyRead.ok',
      'privateKeyRead.reason',
      'privateKeyRead.value',
      'privateKeyRead.value.length',
    ]);
    for (const source of sources) {
      const chains = source.accessChains.filter(chain =>
        /privateKey/i.test(chain),
      );
      if (source.relative !== 'network.ts') {
        expect(chains, `${source.relative}`).toEqual([]);
        continue;
      }
      expect([...new Set(chains)].sort()).toEqual([...permitted].sort());
    }

    // And the value never reaches a rendered string: no string literal or
    // template in the seam mentions the key by name in a message position.
    const networkSource = sources.find(
      source => source.relative === 'network.ts',
    );
    expect(
      networkSource?.stringLiterals.filter(literal =>
        /privateKey/.test(literal),
      ),
    ).toEqual(['privateKey']);
  });

  it('redacts every host handle on serialization, which is what makes the sweep possible', () => {
    // Not cosmetic. A real `Deployer` reaches its Config, whose
    // `resolver.options` closes a cycle, so plain `JSON.stringify(composite)`
    // throws `TypeError: Converting circular structure to JSON` without the
    // `toJSON` seal — meaning INV-40's own stated test would not be *executable*,
    // let alone passing. The premise is asserted first so this cannot pass for
    // the wrong reason.
    const shape = migrateShapedHandles();
    expect(() => JSON.stringify(shape.deployer)).toThrow(TypeError);
    expect(liveStrings(shape.deployer)).toContain(SENTINEL_PRIVATE_KEY);

    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    expect(() => JSON.stringify(env)).not.toThrow();
    expect(collectStrings(serializedTree(env))).toContain(
      REDACTED_HOST_HANDLE,
    );
  });

  /**
   * INV-40, ranging over what the seam projects — a passing property.
   *
   * An earlier wording said "any slot field" without stating the subject, which
   * made it unsatisfiable alongside INV-29: the `scheduling` slot exposes the whole
   * `deployer` because SF-4 needs the queue, and from a real deployer a configured
   * `privateKey` is reachable by own-enumerable traversal at depth 4 —
   * `deployer.options.options.network_config.privateKey`, verified against 4.9.0
   * and 4.8.0. SF-0 recorded that as an expected failure. The current wording states
   * the subject: the invariant ranges over what the seam *produces* — the fields it
   * projects, `provenance`, and every message — and not over the live graph
   * reachable *through* a handle it deliberately hands over. Under that wording the
   * property holds, so this is a passing test rather than a deferral record.
   *
   * The check runs in the live view with handle members dropped, not redacted, so
   * the `toJSON` backstop plays no part in it. See `projectedSurface`.
   */
  it('projects no sentinel into any slot field, provenance, or message', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    const projected = projectedSurface(env, REDACTED_HOST_HANDLE);
    for (const sentinel of SECRET_SENTINELS) {
      expect(liveStrings(projected)).not.toContain(sentinel);
    }

    // Non-vacuous: the projection must still carry the seam's own output, or a
    // helper that returned `{}` would pass every assertion above.
    const projectedStrings = liveStrings(projected);
    expect(projectedStrings).toContain('development');
    expect(projectedStrings).toContain('/proj');
  });

  it('prints no sentinel through util.inspect at full depth, on every fixture', () => {
    // INV-40's promoted assertion, and the one the serialization sweep provably
    // cannot cover: `toJSON` is invisible to `util.inspect`, so a composite that
    // passed `JSON.stringify` could still print a credential to a terminal or a CI
    // log. `depth: null` is required rather than tidy — the default of `2` renders
    // `[Object]` exactly where a nested credential would sit, which is how this
    // assertion would pass while being blind.
    //
    // Driven from the catalogue so it ranges over *all* fixtures: every entry
    // contributes its `inspect(projectedSurface(env), { depth: null })` and, on the
    // failure paths, `inspect(error, { depth: null })`. The single-fixture version
    // of this test would miss a leak that only appears in an `IndeterminateReason`.
    const probes = allFixtureProbes();
    expect(probes.length).toBeGreaterThan(20);
    const inspected = probes.flatMap(probe =>
      probe.observable.filter(observable => !observable.startsWith('{"')),
    );
    expect(inspected.length).toBeGreaterThan(probes.length);
    for (const rendering of inspected) {
      for (const sentinel of SECRET_SENTINELS) {
        expect(rendering.includes(sentinel)).toBe(false);
      }
    }

    // And the assertion is not passing because the renderings are empty.
    expect(inspected.some(rendering => rendering.includes('development'))).toBe(
      true,
    );
  });

  it('inspects the three handle-free slots live, with no projection step at all', () => {
    // The strongest form, with nothing between `util.inspect` and the object the
    // consumer holds: `paths`, `network` and `provenance` carry no handle, so they
    // need no projection and the assertion is over the live slot itself.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, {
      require: ['paths', 'network'],
    });
    for (const slot of [env.paths, env.network, env.provenance]) {
      const rendered = inspect(slot, { depth: null });
      for (const sentinel of SECRET_SENTINELS) {
        expect(rendered).not.toContain(sentinel);
      }
      expect(rendered.length).toBeGreaterThan(2);
    }
  });

  it('passes no host handle to a formatter anywhere in the seam', () => {
    // INV-40's **primary** mechanism, which is structural rather than a backstop.
    // Redaction protects `JSON.stringify` and nothing else, so if `toJSON` were
    // understood as *the* protection then the next slot with a handle would be
    // protected exactly until someone wrote ``logger.log(`resolved: ${env.output}`)``
    // — the invariant's own second violation scenario, with the credential on a
    // terminal and `toJSON` never consulted.
    //
    // The check is type-based rather than a deny-list of handle names, because a
    // name list is both over-broad and under-broad: `ambiguity.ts` legitimately
    // interpolates a `Dirent`'s `name`, `network.ts` must never interpolate its
    // `entry`, and either way the list is defeated the moment a handle is bound to
    // a fresh local. The property that actually holds needs no list — a handle
    // enters the seam as `unknown` (INV-25), so **every** interpolated expression
    // is statically a primitive, and the only route from `unknown` to renderable is
    // through a projection.
    const interpolations = typedInterpolations();
    expect(interpolations.length).toBeGreaterThan(30);
    const nonPrimitive = interpolations.filter(
      interpolation => !interpolation.isPrimitive,
    );
    expect(
      nonPrimitive.map(
        interpolation =>
          `${interpolation.relative}: \${${interpolation.expression}} is ${interpolation.type}`,
      ),
      'a non-primitive reached a template literal in the seam',
    ).toEqual([]);

    // Non-vacuous in the way that matters: the near-miss is allowed. `lineage.prefix`
    // is a projected string and *is* interpolated; `lineage.config` is the host
    // object and is not. A test that forbade the whole `lineage` root would pass
    // while proving less.
    const expressions = interpolations.map(
      interpolation => interpolation.expression,
    );
    expect(expressions).toContain('lineage.prefix');
    expect(expressions).not.toContain('lineage.config');

    // And no formatter is even named in the seam, so there is no second channel to
    // audit. `console` is INV-32's; these are the programmatic ones.
    const formatters = /^(inspect|format|formatWithOptions)$/;
    for (const source of environmentSources()) {
      expect(
        valueIdentifierNames(source).filter(name => formatters.test(name)),
        `${source.relative} names a formatter`,
      ).toEqual([]);
      expect(
        source.importSpecifiers.filter(specifier =>
          /^(node:)?util$/.test(specifier),
        ),
        `${source.relative} imports util`,
      ).toEqual([]);
    }
  });

  it('pins the live reachability INV-29 documents, and that INV-40 does not range over', () => {
    // Not a deferral record. INV-40 states its own subject, which resolves the
    // conflict *by scoping* rather than by narrowing INV-29 — so these exposures are
    // deliberate and this test is their documentation. Naming both means a future
    // reader knows the exposure is two-handled: `artifacts` reaches the key too, so
    // narrowing `scheduling` alone would not change the picture.
    const viaScheduling = resolveEnvironment(
      migrateShapedHandles().handles,
      { require: ['scheduling'] },
    );
    expect(liveStrings(viaScheduling.scheduling.deployer)).toContain(
      SENTINEL_PRIVATE_KEY,
    );

    const viaArtifacts = resolveEnvironment(
      artifactsOnlyHandles().handles,
      { require: ['artifacts'] },
      { buildInfoReader: singleContractReader() },
    );
    expect(liveStrings(viaArtifacts.artifacts.intercept)).toContain(
      SENTINEL_PRIVATE_KEY,
    );

    // And the serialized form of the very same composite is clean, which is what
    // makes the exposure a capability rather than a leak: the handle is reachable
    // to a caller who asks for it by name, and absent from anything a user pastes.
    expect(
      collectStrings(serializedTree(viaScheduling)),
    ).not.toContain(SENTINEL_PRIVATE_KEY);
    expect(collectStrings(serializedTree(viaArtifacts))).not.toContain(
      SENTINEL_PRIVATE_KEY,
    );
  });
});

// ---------------------------------------------------------------------------
// INV-29 / INV-40 — the augmentation policy guard, proven non-vacuous
// ---------------------------------------------------------------------------

/**
 * `handles.ts:sealSlot`'s third parameter — the host-object augmentation
 * policy, expressed as an injected predicate: *the plugin may define non-enumerable
 * accessors on a host object it has verified it does not share with the host's own
 * cache; it may never mutate a shared instance.*
 *
 * **Why these cases exist in this shape.** The predicate is `false` at all five of
 * the seam's sealing sites today, because every one passes a fresh object literal
 * allocated in the same call. So a happy-path-only suite — which is what the rest of
 * this file already is, since every composite it builds seals successfully — would
 * pass verbatim against a `sealSlot` whose assertion had been deleted. The refusal
 * *is* the mechanism, and an unexercised mechanism is not a guard. This shape
 * was established with a throwaway probe that named this file as its permanent
 * home; these are that probe's assertions 1–4, persisted.
 *
 * The guard's teeth are in the future, not the present: it converts "breaks if the
 * plugin changes" into "refuses if the plugin changes", so a refactor that seals a
 * *host handle itself* fails here instead of writing `toJSON` onto an object TronBox
 * later hands to `artifactor.saveAll`.
 *
 * These import `sealSlot`, `hostSharingGuard` and `HostInstanceSharedError` from the
 * module rather than from `../src/environment`, because none is on the seam's public
 * face and whether SF-1 reuses the seam's error idiom was open.
 * Deep-importing follows this suite's existing convention.
 */
describe('INV-29 / INV-40: the host-augmentation guard refuses a shared instance', () => {
  const EVIDENCE = 'the object under test was handed in by the host';

  it('refuses to install toJSON on an object the host also holds', () => {
    // Probe assertion 1. The whole point of the parameter, and the only case that
    // distinguishes a live guard from a deleted one.
    const hostObject: Record<string, unknown> = { network: 'development' };
    const guard = hostSharingGuard(EVIDENCE, [hostObject]);
    expect(guard.isHostShared(hostObject)).toBe(true);

    const error = caught(() => sealSlot(hostObject, [], guard));
    expect(error).toBeInstanceOf(HostInstanceSharedError);
    if (!(error instanceof HostInstanceSharedError)) {
      throw new Error('unreachable');
    }
    expect(error.member).toBe('toJSON');
    expect(error.evidence).toBe(EVIDENCE);
    expect(error.name).toBe('HostInstanceSharedError');

    // The evidence is reproduced in the message verbatim. A refusal that named the
    // policy but not its evidence would leave the reader unable to tell a real
    // collision from a mis-supplied guard, which is the one thing this error has to
    // do that a bare `Error` would not.
    expect(error.message).toContain(EVIDENCE);
    expect(error.message).toContain('toJSON');

    // And it is deliberately outside the three-member `TronBoxEnvironmentError`
    // family (INV-10): this reports a plugin defect, not a diagnosis of the user's
    // environment.
    expect(error).not.toBeInstanceOf(TronBoxEnvironmentError);
  });

  it('leaves the refused object byte-identical, because it throws before mutating', () => {
    // Probe assertion 2. A guard that threw *after* `Object.defineProperty` would
    // satisfy the case above while having already poisoned the host object — the
    // exact outcome the policy exists to prevent. The order is the property.
    const hostObject: Record<string, unknown> = { network: 'development' };
    const before = Object.getOwnPropertyNames(hostObject);

    caught(() => sealSlot(hostObject, [], hostSharingGuard(EVIDENCE, [hostObject])));

    expect(Object.getOwnPropertyNames(hostObject)).toEqual(before);
    expect(Object.prototype.hasOwnProperty.call(hostObject, 'toJSON')).toBe(false);
    expect(Object.isFrozen(hostObject)).toBe(false);
    expect(hostObject.network).toBe('development');
    // Still writable, so the host's own later use of it is unaffected.
    hostObject.network = 'shasta';
    expect(hostObject.network).toBe('shasta');
  });

  it('still seals a fresh literal that embeds that same host object', () => {
    // Probe assertion 3, and the one that proves the guard discriminates rather than
    // refusing on mere containment. Every real sealing site does exactly this: the
    // sealed object is a fresh literal whose *fields* are host handles. A guard that
    // refused on containment would make the seam unable to seal anything at all, and
    // the obvious fix for that would be to delete the guard.
    const hostObject: Record<string, unknown> = {
      privateKey: SENTINEL_PRIVATE_KEY,
    };
    const guard = hostSharingGuard(EVIDENCE, [hostObject]);

    const slot = sealSlot(
      { deployer: hostObject, origin: 'deployer' },
      ['deployer'],
      guard,
    );

    expect(Object.isFrozen(slot)).toBe(true);
    expect(JSON.parse(JSON.stringify(slot))).toEqual({
      deployer: REDACTED_HOST_HANDLE,
      origin: 'deployer',
    });
    // The live field is the same object, untouched — redaction is serialization-only
    // (INV-29 exposes the handle as a capability), and the embedded host object never
    // received a `toJSON` of its own.
    expect(slot.deployer).toBe(hostObject);
    expect(Object.prototype.hasOwnProperty.call(hostObject, 'toJSON')).toBe(false);
    expect(hostObject.privateKey).toBe(SENTINEL_PRIVATE_KEY);
  });

  it('claims nothing for a guard built from primitives alone', () => {
    // Probe assertion 4. `hostSharingGuard` drops non-objects, because a primitive
    // cannot be a mutation target and keeping it would make the set look larger than
    // the knowledge behind it. Asserted so the dropping is a decision, not an
    // accident of `Set` semantics.
    const guard = hostSharingGuard(EVIDENCE, [
      'development',
      42,
      null,
      undefined,
      true,
    ]);
    const slot: Record<string, unknown> = { network: 'development' };
    expect(guard.isHostShared(slot)).toBe(false);
    expect(() => sealSlot(slot, [], guard)).not.toThrow();
  });

  it('refuses through the resolution guard the seam actually builds, not only a hand-built one', () => {
    // The four sites that share `config-lineage.ts:resolutionSharingGuard` get their
    // guard from the lineages, so the hand-built cases above would not catch a
    // `resolutionSharingGuard` that enumerated the wrong objects. Driven from the
    // same fixture the rest of this file uses.
    const shape = migrateShapedHandles();
    const recorder = new InternalPathRecorder();
    const guard = resolutionSharingGuard(
      shape.handles,
      inspectConfigLineages(shape.handles, recorder),
    );

    // Every raw handle, plus every Config and Resolver reached through one.
    for (const [label, hostObject] of [
      ['deployer', shape.deployer],
      ['intercept', shape.intercept],
      ['config', shape.config],
      ['resolver', shape.resolver],
    ] as const) {
      expect(
        guard.isHostShared(hostObject as object),
        `${label} should be recognized as host-shared`,
      ).toBe(true);
    }

    // And a fresh literal is not, which is why the five real sites pass.
    expect(guard.isHostShared({ deployer: shape.deployer })).toBe(false);
    expect(guard.evidence).toContain('raw handles');
  });

  it('requires a guard at exactly five sealing sites, so a sixth handle cannot ship unsealed', () => {
    // INV-29's rule stated over the thing the seam controls: its own sealing sites.
    // The count *and* the per-site handle keys, because a count alone would let a
    // sixth handle-bearing slot ship as long as an existing seal was deleted in the
    // same commit.
    const sites = callSites(environmentSources(), 'sealSlot');
    expect(
      sites.map(site => `${site.relative}:${site.args[1] ?? '<none>'}`).sort(),
    ).toEqual([
      "artifacts.ts:['intercept']",
      "output.ts:['logger']",
      "resolve.ts:['tronWrap']",
      "resolve.ts:['waitForTransactionReceipt']",
      "resolve.ts:['deployer']",
    ].sort());

    // Three arguments at every site — the guard is required, never optional. An
    // optional guard defaulting to "no check" is the silent-degradation class the
    // policy exists to remove, and TypeScript is what enforces it; this asserts the
    // signature was not relaxed to make a new site compile.
    for (const site of sites) {
      expect(site.args, `${site.relative}:${site.line}`).toHaveLength(3);
      expect(site.args[2], `${site.relative}:${site.line} names no guard`).toMatch(
        /SharingGuard|sealing/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// INV-29 — the five-handle rule, and what is measured versus what is ruled
// ---------------------------------------------------------------------------

/**
 * INV-29's widened subject: **all five sealed handles are unsafe to log,
 * two verified reachable today.**
 *
 * The rule is deliberately not keyed to today's reachable set. Reachability is a
 * property of the *host's* object graph — a `v4.10` that added a `.config`
 * back-reference to the logger would falsify a two-handle rule with nothing in this
 * repository failing — while the five sealing sites are the seam's own and the seam
 * controls them. `docs/environment/safety.md` § "The five redacted handles, and which
 * are credential-reachable" publishes that same split, and this suite is what holds
 * it to the code.
 *
 * So the tests below separate the two claims on purpose: the *rule* is asserted over
 * the sealing sites and the composite's redaction, and the *measurements* are dated
 * facts about `v4.8.0` and `v4.9.0` asserted separately (here against the fixtures,
 * and against the real host in `real-tronbox.test.ts`). `chain.tronWrap` is covered by
 * the rule and **was not measured** — a live instance needs a reachable node — and the
 * last case exists to keep a reader from mistaking the fixture's zero routes for a
 * measurement of the real one.
 */
describe('INV-29: all five sealed handles are unsafe to log, two verified reachable today', () => {
  const SEALED_HANDLES: readonly {
    readonly slot: 'chain' | 'receipts' | 'scheduling' | 'artifacts' | 'output';
    readonly member: string;
  }[] = [
    { slot: 'chain', member: 'tronWrap' },
    { slot: 'receipts', member: 'waitForTransactionReceipt' },
    { slot: 'scheduling', member: 'deployer' },
    { slot: 'artifacts', member: 'intercept' },
    { slot: 'output', member: 'logger' },
  ];

  it('redacts all five on serialization regardless of which are reachable', () => {
    // The rule, over the full set. Five handles, five seals, no exemption for the
    // three with no credential route today.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    const serialized = serializedTree(env) as Record<
      string,
      Record<string, unknown>
    >;
    for (const { slot, member } of SEALED_HANDLES) {
      expect(serialized[slot]?.[member], `${slot}.${member}`).toBe(
        REDACTED_HOST_HANDLE,
      );
    }
    expect(
      collectStrings(serialized).filter(value => value === REDACTED_HOST_HANDLE),
    ).toHaveLength(SEALED_HANDLES.length);

    // And the live members are still the handles the caller asked for — the rule
    // governs logging, not access.
    expect(env.scheduling.deployer).toBe(shape.deployer);
    expect(env.artifacts.intercept).toBe(shape.intercept);
  });

  it('reaches the credential from both credential-bearing handles, through the fixtures', () => {
    // The fixture half of the measurement, and its limits stated rather than
    // glossed. What the fixtures reproduce is that the credential *is* own-enumerably
    // reachable from both handles — which is the premise INV-40's narrow scoping
    // rests on, and the reason `sealSlot` applies to `artifacts` on the same footing
    // as to `scheduling`.
    //
    // What they do **not** reproduce is the route *count*. A plain-object Config has
    // no private `_values` backing store and its `network_config` merge is not an own
    // enumerable accessor, so the fixtures expose one route each where the real host
    // exposes three at a shallower depth. The count and the shallowest depth are
    // real-host facts and are pinned against the real `Deployer` and
    // `ResolverIntercept` on both minors in `real-tronbox.test.ts` — asserting three
    // here would be asserting a fixture detail while looking like a host fact.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );

    for (const [label, handle, route] of [
      [
        'scheduling.deployer',
        env.scheduling.deployer,
        'options.options.networks.development.privateKey',
      ],
      [
        'artifacts.intercept',
        env.artifacts.intercept,
        'resolver.options.networks.development.privateKey',
      ],
    ] as const) {
      const routes = ownEnumerableRoutes(handle, SENTINEL_PRIVATE_KEY, 6);
      expect(routes, label).toEqual([route]);
      expect(shallowestRouteDepth(routes), `${label} shallowest depth`).toBe(5);
    }

    // Both bottom out in the *same* Config, which is why the two exposures have
    // identical terms rather than merely similar ones: `config-lineage.ts` reads
    // `deployer.options.options` and `artifacts.resolver` precisely because they are
    // two routes to one object (INV-12), and credential reachability is that same
    // coincidence read from the other side. So a diagnostic that avoided the deployer
    // and inspected the intercept would not be safer.
    expect(shape.resolver.options).toBe(shape.config);
  });

  it('finds no route from the two handles that have none, which is what makes the two-reachable claim non-vacuous', () => {
    // The negative half. Without it, "two of five are reachable" is a claim nobody
    // checked the other side of — and a route enumerator with a bug that returned
    // `[]` would make the *positive* cases above the only thing standing between the
    // suite and a silent false negative.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );

    for (const [label, handle] of [
      ['output.logger', env.output.logger],
      ['receipts.waitForTransactionReceipt', env.receipts.waitForTransactionReceipt],
    ] as const) {
      const routes = ownEnumerableRoutes(handle, SENTINEL_PRIVATE_KEY, 6);
      expect(routes, `${label} should reach no credential`).toEqual([]);
      expect(shallowestRouteDepth(routes)).toBeUndefined();
    }

    // Non-vacuous in the way that matters here: the same enumerator, on the same
    // composite, in the same test, does find the credential where it is. A logger
    // fixture that happened to close over the Config would fail the assertions above
    // — which is the fixture drift this case is really watching for, since the real
    // `Config` default logger's own keys are exactly `["log"]`.
    expect(
      ownEnumerableRoutes(env.scheduling.deployer, SENTINEL_PRIVATE_KEY, 6),
    ).not.toEqual([]);
    expect(sortedOwnKeys(env.output.logger as object)).toEqual(['log']);
  });

  it('covers chain.tronWrap by rule, and records that it was never measured', () => {
    // The honest case, and the reason it is a test rather than a comment. The
    // fixture `tronWrap` reaches no credential — but that is a fact about the
    // fixture, not about a live `TronWrap`, which cannot be constructed without a
    // reachable node. Turning the fixture's zero routes into a safety claim is the
    // specific mistake this case exists to block.
    //
    // Two host facts were verified statically at v4.8.0 and v4.9.0 and the seam
    // relies on **neither**: the account keys live in a module-scope
    // `let privateKeyByAccount` (`src/components/TronWrap/index.js`) rather than on
    // the instance, and the one instance-reachable credential the host does hide is
    // masked by the host's own proxy (`src/components/TronWrap/TronWebProxy.js`,
    // `HIDDEN_PROPS = new Set(['defaultPrivateKey'])`, filtered out of `ownKeys`). A
    // mask the seam does not own is not a guarantee the seam can make.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(shape.handles, { require: ['chain'] });

    // What is asserted: the rule. Sealed and redacted, exactly like the two measured
    // handles.
    expect((serializedTree(env) as { chain: { tronWrap: unknown } }).chain.tronWrap)
      .toBe(REDACTED_HOST_HANDLE);
    expect(Object.isFrozen(env.chain)).toBe(true);

    // What is *not* asserted, made explicit: the fixture is a stand-in with a single
    // `trx` member and no Config anywhere in it, so its route count says nothing
    // about the real instance and no assertion here treats it as evidence.
    expect(sortedOwnKeys(env.chain.tronWrap as object)).toEqual(['trx']);
    expect(
      ownEnumerableRoutes(env.chain.tronWrap, SENTINEL_PRIVATE_KEY, 6),
      'the fixture reaches no credential — a property of the fixture, not a measurement',
    ).toEqual([]);
  });

  it('names all five in the redaction rule and none of them in the projected surface', () => {
    // The two invariants read together, over the same composite: INV-29 exposes the
    // five as named capabilities, INV-40 ranges over what the seam *projects*. So
    // every one of the five is absent from the projected surface by construction,
    // which is what makes the two statements compatible rather than a conflict that
    // was resolved by narrowing one of them.
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: slotNames },
      { buildInfoReader: singleContractReader() },
    );
    const projected = projectedSurface(env, REDACTED_HOST_HANDLE) as Record<
      string,
      Record<string, unknown>
    >;
    for (const { slot, member } of SEALED_HANDLES) {
      expect(
        Object.prototype.hasOwnProperty.call(projected[slot] ?? {}, member),
        `${slot}.${member} should be dropped from the projected surface`,
      ).toBe(false);
    }
    // Non-vacuous: the slots themselves survive with their non-handle fields.
    expect(projected.output?.origin).toBe('deployer');
    expect(projected.output?.hostQuietRequested).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INV-41
// ---------------------------------------------------------------------------

describe('INV-41: the cross-check payload is allow-listed, so a future upstream key cannot leak', () => {
  it('renders the disagreement verbatim while a sentinel key sits on both lineages', () => {
    // INV-41's own stated test. The `inconsistent` message *must* name both
    // values verbatim — correct and useful for `contracts_build_directory`, and
    // disastrous for a credential — so the protection has to be the field set,
    // not the rendering.
    const shape = testShapedHandles(
      { networks: { development: networkEntry({ from: 'TSenderLive' }) } },
      { from: 'TSenderSnapshot' },
    );
    const error = inconsistentFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.message).toContain('"TSenderSnapshot"');
    expect(error.message).toContain('"TSenderLive"');
    expect(error.message).toContain('Config field "from" disagrees');
    for (const sentinel of SECRET_SENTINELS) {
      expect(error.message).not.toContain(sentinel);
    }
    expect(JSON.stringify(error.inconsistencies)).not.toContain(
      SENTINEL_PRIVATE_KEY,
    );
  });

  it('never compares a secret-bearing key the next upstream release might add', () => {
    // The scenario the allow-list exists for: a new network-config key holding a
    // credential, disagreeing across the two lineages. A deny-list is safe only
    // against the keys that existed when it was written, and a dynamic
    // enumeration is safe against none.
    const shape = testShapedHandles(
      {
        extra: { futureCredential: SENTINEL_PRIVATE_KEY },
        networks: { development: networkEntry({ from: 'TSame' }) },
      },
      {
        extra: { futureCredential: SENTINEL_MNEMONIC },
        feeLimit: 42,
      },
    );
    const error = inconsistentFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    expect(error.inconsistencies).toHaveLength(1);
    expect(error.inconsistencies[0]).toEqual({
      kind: 'config-lineage-field',
      field: 'feeLimit',
      viaDeployer: 42,
      viaArtifacts: 1_000_000_000,
    });
    expect(error.message).not.toContain('futureCredential');
    for (const sentinel of SECRET_SENTINELS) {
      expect(error.message).not.toContain(sentinel);
    }
  });

  it('reports nothing at all when only an un-listed key disagrees', () => {
    // The stronger form: the *only* difference between the lineages is a
    // secret-bearing key nobody listed, and the resolution succeeds silently
    // rather than surfacing it. That is the intended behaviour — a field outside
    // the exposed surface is not SF-0's to compare — and it is what makes the
    // allow-list a closed hole rather than a delayed one.
    const shape = testShapedHandles(
      { extra: { futureCredential: SENTINEL_PRIVATE_KEY } },
      { extra: { futureCredential: SENTINEL_MNEMONIC } },
    );
    const env = resolveEnvironment(shape.handles, { require: ['network'] });
    expect(env.network.name).toBe('development');
    expect(collectStrings(serializedTree(env))).not.toContain(
      SENTINEL_PRIVATE_KEY,
    );
  });

  it('types field as the allow-list union rather than string', () => {
    // The compile-time half. If `field` were `string`, this directive would be an
    // unused-`@ts-expect-error` compile failure, so the assertion cannot pass
    // vacuously.
    const rejected = {
      kind: 'config-lineage-field',
      // @ts-expect-error INV-41: `privateKey` is not a member of ConfigScalarField.
      field: 'privateKey',
      viaDeployer: SENTINEL_PRIVATE_KEY,
      viaArtifacts: SENTINEL_MNEMONIC,
    } satisfies Inconsistency;
    // Referenced so the object is not dead code the compiler may skip.
    expect(rejected.kind).toBe('config-lineage-field');
    expect([...configLineageFields]).not.toContain('privateKey');
  });

  it('iterates the list rather than the lineage keys, in one place', () => {
    // `compareConfigValues(fields, …)` takes the field list as a parameter and
    // flat-maps over it. An `Object.keys(lineage)` anywhere in the comparison path
    // would reintroduce dynamic enumeration.
    const lineageSource = environmentSources().find(
      source => source.relative === 'config-lineage.ts',
    );
    expect(lineageSource).toBeDefined();
    const compare = /export function compareConfigValues[\s\S]*?\n\}/.exec(
      lineageSource?.text ?? '',
    );
    expect(compare).not.toBeNull();
    expect(compare?.[0]).toContain('fields.flatMap');
    expect(compare?.[0]).not.toContain('Object.keys');
    expect(compare?.[0]).not.toContain('Object.entries');
  });

  it('leaves signingKeyConfigured on the list as a boolean, never as the key', () => {
    // Included in the allow-list because omitting an exposed scalar would
    // reinstate INV-12's silent preference for that one field — and safe to
    // include because it is a boolean by construction.
    expect([...configLineageFields]).toContain('signingKeyConfigured');
    const shape = testShapedHandles(
      { networks: { development: networkEntry({ privateKey: SENTINEL_PRIVATE_KEY }) } },
      { networks: { development: networkEntry({ omit: ['privateKey'] }) } },
    );
    const error = inconsistentFrom(() =>
      resolveEnvironment(shape.handles, { require: ['network'] }),
    );
    const signing = error.inconsistencies.find(
      item =>
        item.kind === 'config-lineage-field' &&
        item.field === 'signingKeyConfigured',
    );
    expect(signing).toEqual({
      kind: 'config-lineage-field',
      field: 'signingKeyConfigured',
      viaDeployer: false,
      viaArtifacts: true,
    });
    expect(error.message).toContain('true');
    expect(error.message).toContain('false');
    expect(error.message).not.toContain(SENTINEL_PRIVATE_KEY);
  });
});

// ---------------------------------------------------------------------------
// INV-42
// ---------------------------------------------------------------------------

describe('INV-42: errors and provenance carry identifiers and paths, never file or source content', () => {
  it('carries no build-info file content into a candidate', () => {
    // The reader fixtures embed {@link SENTINEL_FILE_CONTENT} in every abi,
    // bytecode and metadata field, so there is real content for the assertion to
    // *not* find. A build-info output file is a whole compilation — every source
    // path, every ABI, and in a monorepo, paths disclosing unreleased products.
    const index = buildArtifactAmbiguityIndex(
      projectPathsFixture(),
      collidingReader(),
    );
    const candidates = index.candidates('Box');
    expect(candidates).toHaveLength(2);
    expect(JSON.stringify(candidates)).not.toContain(SENTINEL_FILE_CONTENT);
    for (const candidate of candidates) {
      expect(sortedOwnKeys(candidate)).toEqual([
        'buildInfoFile',
        'contractName',
        'sourcePath',
      ]);
    }
    expect(JSON.stringify(index.report)).not.toContain(SENTINEL_FILE_CONTENT);
  });

  it('carries no file content into an ambiguous resolution', () => {
    const shape = migrateShapedHandles();
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: collidingReader() },
    );
    const resolution = env.artifacts.resolve('Box');
    expect(resolution.status).toBe('ambiguous');
    if (resolution.status !== 'ambiguous') {
      throw new Error('unreachable');
    }
    // The abstraction itself is the host's object and is deliberately handed
    // through, so the assertion ranges over the *candidates* and the report.
    expect(JSON.stringify(resolution.candidates)).not.toContain(
      SENTINEL_FILE_CONTENT,
    );
    expect(JSON.stringify(env.artifacts.ambiguities())).not.toContain(
      SENTINEL_FILE_CONTENT,
    );
  });

  it("keeps a parse failure's quoted bytes out of the reason, through the real reader", () => {
    // The premise is asserted first, because this test is worthless if Node's
    // message happens not to quote the file: `JSON.parse` embeds a snippet of the
    // offending source, so forwarding `error.message` would put contract source
    // into an `IndeterminateReason` and from there into CI logs.
    const invalid = `${SENTINEL_FILE_CONTENT} not json at all`;
    const parseError = caught(() => JSON.parse(invalid));
    expect(parseError).toBeInstanceOf(SyntaxError);
    expect((parseError as SyntaxError).message).toMatch(/SF0-SENTIN/);

    const dir = makeTempDir('parse-leak');
    fs.writeFileSync(path.join(dir, 'aaa.output.json'), invalid);
    const report = buildArtifactAmbiguityIndex(
      projectPathsFixture({ root: dir, buildInfoDirectory: dir }),
      fileSystemBuildInfoReader,
    ).report;

    expect(report.status).toBe('indeterminate');
    if (report.status !== 'indeterminate') {
      throw new Error('unreachable');
    }
    expect(report.reason).toEqual({
      kind: 'build-info-unreadable',
      file: path.join(dir, 'aaa.output.json'),
      cause: 'the file is not valid JSON',
    });
    expect(JSON.stringify(report.reason)).not.toMatch(/SF0-SENTIN/);
    // The path is what the user needs in order to recompile, and it is carried.
    expect(report.reason.kind === 'build-info-unreadable' && report.reason.file)
      .toContain('aaa.output.json');
  });

  it('reduces a throwing reader to a code or a class name, never its message', () => {
    // `safeCause` takes the host error's `code` when it has one, its `name` when
    // that is more specific than `Error`, and a fixed fallback otherwise. A raw
    // `message` is never forwarded, because a reader is injected code whose
    // message the seam does not control.
    const cases: readonly [string, unknown, string][] = [
      [
        'a plain Error carrying a secret in its message',
        new Error(`read failed for key ${SENTINEL_PRIVATE_KEY}`),
        'the build-info reader failed',
      ],
      [
        'a subclassed error',
        new TypeError(`bad reader holding ${SENTINEL_PRIVATE_KEY}`),
        'TypeError',
      ],
      [
        'a Node errno-style error',
        Object.assign(new Error(SENTINEL_PRIVATE_KEY), { code: 'EACCES' }),
        'EACCES',
      ],
      ['a thrown string', `plain string ${SENTINEL_PRIVATE_KEY}`, 'the build-info reader failed'],
    ];

    for (const [label, thrown, expectedCause] of cases) {
      const report = buildArtifactAmbiguityIndex(
        projectPathsFixture(),
        throwingReader(thrown),
      ).report;
      expect(report.status, label).toBe('indeterminate');
      if (report.status !== 'indeterminate') {
        throw new Error('unreachable');
      }
      expect(report.reason, label).toEqual({
        kind: 'build-info-unreadable',
        file: projectPathsFixture().buildInfoDirectory,
        cause: expectedCause,
      });
      expect(JSON.stringify(report.reason), label).not.toContain(
        SENTINEL_PRIVATE_KEY,
      );
    }
  });

  it('embeds no file content in the reason for a file lacking a contract map', () => {
    const report = buildArtifactAmbiguityIndex(
      projectPathsFixture(),
      filesReader([
        {
          name: 'aaa.output.json',
          output: {
            sources: { [SENTINEL_FILE_CONTENT]: { id: 0 } },
            errors: [{ formattedMessage: SENTINEL_FILE_CONTENT }],
          },
        },
      ]),
    ).report;
    expect(report.status).toBe('indeterminate');
    if (report.status !== 'indeterminate') {
      throw new Error('unreachable');
    }
    expect(report.reason).toEqual({
      kind: 'build-info-lacks-contract-map',
      file: `${DEFAULT_BUILD_INFO_DIR}/aaa.output.json`,
    });
    expect(sortedOwnKeys(report.reason)).toEqual(['file', 'kind']);
  });

  it('keeps every IndeterminateReason free of a content-bearing field', () => {
    // Structural, so a future fourth field cannot be added quietly. Each reason
    // carries a path plus at most a short cause string, and nothing else.
    const allowed: Readonly<Record<string, readonly string[]>> = {
      'build-info-absent': ['artifactTreeIsExternal', 'buildInfoDirectory', 'kind'],
      'build-info-unreadable': ['cause', 'file', 'kind'],
      'build-info-lacks-contract-map': ['file', 'kind'],
    };
    const seen = new Set<string>();
    for (const reader of [
      filesReader([]),
      throwingReader(new TypeError('boom')),
      filesReader([{ name: 'a.output.json', output: null }]),
    ]) {
      const report = buildArtifactAmbiguityIndex(
        projectPathsFixture(),
        reader,
      ).report;
      if (report.status !== 'indeterminate') {
        throw new Error('expected an indeterminate report');
      }
      seen.add(report.reason.kind);
      expect(sortedOwnKeys(report.reason)).toEqual(allowed[report.reason.kind]);
      for (const leaf of collectLeaves(serializedTree(report.reason))) {
        expect(
          typeof leaf.value === 'string' ? leaf.value.length : 0,
          `${report.reason.kind}.${leaf.path} looks like file content`,
        ).toBeLessThan(200);
      }
    }
    expect([...seen].sort()).toEqual([
      'build-info-absent',
      'build-info-lacks-contract-map',
      'build-info-unreadable',
    ]);
  });

  it('embeds no artifact content in resolvePackaged failure text', () => {
    // The message names the path TronBox read, reproduced from `requireJson`'s own
    // arithmetic, and nothing about what was or was not in the file.
    const shape = migrateShapedHandles({}, { mode: 'null' });
    const env = resolveEnvironment(
      shape.handles,
      { require: ['artifacts'] },
      { buildInfoReader: singleContractReader() },
    );
    const error = caught(() =>
      env.artifacts.resolvePackaged(
        '@openzeppelin/upgrades-core/artifacts/proxy/ERC1967Proxy.json',
      ),
    );
    expect(error).toBeInstanceOf(EnvironmentIncompleteError);
    if (!(error instanceof EnvironmentIncompleteError)) {
      throw new Error('unreachable');
    }
    expect(error.message).toContain(
      '/proj/node_modules/@openzeppelin/upgrades-core/artifacts/proxy/ERC1967Proxy.json',
    );
    expect(error.message).not.toContain(SENTINEL_FILE_CONTENT);
    expect(error.message).not.toContain('0x');
  });

  it('names the type of a candidate field set that a future edit could widen', () => {
    // `ArtifactCandidate` as a compile-time shape: exactly three fields, none of
    // them content-bearing. Assigning an object with a `bytecode` or `abi` member
    // is an excess-property error, which is the enforcement.
    const candidate: ArtifactCandidate = {
      sourcePath: 'contracts/Box.sol',
      contractName: 'Box',
      buildInfoFile: projectPathsFixture().buildInfoDirectory,
    };
    // @ts-expect-error INV-42: ArtifactCandidate has no content-bearing field.
    const widened: ArtifactCandidate = { ...candidate, abi: [] };
    expect(sortedOwnKeys(candidate)).toEqual([
      'buildInfoFile',
      'contractName',
      'sourcePath',
    ]);
    expect(widened.contractName).toBe('Box');
  });
});
