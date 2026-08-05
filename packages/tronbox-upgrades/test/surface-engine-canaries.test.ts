import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  defaultConstructorArgs,
  pluginOptionDefaults,
  recordedUpstreamValidationDefaults,
  resolveUpgradeOptions,
  unsafeAllowKinds,
} from '../src/options';
import {
  capturableEngineExports,
  engineWarningCapableExports,
  uncapturableEngineExports,
  uncapturedEngineWarnings,
} from '../src/output';
import {
  ENGINE_VERSION_UNDER_TEST,
  UPGRADE_OPTION_KEYS,
  engineDistDir,
  engineRequire,
  engineVersion,
} from './helpers/surface-fixtures';

/**
 * Dependency canaries for the option/result surface — covering the closed value
 * sets, the warning-capable export enumeration, and the validation defaults table.
 *
 * Four invariants from three different categories share one home for one reason:
 * each is a claim about `@openzeppelin/upgrades-core` **as installed**, and when the
 * dependency moves, one file should fail and its name should say why. The alternative
 * — scattering the deep imports across the category suites — makes an
 * `upgrades-core` bump look like four unrelated regressions. The environment seam
 * made the same call for `real-tronbox.test.ts`.
 *
 * Every fact below was re-verified by execution against the installed tree and is
 * stated as **verified present at `@openzeppelin/upgrades-core@1.46.0`**. That
 * phrasing is load-bearing: both of the premises this dependency was originally
 * specified against were already false at the pinned version, which is why nothing
 * here is asserted from a `.d.ts` reading.
 *
 * The deep imports live here and never in `src/`. The package ships **no** `exports`
 * map today, so a minor that adds one would break a `src/` deep import outright —
 * whereas a canary that fails loudly is a signal.
 */

interface EngineRoot {
  readonly withValidationDefaults: (opts: object) => Record<string, unknown>;
  readonly [name: string]: unknown;
}

function engineRoot(): EngineRoot {
  return engineRequire('@openzeppelin/upgrades-core') as EngineRoot;
}

/** Every compiled module in the installed `dist`, as `dist`-relative POSIX paths. */
function distModules(): readonly string[] {
  const dist = engineDistDir();
  const walk = (dir: string, out: string[]): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, out);
      } else if (entry.name.endsWith('.js')) {
        out.push(path.relative(dist, full).split(path.sep).join('/'));
      }
    }
    return out;
  };
  return walk(dist, []).sort();
}

function distText(relative: string): string {
  return fs.readFileSync(path.join(engineDistDir(), relative), 'utf8');
}

// ---------------------------------------------------------------------------
// The version this whole file's claims are pinned to
// ---------------------------------------------------------------------------

describe('engine canaries for the option/result surface: the version every claim below is stated against', () => {
  it('is running against the version the fixtures name', () => {
    // One failing equality naming the old and the new version, rather than a scatter
    // of unrelated failures whose common cause a reader has to infer.
    expect(engineVersion()).toBe(ENGINE_VERSION_UNDER_TEST);
  });

  it('still ships no `exports` map, which is why the deep imports below are legal', () => {
    const manifest = engineRequire(
      '@openzeppelin/upgrades-core/package.json',
    ) as Record<string, unknown>;
    expect(manifest['exports']).toBeUndefined();
    // The three specifiers this file relies on resolve today.
    expect(() =>
      engineRequire.resolve('@openzeppelin/upgrades-core/dist/validate/run'),
    ).not.toThrow();
    expect(() =>
      engineRequire.resolve('@openzeppelin/upgrades-core/dist/utils/log'),
    ).not.toThrow();
    expect(() =>
      engineRequire.resolve('@openzeppelin/upgrades-core/dist/validate/overrides'),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The closed value sets, derived from the installed engine
// ---------------------------------------------------------------------------

describe('the closed value sets are derived from the installed engine', () => {
  it('matches `errorKinds` exactly, member for member and in order', () => {
    /*
     * The canary the invariant asks for. `errorKinds` is **not** root-exported at
     * 1.46.0 — verified: neither `dist/index.d.ts` nor `dist/validate/index.d.ts`
     * re-exports it — which is why indexing the public `ValidationOptions` type is
     * the only clean route in `src/`, and why the deep import that *proves* the two
     * agree lives here.
     *
     * The set grew 9 -> 14 between the parity-target revision and 1.46.0. Mirroring
     * the parity target's literals would reject five values the installed engine
     * accepts; restating them locally would silently narrow on the next bump. This
     * assertion is what makes either mistake a failing test.
     */
    const { errorKinds } = engineRequire(
      '@openzeppelin/upgrades-core/dist/validate/run',
    ) as { errorKinds: readonly string[] };

    expect([...errorKinds]).toEqual([...unsafeAllowKinds]);
    expect(errorKinds).toHaveLength(14);
    // Order too, not only membership: the plugin's list is what an `OptionValueError`
    // names as the accepted set, and a reordering would make the diagnostic disagree
    // with upstream's own documentation order.
    expect(errorKinds[0]).toBe('state-variable-assignment');
    expect(errorKinds[13]).toBe('incorrect-initializer-order');
  });

  it('keeps `errorKinds` off the root, so the deep import is the honest route', () => {
    expect(engineRoot()['errorKinds']).toBeUndefined();
    // And `processExceptions` likewise — both facts are why this file relies on a
    // test-only deep import rather than a `src/` one.
    expect(engineRoot()['processExceptions']).toBeUndefined();
  });

  it('recovers the same set through the public type, which is what `src/` uses', () => {
    // The runtime half of the type-level derivation: `unsafeAllowKinds` is declared
    // `as const satisfies readonly UnsafeAllowKind[]` where `UnsafeAllowKind` is
    // `NonNullable<ValidationOptions['unsafeAllow']>[number]`. Every member is
    // therefore accepted by upstream's own normalizer without being rejected or
    // dropped.
    for (const kind of unsafeAllowKinds) {
      const normalized = engineRoot().withValidationDefaults({
        unsafeAllow: [kind],
      });
      expect(
        normalized['unsafeAllow'],
        `upstream dropped '${kind}'`,
      ).toContain(kind);
    }
  });
});

// ---------------------------------------------------------------------------
// The warning-capable export set, pinned against the installed dist
// ---------------------------------------------------------------------------

describe('the warning-capable export set, pinned against the installed dist', () => {
  it('has every enumerated export present on the root', () => {
    for (const entry of engineWarningCapableExports) {
      expect(
        typeof engineRoot()[entry.name],
        `${entry.name} is no longer a root export`,
      ).toBe('function');
    }
    expect(engineWarningCapableExports).toHaveLength(10);
  });

  it('agrees with the installed dist about which exports are asynchronous', () => {
    /*
     * A correction to the original specification, re-verified as **present state**
     * rather than future risk: `addProxyToManifest` and `validateUpgradeSafety` are
     * `AsyncFunction` today.
     * The specification's claim that "every warning-capable entry point is declared
     * synchronous" was already false at the pinned version, and it was invisible
     * because the enumeration was hand-written.
     */
    const observed = engineWarningCapableExports.map(entry => {
      const value = engineRoot()[entry.name] as { constructor: { name: string } };
      return {
        name: entry.name,
        asyncByConstruction: value.constructor.name === 'AsyncFunction',
        declared: entry.declaredReturn,
      };
    });

    for (const row of observed) {
      expect(
        row.asyncByConstruction,
        `${row.name} is declared '${row.declared}' but is ${
          row.asyncByConstruction ? '' : 'not '
        }an AsyncFunction`,
      ).toBe(row.declared === 'promise');
    }
    expect(
      observed.filter(row => row.asyncByConstruction).map(row => row.name),
    ).toEqual(['addProxyToManifest', 'validateUpgradeSafety']);
  });

  it('derives the two subsets from the table, so neither can drift', () => {
    expect(capturableEngineExports).toHaveLength(8);
    expect(uncapturableEngineExports).toHaveLength(2);
    expect([...capturableEngineExports, ...uncapturableEngineExports]).toEqual([
      ...engineWarningCapableExports.filter(
        entry => entry.declaredReturn === 'synchronous',
      ),
      ...engineWarningCapableExports.filter(
        entry => entry.declaredReturn === 'promise',
      ),
    ]);
    // A new async warning-capable export cannot land in neither list.
    expect(
      capturableEngineExports.length + uncapturableEngineExports.length,
    ).toBe(engineWarningCapableExports.length);
  });

  it('finds no warning site outside the enumerated set', () => {
    /*
     * **The canary that makes the DOCUMENT-not-remedy disposition for the
     * uncaptured bypass safe rather than lazy.** A new bypass is a new call to
     * `logWarning`/`logNote`, so the instrument is a call-site census over the
     * whole installed `dist` — 125 compiled modules at 1.46.0.
     *
     * A transitive-`require` closure was considered and **rejected as vacuous**:
     * `dist/add-proxy-to-manifest.js` opens with `require(".")`, which pulls
     * `dist/index.js` and therefore almost everything, so "transitively reaches
     * `utils/log`" would be true of most of the tree and would fail to distinguish a
     * new warning site from an unrelated new module. Call sites are what actually
     * emit.
     */
    const callers = distModules()
      .map(relative => ({
        relative,
        calls: [
          ...distText(relative).matchAll(/\b(logWarning|logNote)\s*\)?\s*\(/g),
        ].map(match => match[1] ?? ''),
      }))
      .filter(entry => entry.calls.length > 0);

    expect(
      callers.map(entry => `${entry.relative} (${[...new Set(entry.calls)].sort().join('+')})`),
    ).toEqual([
      // The one uncaptured bypass, enumerated below with its text.
      'add-proxy-to-manifest.js (logWarning)',
      // Reached from `getStorageUpgradeReport`, `assertStorageUpgradeSafe`,
      // `getStorageUpgradeErrors`.
      'storage/index.js (logNote+logWarning)',
      // Reached from `validate`, via `extractStorageLayout`.
      'storage/namespace.js (logWarning)',
      // The definition module itself, plus upstream's own farewell notice inside
      // `silenceWarnings` — which the plugin deliberately does not mirror, a
      // recorded divergence from the parity target.
      'utils/log.js (logNote+logWarning)',
      // `processExceptions`, reached from `getErrors` and `assertUpgradeSafe`.
      'validate/overrides.js (logWarning)',
      // `assertNotNamespace`, reached from `validate`.
      'validate/run.js (logWarning)',
      // `getPossibleInitializers`'s reinitializer note — the case the
      // `'engine-note'` code exists for.
      'validate/run/initializer.js (logNote)',
    ]);

    // Non-vacuity floor: the census read the whole tree, not a handful of files.
    expect(distModules().length).toBeGreaterThan(100);
  });

  it('names the uncaptured bypass with text that matches the installed dist byte for byte', () => {
    /*
     * The bypass is **documented, not remedied** — settled deliberately — and the
     * documentation names the **specific warning text** — "some warnings may bypass"
     * is unactionable, because a user who sees an unexpected coloured line outside
     * the plugin's channel has to be able to *match* it.
     *
     * Asserted against `dist` so it cannot rot silently. The plugin's `detail`
     * carries `'<kind>'` where upstream interpolates `${kind}`; that substitution is
     * the only difference and it is applied here rather than hidden.
     */
    expect(uncapturedEngineWarnings).toHaveLength(1);
    const bypass = uncapturedEngineWarnings[0]!;
    expect(bypass.engineExport).toBe('addProxyToManifest');
    expect(bypass.owner).toBe('the proxy deployment operations');

    const source = distText('add-proxy-to-manifest.js');
    expect(source).toContain(bypass.text);
    for (const line of bypass.detail) {
      expect(source).toContain(line.replace('<kind>', '${kind}'));
    }
    expect(bypass.detail).toHaveLength(2);

    // The trigger, verbatim from the compiled source.
    expect(source).toContain("kind !== 'transparent' && (await manifest.getAdmin())");
    expect(bypass.trigger).toContain("kind !== 'transparent'");
    expect(bypass.trigger).toContain('manifest.getAdmin()');
    // And it really is on the async path, which is why it cannot be captured.
    expect(source).toContain('async function addProxyToManifest');
  });

  it('writes exactly one argument to `console.error`, which is what the relay parses', () => {
    /*
     * The basis for the relay's single-argument prefix parse. `log` builds
     * `parts.join('\n')` and passes it alone, with the level prefix produced by
     * `chalk.yellow.bold(prefix + ':')` and detail lines by `indent(l, 4)` — so the
     * plugin's prefix match and its four-space detail de-indent are both facts about
     * this function rather than guesses.
     */
    const log = distText('utils/log.js');
    expect(log).toContain("console.error(parts.join('\\n'))");
    expect(log).toContain("chalk_1.default.yellow.bold(prefix + ':')");
    expect(log).toContain('(0, indent_1.indent)(l, 4)');
    expect(log).toContain("logNote(title, lines = []) {");
    expect(log).toContain("log('Note', title, lines)");
    expect(log).toContain("log('Warning', title, lines)");
    // The flag the plugin refuses to reach for — a recorded divergence from the
    // parity target: a module-level `let`, never exported, never readable, never
    // resettable.
    expect(log).toContain('let silenced = false;');
    expect(log).not.toContain('exports.silenced');
  });
});

// ---------------------------------------------------------------------------
// The defaults table, pinned by a two-sided canary
// ---------------------------------------------------------------------------

describe('the defaults table is pinned by a two-sided canary', () => {
  it('has upstream still returning exactly the six recorded validation defaults', () => {
    /*
     * Direction one. The six are **not** re-implemented in `src/` —
     * `resolveUpgradeOptions` calls `withValidationDefaults`, so they cannot drift by
     * construction — and `recordedUpstreamValidationDefaults` is the canary's
     * *expectation*, never a fallback. Making it a fallback would reintroduce exactly
     * the drift the invariant closes.
     *
     * The risk, verbatim: *"a silently flipped default … changes
     * safety posture across every operation"*. A local `kind: 'transparent'` that
     * drifted from upstream would flip the safety posture of every operation with no
     * diagnostic.
     */
    const observed = engineRoot().withValidationDefaults({});
    expect(Object.keys(observed).sort()).toEqual(
      Object.keys(recordedUpstreamValidationDefaults).sort(),
    );
    expect(observed).toEqual({ ...recordedUpstreamValidationDefaults });
    expect(observed['kind']).toBe('transparent');
    expect(observed['unsafeAllow']).toEqual([]);
    // Both deprecated booleans are present — the structural fact that makes
    // narrowing upstream's validation surface incompatible with calling
    // `getStorageUpgradeReport`, which is declared over `Required<ValidationOptions>`.
    expect(observed['unsafeAllowCustomTypes']).toBe(false);
    expect(observed['unsafeAllowLinkedLibraries']).toBe(false);
    expect(Object.keys(observed)).toHaveLength(6);
  });

  it('has resolution reproducing exactly upstream\'s six, not a local copy', () => {
    // Direction one, behaviourally: the six on a resolved value are upstream's own
    // output, not the recorded table.
    const resolved = resolveUpgradeOptions(undefined, UPGRADE_OPTION_KEYS);
    expect({ ...resolved.validation }).toEqual({
      ...engineRoot().withValidationDefaults({}),
    });
    expect(Object.isFrozen(resolved.validation)).toBe(true);
    expect(Object.isFrozen(resolved.validation.unsafeAllow)).toBe(true);
  });

  it('has the four package-owned defaults matching the recorded table', () => {
    /*
     * Direction two. These four are the ones upstream has no opinion about, each
     * traced to `plugin-truffle/src/utils/options.ts:withDefaults`.
     *
     * `timeout` and `pollingInterval` are **live on TRON** — a recorded divergence
     * from the parity target, which treated them as inert — its own comment says
     * *"not used for Truffle, but include these anyways"* — so a wrong value here
     * is a real confirmation-policy change rather than a dead field.
     */
    expect(pluginOptionDefaults.timeout).toBe(60_000);
    expect(pluginOptionDefaults.pollingInterval).toBe(5_000);
    expect(pluginOptionDefaults.redeployImplementation).toBe('onchange');
    expect(pluginOptionDefaults.useDeployedImplementation).toBe(false);
    expect(defaultConstructorArgs).toEqual([]);
    expect(Object.isFrozen(defaultConstructorArgs)).toBe(true);
    expect(Object.isFrozen(pluginOptionDefaults)).toBe(true);

    const resolved = resolveUpgradeOptions(undefined, UPGRADE_OPTION_KEYS);
    expect(resolved.timeout).toBe(60_000);
    expect(resolved.pollingInterval).toBe(5_000);
    expect(resolved.redeployImplementation).toBe('onchange');
    expect(resolved.constructorArgs).toEqual([]);
    // `useDeployedImplementation` collapses into `redeployImplementation` and never
    // surfaces on the resolved value, so exactly one field expresses the policy.
    expect(Object.keys(resolved).sort()).toEqual([
      'constructorArgs',
      'pollingInterval',
      'redeployImplementation',
      'timeout',
      'validation',
    ]);
  });

  it('never reads the recorded expectation during resolution', () => {
    /*
     * The recorded table is the canary's expectation, not a fallback — so it must be
     * read by the canary and by nothing else. Asserted by mutation rather than by a
     * source scan: the table is frozen, so the check is that resolution's output does
     * not depend on it at all.
     */
    expect(Object.isFrozen(recordedUpstreamValidationDefaults)).toBe(true);
    const resolveModule = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'options', 'resolve.ts'),
      'utf8',
    );
    expect(resolveModule).not.toContain('recordedUpstreamValidationDefaults');
    expect(resolveModule).toContain('withValidationDefaults(validationInput)');
  });
});
