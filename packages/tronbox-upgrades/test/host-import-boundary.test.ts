import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  makeTempDir,
  packageRoot,
  repoRoot,
  srcDir,
  tronBoxIsInstalled,
  tronBoxRoot,
  tronBoxVersionsUnderTest,
} from './helpers/locate';
import {
  allSources,
  callSites,
  environmentSources,
  HOST_SPECIFIER,
  hostImportViolations,
  hostSpecifiers,
  nonEnvironmentSources,
  resolverCallProgram,
  resolverCallSites,
  resolverCallSitesIn,
  scanDirectory,
  scanText,
  type ResolverCallSite,
  type ScannedSource,
} from './helpers/source-scan';

/**
 * The host-import boundary — no module in the plugin imports the host, by
 * any path, anywhere.
 *
 * Critical, and paired with the environment seam's property-path exception
 * rather than folded into it: that exception permits `src/environment/**` to
 * read a TronBox-internal *property path*, while this boundary permits
 * **nothing** to name the host as a *module*. Two exception structures, two
 * enforcement mechanisms, so two invariants rather than one folded pair — and
 * that same split is why this file exists beside `trust-boundary.test.ts`'s
 * property-path block instead of inside it.
 *
 * **Why the invariant is necessary rather than tidy.** `tronbox/package.json`
 * declares no `main`, no `exports` and only a `bin`. The absent `main` is why
 * `require('tronbox')` fails; the absent `exports` map is why *every file in the
 * published tree stays addressable* — an `exports` map is what closes a package, so
 * its absence is the opposite of a promise that internals will stay reachable.
 * `require('tronbox/package.json')` and
 * `require('tronbox/build/components/TronWrap')` both resolve. The boundary is
 * therefore defeatable by subpath, which is exactly what makes a stated invariant
 * with a regression test worth more than the earlier belief that the host was
 * unimportable.
 *
 * **The scan is AST-level, and that is now mandatory rather than preferable.** The
 * corrected `errors.ts:declaredTronBoxRange` comment quotes
 * `require.resolve('tronbox')` and `require('tronbox/package.json')` verbatim while
 * explaining why the seam does *not* do that, so a grep-based scan returns two
 * false positives in the one file whose comment documents the hazard. The negative
 * fixture below is that file itself, asserted against both scans, because a guard
 * that fires on the comment explaining it gets reverted by the first person it
 * fires on.
 *
 * This holds today with **no source change** — the invariant was adopted at the one
 * moment it is free. So every case here is a *regression* guard, and the fixtures
 * are what keep it from being a test that would pass against a deleted scan.
 */

const installedVersions = tronBoxVersionsUnderTest.filter(tronBoxIsInstalled);

/**
 * A crude text scan for a host specifier — the implementation this suite is
 * deliberately *not* using, kept executable so the comparison is a measurement
 * rather than a claim.
 */
function grepHostSpecifierLines(text: string): readonly number[] {
  const pattern = /['"]tronbox(?:['"]|\/)/;
  return text
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(entry => pattern.test(entry.line))
    .map(entry => entry.number);
}

/**
 * Every non-relative specifier under `src/`, one entry per module-and-specifier.
 *
 * Hoisted out of the pin below because four independent properties read it, and
 * they now live in four `it()` blocks rather than one — see the pin's own note on
 * why.
 */
function externalSpecifiers(): readonly string[] {
  return allSources().flatMap(source =>
    source.moduleSpecifiers
      .filter(entry => !entry.specifier.startsWith('.'))
      .map(entry => `${source.relative}: ${entry.specifier} (${entry.kind})`),
  );
}

/**
 * A resolver call rendered for an equality assertion: where it is, what it is
 * invoked through, and what the **checker** says each argument is.
 *
 * Deliberately carries no line number. The value of this row is that it is stable
 * across every edit that does not change a resolver's reach — a line number would
 * make it churn on any surrounding edit and train the next reader to update
 * the expectation without reading it.
 */
function renderResolverCall(site: ResolverCallSite): string {
  const args = site.args
    .map(argument => `${argument.text}: ${argument.type}`)
    .join(', ');
  return `${site.relative}: ${site.callee}(${args})`;
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe('no module in the plugin imports the host, by any path', () => {
  it('finds no host specifier anywhere under src/, seam included', () => {
    // The invariant, stated over its actual subject. `allSources()` is every `.ts`
    // under `src/` with no exception carved out — unlike the property-path
    // exception's scan, which is over `nonEnvironmentSources()` because the
    // seam is its permitted exception. Getting that difference wrong is the
    // single most likely way for this test to look right and prove nothing.
    const violations = hostImportViolations(allSources());
    expect(violations, 'a module under src/ names the TronBox host').toEqual([]);
  });

  it('enumerates every non-relative specifier under src/, so the set is pinned rather than filtered', () => {
    // Stronger than the absence above and cheaper to keep honest: an allow-list of
    // what the plugin may depend on at all. A future host import would fail the
    // test above, but so would a future `viem` or `axios` fail this one — and a
    // dependency added without being noticed is how the first host import
    // eventually arrives.
    //
    // Counted per *module* rather than per occurrence, because the occurrence count
    // is the part nobody can keep right by hand: two separate hand-written records
    // both put `node:path` at ×2, while the tree has three importers
    // (`ambiguity.ts`, `artifacts.ts`, `paths.ts`). Nothing load-bearing moves — the
    // claim this boundary rests on is *zero host imports*, and that is exact — but
    // the incidental count was off by one in two places at once, which is the
    // argument for pinning it here instead of in prose.
    //
    // **This block used to hold four independent assertions and now holds one.**
    // The three that followed the pin — the `node:fs` count, the type-only engine
    // pin and the outward-specifier pin — were unreachable for as long as the pin
    // failed, and they were unreachable in exactly the change that mattered: the
    // validation ladder's directory added five specifiers, the pin failed on all
    // five, and the `node:fs`
    // count silently stopped being evaluated on the very commit that gave it a
    // second importer. A predicate that cannot run is the limit case of a predicate
    // evaluated in the wrong mode, so each is now its own `it()`.
    expect([...externalSpecifiers()].sort()).toEqual([
      // Added by the chain layer, and additive: one row, nothing removed and
      // nothing loosened. Legitimate on two grounds. **It is not the host** —
      // this boundary's target is TronBox, and `@openzeppelin/upgrades-core` is
      // the validation engine, a declared runtime dependency already pinned
      // twice below for `src/options/**`. And the chain layer's own directory
      // rule names it explicitly: `src/chain/**` may import
      // `src/environment/**` and `upgrades-core` **types** only. This row is a
      // single type-only import of `EthereumProvider`, which is what lets
      // `ChainAccess.provider` be declared as the engine's own interface so
      // none of the chain layer's six consumers writes a cast — see
      // `src/chain/index.ts:asEngineProvider`. It is the only external
      // specifier in the whole directory: `policy.ts`, `classify.ts` and
      // `slots.ts` import nothing at all.
      `chain${path.sep}index.ts: @openzeppelin/upgrades-core (import)`,
      `environment${path.sep}ambiguity.ts: node:fs (import)`,
      `environment${path.sep}ambiguity.ts: node:path (import)`,
      `environment${path.sep}artifacts.ts: node:path (import)`,
      `environment${path.sep}paths.ts: node:path (import)`,
      // Added by the option/result surface. These two rows are also read off
      // the same directory-rule scan: `src/options/**` may import
      // `@openzeppelin/upgrades-core` and nothing else, while `src/output/**`
      // imports nothing at all and `src/results/**` imports only `../output`
      // and the shared `../host-sharing` leaf — so any non-relative specifier
      // appearing under `output/` or `results/` here is a violation of the
      // option/result surface's leaf property, not merely a new dependency.
      // The engine is a declared runtime dependency of this package.
      `options${path.sep}resolve.ts: @openzeppelin/upgrades-core (import)`,
      `options${path.sep}types.ts: @openzeppelin/upgrades-core (import)`,
      // Added by the proxy operations — three rows, additive. The operation
      // toolkit reaches the engine strictly behind a dynamic import (the
      // entry-closure guard proves the deferral, and the types-only census
      // below records the row as the second sanctioned runtime route beside
      // record/manifest.ts). `ethers` is static on purpose: it is the same
      // runtime peer the record layer already carries, and a constructed
      // require here would have violated the createRequire ban below — which
      // now has zero exemptions — measured, when this suite refused exactly
      // that shape on the toolkit's first run.
      `proxy${path.sep}toolkit.ts: @openzeppelin/upgrades-core (dynamic-import)`,
      `proxy${path.sep}toolkit.ts: ethers (import)`,
      `proxy${path.sep}upgrade-proxy.ts: ethers (import)`,
      // Added by the record layer — ten rows, additive, nothing removed and
      // nothing loosened. Read as a directory rule, the way the option/result
      // surface's and validation ladder's rows are:
      //
      // - **`tronweb` and `ethers` in `address.ts` are the whole directory's only
      //   third-party imports, and they are in the one module that must not import
      //   anything else.** Neither is the host: `tronweb` is the TRON SDK whose
      //   `utils.address` namespace is *static*, usable with no instance and no node,
      //   which is the property that lets address canonicalization be tested with 200
      //   fixtures and no network. That module imports `./errors`, which imports
      //   nothing at all, so its whole closure inside the package is these two
      //   packages and nothing more. **That transitive claim is not asserted anywhere
      //   yet** — the record layer owns it, as a closure walk from `record/address.ts`
      //   asserting the only non-relative specifiers reached are `tronweb` and
      //   `ethers`. Until it exists, these two rows record what the module imports
      //   and nothing pins what `./errors` may grow to import.
      // - **`@openzeppelin/upgrades-core` appears twice in `manifest.ts`, in two
      //   kinds, and the pair is the invariant rather than an accident.** The
      //   type-only row is erased; the `dynamic-import` row is the deferred value
      //   import, and it has to be deferred: the engine reads the deployment record's
      //   directory from the environment **once, at module load**, so a *static*
      //   runtime import of it anywhere in the entry module's closure freezes that
      //   directory before the plugin can set it, and the plugin's own assignment
      //   becomes a silent no-op. A future edit turning that `await import(…)` into a
      //   top-level `import` changes this row from `(dynamic-import)` to `(import)`
      //   and fails here, which is the only place that edit is cheap to catch.
      // - `@openzeppelin/upgrades-core` in `types.ts`, `reconcile.ts` and
      //   `session.ts` is **type-only** in all three — pinned as such in the
      //   type-only block below — because a record wrapper's whole job is to be typed
      //   over the engine's own `ManifestData` / `ImplDeployment` / `ProxyDeployment`
      //   so that a field rename upstream is a compile error here.
      // - `node:path` in `location.ts` and `sidecar.ts` is path arithmetic over the
      //   record's anchor, and `node:fs/promises` in `sidecar.ts` is the fingerprint
      //   file's atomic write and defensive read. `node:fs/promises` is a distinct
      //   specifier from the `node:fs` the seam and the validation ladder use, and
      //   the seam-scoped `node:fs` assertion below is prefixed by `environment/`,
      //   so it is unaffected.
      `record${path.sep}address.ts: ethers (import)`,
      `record${path.sep}address.ts: tronweb (import)`,
      `record${path.sep}location.ts: node:path (import)`,
      `record${path.sep}manifest.ts: @openzeppelin/upgrades-core (dynamic-import)`,
      `record${path.sep}manifest.ts: @openzeppelin/upgrades-core (import)`,
      `record${path.sep}reconcile.ts: @openzeppelin/upgrades-core (import)`,
      `record${path.sep}session.ts: @openzeppelin/upgrades-core (import)`,
      `record${path.sep}sidecar.ts: node:fs/promises (import)`,
      `record${path.sep}sidecar.ts: node:path (import)`,
      `record${path.sep}types.ts: @openzeppelin/upgrades-core (import)`,
      // The validation pipeline's rows — read as a directory rule the way the
      // option/result surface's rows are. Two rows this list used to carry are
      // gone with the embedded compiler (the Foundry-model decision,
      // 2026-08-07), and their absence is load-bearing: `node:module` in
      // `validation-input/compiler.ts` was the package's ONE `createRequire`
      // exemption, and `node:os` in `pipeline.ts` was its one ambient-machine
      // read (the `~/.tronbox` cache's home directory). Neither has a reason
      // to exist in a pipeline that never loads a compiler, so the ban on the
      // require-constructing primitive below is back to universal — zero
      // exemptions — and this pin is what keeps either row from returning
      // unnoticed.
      //
      // - **`node:fs` in `pipeline.ts` is the second importer in the package**, and
      //   the assertion that used to count them lives in its own block below,
      //   scoped to the seam it was written about.
      // - `node:path` in `import-graph.ts` and `source-key.ts` is the
      //   validation pipeline's own path arithmetic; `@openzeppelin/upgrades-core`
      //   in `identity.ts` and
      //   `solc-input.ts` is the validation engine, a declared runtime dependency,
      //   and the type-only/runtime split of both is pinned below.
      `validation-input${path.sep}identity.ts: @openzeppelin/upgrades-core (import)`,
      `validation-input${path.sep}import-graph.ts: node:path (import)`,
      `validation-input${path.sep}pipeline.ts: node:fs (import)`,
      `validation-input${path.sep}solc-input.ts: @openzeppelin/upgrades-core (import)`,
      `validation-input${path.sep}source-key.ts: node:path (import)`,
    ]);
  });

  it('imports node:fs in exactly one module of the seam', () => {
    // **Rewritten by the validation ladder, and the rewrite is a narrowing.**
    // The assertion was `toHaveLength(1)` over *all* of `src/`, while its own
    // comment tied it to the seam's filesystem-access enumeration and the
    // directory-rule scan — both of which are claims about
    // `src/environment/**`: the filesystem-access enumeration lists the
    // seam's filesystem access, and the directory-rule scan's own test is
    // titled "no fs outside ambiguity.ts" and ranges over
    // `environmentSources()`. So the subject was wider than the invariant, and
    // the package now genuinely has two importers: the seam's reader and
    // `validation-input/pipeline.ts`, which owns the validation ladder's
    // `existsSync` / `readFileSync` defaults. Counting them together would
    // have forced either a false claim about the seam or a relaxation of a
    // live invariant.
    //
    // Named rather than counted, which is the stronger form and the one the
    // seam's own directory-rule scan uses
    // (`test/performance-and-reuse.test.ts:141-146`): a count of one passes if
    // the importer moves, and the importer's identity is the property.
    const seamImporters = externalSpecifiers().filter(
      entry =>
        entry.startsWith(`environment${path.sep}`) &&
        entry.includes('node:fs'),
    );
    expect(seamImporters).toEqual([
      `environment${path.sep}ambiguity.ts: node:fs (import)`,
    ]);

    // And the wider fact, stated rather than asserted as a bound: outside the seam
    // the importers are enumerated by the pin above, so this block does not need a
    // second list. What it does need is proof that the filter is not vacuous — a
    // typo in the directory prefix would report zero importers as one.
    expect(
      externalSpecifiers().filter(entry => entry.includes('node:fs')).length,
    ).toBeGreaterThan(seamImporters.length);
  });

  it('imports upgrades-core as types only everywhere the directory rules require it', () => {
    // **Added by the chain layer, closing a hole in the pin above.** The
    // `(import)` label is produced from `entry.kind`, which does not
    // distinguish a **type-only** import from a runtime one — so the
    // `chain/index.ts` row, added by the chain layer precisely *because* the
    // import is type-only, would equally have admitted a future value import
    // of `@openzeppelin/upgrades-core` from that module without tripping
    // anything. The chain layer's own directory rule forbids exactly that:
    // `src/chain/**` may import `src/environment/**` and upgrades-core
    // **types** only.
    //
    // Both halves of the fix are in place, and the scan is the one that changed:
    // `ModuleSpecifier` now carries `typeOnly` (handling `import type`, the inline
    // `{ type X }` form, and namespace/default bindings), and this assertion reads it.
    // The parallel per-directory assertion lives in
    // `test/chain-absence-scans.test.ts` → "imports upgrades-core as TYPES ONLY".
    const engineImports = allSources().flatMap(source =>
      source.moduleSpecifiers
        .filter(entry => entry.specifier === '@openzeppelin/upgrades-core')
        .map(
          entry =>
            `${source.relative}: ${entry.specifier} (${entry.kind}, ${
              entry.typeOnly ? 'type-only' : 'runtime'
            })`,
        ),
    );
    expect([...engineImports].sort()).toEqual([
      // Type-only, and that is what the chain layer's directory rule requires
      // of this directory.
      `chain${path.sep}index.ts: @openzeppelin/upgrades-core (import, type-only)`,
      // **`options/resolve.ts` was the whole package's only *runtime* import of the
      // engine, and the validation ladder made it two.** The original wording
      // is corrected rather than kept: it was measured — the first draft
      // expected both option/result-surface rows to be runtime and the scan
      // corrected it to one — but the validation ladder's `identity.ts` now
      // calls `extractLinkReferences` and `unlinkBytecode` as values, so "a single
      // row is what a dependency-weight question turns on" has stopped being true.
      // A measured claim that has since been overtaken is exactly the kind that gets
      // quoted onward, so it is fixed here instead of annotated.
      `options${path.sep}resolve.ts: @openzeppelin/upgrades-core (import, runtime)`,
      `options${path.sep}types.ts: @openzeppelin/upgrades-core (import, type-only)`,
      // Added by the proxy operations: the operation toolkit's engine access,
      // and the second sanctioned `dynamic-import, runtime` row beside
      // record/manifest.ts — deferred for the same load-order reason, and
      // proven deferred by test/entry-point-closure.test.ts, which recomputes
      // the entry module's static value-closure from disk on every run.
      `proxy${path.sep}toolkit.ts: @openzeppelin/upgrades-core (dynamic-import, runtime)`,
      // Added by the record layer, and this block is where the record layer's
      // load-order rule is actually enforced rather than described. The engine's
      // manifest module evaluates the deployment record's directory from the
      // environment **once, at module load**; every row here that reads
      // `type-only` is a row that cannot load it, and the single `runtime` row is
      // deferred to a point after the plugin has configured that directory. So the
      // shape of this list *is* the invariant: four type-only rows plus exactly
      // one runtime row, and that runtime row spelled `dynamic-import`. A
      // top-level `import { Manifest }` in `manifest.ts` would still be one
      // runtime row — it would read `(import, runtime)`, and that is the
      // difference this pin exists to catch.
      `record${path.sep}manifest.ts: @openzeppelin/upgrades-core (dynamic-import, runtime)`,
      `record${path.sep}manifest.ts: @openzeppelin/upgrades-core (import, type-only)`,
      `record${path.sep}reconcile.ts: @openzeppelin/upgrades-core (import, type-only)`,
      `record${path.sep}session.ts: @openzeppelin/upgrades-core (import, type-only)`,
      `record${path.sep}types.ts: @openzeppelin/upgrades-core (import, type-only)`,
      // Added by the validation ladder. `identity.ts` is a **runtime** importer
      // and has to be: the bytecode-normalisation invariant requires upstream's
      // own `unlinkBytecode`, and reproducing it locally is what that invariant
      // exists to forbid. `solc-input.ts` is type-only — it aliases upstream's
      // `SolcOutput` so a produced record is assignable at the consumer boundary
      // by construction.
      `validation-input${path.sep}identity.ts: @openzeppelin/upgrades-core (import, runtime)`,
      `validation-input${path.sep}solc-input.ts: @openzeppelin/upgrades-core (import, type-only)`,
    ]);
  });

  it('leaves the seam by only one relative specifier, the plugin manifest', () => {
    // The one relative specifier that leaves its own directory, named rather
    // than lumped in with the intra-directory imports: the declared-range
    // invariant's single home for the declared range is a *static* JSON
    // import, which is why the seam's filesystem-access enumeration needs no
    // filesystem carve-out for it.
    //
    // `../..` and not `..`, deliberately: the validation ladder's modules
    // import `../environment`, which is the seam's face and the supported
    // direction. What this catches is a module reaching *out of the
    // package's own `src/`* — the shape a "just read the installed host's
    // manifest" edit would take.
    const outward = allSources().flatMap(source =>
      source.moduleSpecifiers
        .filter(entry => entry.specifier.startsWith('../..'))
        .map(entry => `${source.relative}: ${entry.specifier}`),
    );
    expect(outward).toEqual([
      `environment${path.sep}errors.ts: ../../package.json`,
    ]);
  });

  it('leaves no computed specifier for the static scan to miss', () => {
    // The completeness clause, and the reason the scan is a proof rather than a
    // best effort: `require(name)` with a computed `name` is invisible to any
    // static analysis, so zero host specifiers only means something alongside zero
    // dynamic sites. Without this case the invariant could be defeated by one
    // variable.
    for (const source of allSources()) {
      expect(
        source.dynamicSpecifierSites.map(
          site => `${source.relative}:${site.line} ${site.kind}(${site.expression})`,
        ),
        `${source.relative} computes a module specifier`,
      ).toEqual([]);
    }
  });

  it('names no require-constructing primitive anywhere under src/', () => {
    /*
     * The second half of completeness — **a universal ban again, with the
     * history of its one exemption kept because the exemption's removal is
     * load-bearing.**
     *
     * **The ban's reason, corrected once and still true.** `createRequire`
     * hands back a resolver rooted wherever the caller likes, and a call
     * through the *constructed* resolver is invisible to both the specifier
     * pin and the dynamic-site check — whether its argument is a literal or a
     * variable (`recordSpecifierArgument` fires only for a callee spelled
     * literally `require`, `require.resolve` or `import`; fixture A in the
     * non-vacuity block below measures this rather than arguing it). So the
     * property this boundary actually protects is **no module under `src/`
     * can reach the host by a path the specifier scan cannot see**, and
     * forbidding the primitive is a sound, cheap proxy for it while nothing
     * legitimate needs the primitive.
     *
     * **For one span of this repository's history, something legitimate did.**
     * `src/validation-input/compiler.ts` loaded an emscripten
     * `soljson_v<version>.js` out of the user's own `~/.tronbox` cache, and
     * this block carried a one-file exemption paid for by two compensating
     * clause blocks bounding where that constructed require could point. The
     * Foundry-model decision (2026-08-07) deleted the embedded compiler —
     * validation reads the host's build record and never loads solc — so the
     * exemption lost its subject and the ban is universal again. What remains
     * of the compensating machinery is the type-checked sweep below
     * ("sees no constructed require anywhere under src/"), kept because it
     * catches the two shapes this identifier sweep cannot (a resolver under
     * another name, and one constructed and invoked inline).
     *
     * `test/real-tronbox.test.ts` uses `createRequire` deliberately and is not
     * a subject: this boundary ranges over the plugin, and the test suite
     * reaching into an installed host tree is how the host's facts get
     * pinned at all.
     */
    const forbidden = /^(createRequire|_load|_resolveFilename)$/;
    const namers = allSources().flatMap(source => {
      const named = [
        ...new Set(
          source.identifiers
            .filter(use => !use.inTypePosition)
            .map(use => use.name)
            .filter(name => forbidden.test(name)),
        ),
      ].sort();
      return named.length === 0
        ? []
        : [`${source.relative}: ${named.join(', ')}`];
    });

    expect(namers).toEqual([]);
  });

  it('sees no constructed require anywhere under src/, read off the type-checker', () => {
    /*
     * **The type-checked half of the ban, kept from the exemption era because
     * it catches what the identifier sweep cannot.**
     *
     * The identifier sweep above matches the primitive by *name*, which two
     * shapes defeat: a resolver bound under any other name, and one
     * constructed and invoked inline with no binding at all — both measured
     * in "clause 6 fires on …" below. `resolverCallSites()` asks the checker
     * instead: *which* values under `src/` are `createRequire` products —
     * derived from the construction site rather than matched by name, so a
     * rename, a hand-off to a helper and an inline
     * `createRequire(__filename)(…)` all stay in range. Same mechanism and
     * same `ts.Program` as the type-checked interpolation scan's
     * `typedInterpolations()`.
     *
     * The expectation was one row while the embedded compiler's loader held
     * the package's single exemption; with the Foundry model it is the empty
     * set, and the fixtures below are what keep an empty answer evidence of
     * absence rather than of a scan that stopped seeing.
     */
    expect(
      resolverCallSites().map(renderResolverCall),
      'a constructed require exists under src/ — the createRequire ban has no ' +
        'exemptions any more, so whatever this row names has to go',
    ).toEqual([]);
  });

  it('fires on a constructed require that points anywhere but the parameter', () => {
    // Non-vacuity for the ban's reason. Both fixtures are text
    // rather than files, for the reason the violating fixtures below are: a real
    // module under `src/` would violate the invariant it exists to test.

    // A · The host, reached by a constructed require with a literal specifier. The
    //     measurement the whole ban rests on: the specifier pin and the
    //     dynamic-site check both report **nothing**, which is precisely why the
    //     primitive is forbidden rather than merely its host-shaped uses.
    const literalTarget = scanText(
      [
        "import { createRequire } from 'node:module';",
        'const runtimeRequire = createRequire(__filename);',
        "export const host: unknown = runtimeRequire('tronbox/package.json');",
      ].join('\n'),
      'fixtures/constructed-host.ts',
    );
    expect(
      hostSpecifiers(literalTarget),
      'the specifier pin caught a constructed require after all — re-read the ' +
        'ban rationale before weakening it',
    ).toEqual([]);
    expect(
      literalTarget.dynamicSpecifierSites,
      'the dynamic-site check caught a constructed require after all',
    ).toEqual([]);
    // Clause 2 fires.
    expect(
      callSites([literalTarget], 'runtimeRequire').map(site => site.args),
    ).toEqual([["'tronbox/package.json'"]]);
    // And the host-literal sweep sees it independently — the layering is real.
    expect(
      literalTarget.stringLiterals.filter(literal =>
        HOST_SPECIFIER.test(literal),
      ),
    ).toEqual(['tronbox/package.json']);

    // B · A computed specifier — the case no specifier scan can see. A literal
    //     sweep has nothing to catch here, so the ban on the primitive is the
    //     only thing standing between this shape and the invariant.
    const computedTarget = scanText(
      [
        "import { createRequire } from 'node:module';",
        'const runtimeRequire = createRequire(__filename);',
        'export const load = (name: string): unknown => runtimeRequire(name);',
      ].join('\n'),
      'fixtures/constructed-computed.ts',
    );
    expect(hostSpecifiers(computedTarget)).toEqual([]);
    expect(computedTarget.dynamicSpecifierSites).toEqual([]);
    expect(
      computedTarget.stringLiterals.filter(literal =>
        HOST_SPECIFIER.test(literal),
      ),
      'a literal sweep cannot see a computed target, which is why the ban exists',
    ).toEqual([]);
    expect(
      callSites([computedTarget], 'runtimeRequire').map(site => site.args),
    ).toEqual([['name']]);
  });

  // -------------------------------------------------------------------------
  // Non-vacuity for the type-checked resolver sweep
  // -------------------------------------------------------------------------

  /**
   * The shapes the type-checked sweep exists for, one fixture each.
   *
   * An instrument whose live expectation is the empty set has to be shown
   * non-vacuous, or an empty answer is indistinguishable from a scan that
   * stopped seeing. Two of these four defeat the identifier sweep while a
   * name-based call-site match reports nothing; the other two
   * measure the claim that the resolver is identified **by type rather than by
   * name**, which is what makes the first two catchable at all.
   *
   * Hermetic on purpose — the fixtures declare the resolver shape they need, so
   * nothing depends on `@types/node`'s spelling of `NodeRequire` and the mechanism
   * under test is the type identity, not the name.
   */
  const RESOLVER_FIXTURE_PREAMBLE = [
    'declare const __filename: string;',
    'declare function createRequire(filename: string): (id: string) => unknown;',
    'declare function hostName(): string;',
    "type AbsolutePath = string & { readonly __brand: 'absolute' };",
  ].join('\n');

  const resolverFixtures: readonly {
    readonly label: string;
    readonly name: string;
    readonly body: readonly string[];
    readonly rows: readonly string[];
    /** Where the argument's brand is declared, `undefined` for an unbranded type. */
    readonly declaredIn: string | undefined;
  }[] = [
    {
      // The residual the type-checked sweep closes: the signature looks like the
      // old loader's, the argument is spelled like a branded parameter, and the
      // resolver still points anywhere.
      label: 'a parameter shadowed at type string',
      name: 'shadowed.ts',
      body: [
        'export function loadCompiler(soljsonPath: AbsolutePath): unknown {',
        '  const runtimeRequire = createRequire(__filename);',
        '  const reach = (soljsonPath: string): unknown => runtimeRequire(soljsonPath);',
        '  return reach(hostName());',
        '}',
      ],
      rows: ['shadowed.ts: runtimeRequire(soljsonPath: string)'],
      declaredIn: undefined,
    },
    {
      // Why the sweep reads the declaration site: this row is shape-identical to the
      // real one, and the brand admits every string.
      label: 'a same-named brand declared locally',
      name: 'local-brand.ts',
      body: [
        'export function loadCompiler(target: AbsolutePath): unknown {',
        '  const runtimeRequire = createRequire(__filename);',
        '  return runtimeRequire(target);',
        '}',
      ],
      rows: ['local-brand.ts: runtimeRequire(target: AbsolutePath)'],
      declaredIn: 'local-brand.ts',
    },
    {
      // The resolver is not found by its name — a name-based call-site match
      // (`callSites([…], 'runtimeRequire')`) reports nothing here.
      label: 'a resolver binding under any other name',
      name: 'renamed.ts',
      body: [
        'export function load(): unknown {',
        '  const anythingAtAll = createRequire(__filename);',
        '  return anythingAtAll(hostName());',
        '}',
      ],
      rows: ['renamed.ts: anythingAtAll(hostName(): string)'],
      declaredIn: undefined,
    },
    {
      // No binding at all, so there is no name to match and no `const` line for a
      // `toContain` to pin.
      label: 'a resolver constructed and invoked inline',
      name: 'inline.ts',
      body: ['export const host: unknown = createRequire(__filename)(hostName());'],
      rows: ['inline.ts: createRequire(__filename)(hostName(): string)'],
      declaredIn: undefined,
    },
  ];

  it.each(resolverFixtures)(
    'the type-checked sweep fires on $label',
    ({ label, name, body, rows, declaredIn }) => {
      const fixtureRoot = path.join(packageRoot, 'fixtures');
      const text = [RESOLVER_FIXTURE_PREAMBLE, ...body, ''].join('\n');
      const sites = resolverCallSitesIn(
        resolverCallProgram([{ name, text }], fixtureRoot),
        fixtureRoot,
      );

      expect(sites.map(renderResolverCall), label).toEqual(rows);
      expect(sites[0]?.args[0]?.typeDeclaredIn, label).toBe(declaredIn);

      // And each produces a non-empty answer, which is what makes the live
      // sweep's empty set evidence of absence: an instrument that reported []
      // on these four shapes would report [] on everything.
      expect(sites.length, `${label} produced no row at all`).toBeGreaterThan(0);
    },
  );

  it('a name-based match cannot see two of the four shapes the sweep catches', () => {
    // The layering, measured. `callSites` matches a callee by *name*, so a resolver
    // under any other name — or none — is invisible to it no matter what it is
    // invoked with. This is the same kind of measurement fixtures A and B above make
    // for the specifier pin, applied to the name-based match itself.
    for (const { name, body } of resolverFixtures.slice(2)) {
      const scanned = scanText(
        [RESOLVER_FIXTURE_PREAMBLE, ...body, ''].join('\n'),
        `fixtures/${name}`,
      );
      expect(
        callSites([scanned], 'runtimeRequire'),
        `${name} was caught by a name-based match after all, which would make ` +
          'the type-checked sweep redundant for this shape — re-read before deleting',
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Non-vacuity: the scan must fail on a real violation
// ---------------------------------------------------------------------------

describe('the scan fires on a genuine host import', () => {
  /**
   * Every syntax that names a module, one fixture each.
   *
   * Text rather than files on disk: `tsconfig.test.json` includes `src` and `test`,
   * so a fixture that genuinely imports the host would fail type-checking (the bare
   * name resolves to nothing), and a fixture under `src/` would violate the
   * invariant it exists to test. Parsing text keeps each violation next to the
   * assertion that catches it.
   */
  const violatingFixtures: readonly {
    readonly label: string;
    readonly kind: string;
    readonly text: string;
  }[] = [
    {
      label: 'static import',
      kind: 'import',
      text: "import TronWrap from 'tronbox/build/components/TronWrap';\nexport default TronWrap;\n",
    },
    {
      label: 'type-only import',
      kind: 'import',
      text: "import type { Config } from 'tronbox/build/components/Config';\nexport type C = Config;\n",
    },
    {
      label: 're-export',
      kind: 'export-from',
      text: "export { default } from 'tronbox/build/components/Config';\n",
    },
    {
      label: 'import-equals',
      kind: 'import-equals',
      text: "import host = require('tronbox/package.json');\nexport const version = host.version;\n",
    },
    {
      label: 'bare require',
      kind: 'require',
      text: "export const version = require('tronbox/package.json').version;\n",
    },
    {
      label: 'require.resolve',
      kind: 'require-resolve',
      text: "export const where = require.resolve('tronbox/package.json');\n",
    },
    {
      label: 'dynamic import',
      kind: 'dynamic-import',
      text: "export const load = () => import('tronbox/build/components/Config');\n",
    },
    {
      label: 'version-aliased install name',
      kind: 'import',
      text: "import manifest from 'tronbox-4.9.0/package.json';\nexport default manifest;\n",
    },
    {
      label: 'future @tronbox scope',
      kind: 'import',
      text: "import { Config } from '@tronbox/core';\nexport { Config };\n",
    },
  ];

  it.each(violatingFixtures)(
    'fails the scan for a $label ($kind)',
    ({ label, kind, text }) => {
      const scanned = scanText(text, `fixtures/violation-${kind}.ts`);
      const found = hostSpecifiers(scanned);
      expect(found.map(entry => entry.kind), label).toEqual([kind]);
      expect(hostImportViolations([scanned])).toHaveLength(1);
      expect(hostImportViolations([scanned])[0]).toContain(kind);
    },
  );

  it('covers every specifier syntax the scanner can classify', () => {
    // A fixture list that drifts behind the scanner is a non-vacuity proof with a
    // hole in it: a newly handled syntax with no fixture is a syntax nobody has
    // watched fail. Pinned as a set equality in both directions.
    expect([...new Set(violatingFixtures.map(entry => entry.kind))].sort()).toEqual([
      'dynamic-import',
      'export-from',
      'import',
      'import-equals',
      'require',
      'require-resolve',
    ]);
  });

  it('fires when the violation is a real module in a real directory, not a string', () => {
    // The gap the text fixtures above cannot close, and the one that matters most:
    // they prove `hostSpecifiers` classifies correctly, not that the scan is
    // *wired* to a directory. A `scanDirectory` that silently listed no files, or a
    // `listTypeScriptFiles` that stopped recursing, would pass every case above and
    // report `[]` for `src/` forever.
    //
    // So: copy the seam to a temp tree, add one violating module in a subdirectory,
    // and run the same `scanDirectory` → `hostImportViolations` pipeline the
    // property test uses.
    const root = makeTempDir('inv49');
    const nested = path.join(root, 'environment');
    // Copies the whole of `src/` rather than a hand-enumerated directory list.
    // The list was `src/*.ts` plus `src/environment/*.ts`, which stopped being a
    // copy of the tree the moment the option/result surface added `options/`,
    // `output/` and `results/` — and the clean-tree assertion below compares
    // this copy's file count against the real tree's, so a fixture that
    // misses a directory reads as a scan that failed to recurse. Rewritten
    // for the option/result surface; the property under test is unchanged,
    // and the injected violation below still lands in a subdirectory.
    fs.cpSync(srcDir, root, {
      recursive: true,
      filter: source =>
        fs.statSync(source).isDirectory() || source.endsWith('.ts'),
    });

    // Clean first: the copy of a passing tree must still pass, or the failure below
    // proves nothing about the injected module.
    const clean = scanDirectory(root, root);
    expect(clean.length).toBe(allSources().length);
    expect(hostImportViolations(clean)).toEqual([]);

    // Nested rather than at the root, so a scan that failed to recurse would be
    // caught here rather than passing by luck.
    fs.writeFileSync(
      path.join(nested, 'version.ts'),
      "import manifest from 'tronbox/package.json';\n" +
        'export const hostVersion: string = manifest.version;\n',
      'utf8',
    );
    const violations = hostImportViolations(scanDirectory(root, root));
    expect(violations).toEqual([
      `environment${path.sep}version.ts:1 imports the host as ` +
        "'tronbox/package.json' (import)",
    ]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not fire on the plugin\'s own package name', () => {
    // The near miss, and the reason `HOST_SPECIFIER` is not `/tronbox/`. The plugin
    // is `tronbox-upgrades`; a pattern that matched it would fire for the wrong
    // reason and be loosened rather than fixed.
    const scanned = scanText(
      "import { resolveEnvironment } from 'tronbox-upgrades';\n" +
        "import sibling from 'tronbox-upgrades/environment';\n" +
        'export { resolveEnvironment, sibling };\n',
      'fixtures/own-package.ts',
    );
    expect(scanned.moduleSpecifiers).toHaveLength(2);
    expect(hostSpecifiers(scanned)).toEqual([]);
    expect(HOST_SPECIFIER.test('tronbox-upgrades')).toBe(false);
    expect(HOST_SPECIFIER.test('tronbox')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The negative fixture: a host mention in a comment must pass
// ---------------------------------------------------------------------------

describe('a host mentioned in a comment only passes the scan', () => {
  function errorsSource(): ScannedSource {
    const source = environmentSources().find(
      entry => entry.relative === 'errors.ts',
    );
    if (source === undefined) {
      throw new Error('errors.ts is missing from the seam');
    }
    return source;
  }

  it('passes a synthetic comment-only mention that a grep would fail', () => {
    // The synthetic half, stated first because it isolates the mechanism: identical
    // host text, once as prose and once as a specifier.
    const commentOnly = scanText(
      [
        '/**',
        " * The version is not read: `require.resolve('tronbox')` fails with",
        " * MODULE_NOT_FOUND, and `require('tronbox/package.json')` would resolve —",
        ' * which is exactly why this boundary forbids reaching for it.',
        ' */',
        "export const declaredRange = '^4.8.0';",
      ].join('\n'),
      'fixtures/comment-only.ts',
    );
    expect(hostSpecifiers(commentOnly), 'a comment is not an import').toEqual([]);
    expect(commentOnly.moduleSpecifiers).toEqual([]);

    // And the grep the AST scan replaces does fail it, which is the whole argument.
    expect(grepHostSpecifierLines(commentOnly.text)).toEqual([2, 3]);
  });

  it('passes the real errors.ts, whose comment is the actual trap', () => {
    // The fixture that matters: not a synthetic file but the module the
    // implementation rewrote. If this ever fails, the scan has regressed to text
    // matching and the next maintainer will delete it rather than fix it.
    const errors = errorsSource();
    expect(errors.text).toContain("require.resolve('tronbox')");
    expect(errors.text).toContain("require('tronbox/package.json')");
    expect(grepHostSpecifierLines(errors.text).length).toBeGreaterThanOrEqual(2);

    expect(hostSpecifiers(errors)).toEqual([]);
    expect(
      errors.moduleSpecifiers
        .map(entry => entry.specifier)
        .filter(specifier => !/^\.\/\w/.test(specifier)),
      'errors.ts reaches outside the seam for something other than the manifest',
    ).toEqual(['../../package.json']);
  });

  it('reads the declared range from the plugin manifest, never from the host', () => {
    // The declared-range invariant's mechanism, asserted from the host-import
    // boundary's side. The one home for the
    // declared range is `peerDependencies.tronbox` in *this* package's manifest,
    // reached by a static JSON import — so there is a legitimate reason to want a
    // version string here, and it is already satisfied without naming the host.
    // That is what makes the invariant costless rather than merely adopted.
    const errors = errorsSource();
    expect(errors.stringLiterals).not.toContain('tronbox');
    // `accessChains` records every prefix of a chain, so the longest one is the read
    // and the shorter entries are its own intermediate nodes.
    expect(
      errors.accessChains.filter(chain => /peerDependencies/.test(chain)),
    ).toContain('packageJson.peerDependencies.tronbox');
    expect(
      errors.accessChains.filter(chain => /peerDependencies\.\w+$/.test(chain)),
      'the manifest is read for exactly one dependency name',
    ).toEqual(['packageJson.peerDependencies.tronbox']);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as { peerDependencies?: Record<string, string> };
    expect(typeof manifest.peerDependencies?.tronbox).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// The host-side premise, verified against the installed trees
// ---------------------------------------------------------------------------

describe.skipIf(installedVersions.length === 0)(
  'the host really is importable by subpath, which is why the invariant is needed',
  () => {
    it.each(installedVersions)(
      'resolves subpaths and refuses the bare name on %s',
      installName => {
        // The host-side premise is verified here by execution rather than carried
        // as a written note. The earlier premise — "a version string is unavailable
        // in principle" — was withdrawn on exactly this evidence, and a withdrawn
        // premise nobody re-checks is how the invariant would quietly become
        // unnecessary-looking again.
        //
        // Verified present at v4.8.0 and v4.9.0.
        const require_ = createRequire(path.join(repoRoot, 'package.json'));

        expect(() => require_.resolve(installName)).toThrow(
          /Cannot find module/,
        );
        expect(require_.resolve(`${installName}/package.json`)).toBe(
          path.join(tronBoxRoot(installName), 'package.json'),
        );
        expect(() =>
          require_.resolve(`${installName}/build/components/TronWrap`),
        ).not.toThrow();

        // The mechanism, so the fact is not just an observation: no `main` and no
        // root `index.js` is why the bare name fails, and the **absent `exports`
        // map** is why the subpaths stay open. An `exports` map is what closes a
        // package; its absence is the opposite of a promise.
        const manifest = JSON.parse(
          fs.readFileSync(
            path.join(tronBoxRoot(installName), 'package.json'),
            'utf8',
          ),
        ) as { main?: string; exports?: unknown; bin?: Record<string, string> };
        expect(manifest.main).toBeUndefined();
        expect(manifest.exports).toBeUndefined();
        expect(Object.keys(manifest.bin ?? {})).toEqual(['tronbox']);
        expect(
          fs.existsSync(path.join(tronBoxRoot(installName), 'index.js')),
        ).toBe(false);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Hand-off to packaging
// ---------------------------------------------------------------------------

describe('packaging inherits a two-clause boundary check, not one item', () => {
  it('ranges over a strictly larger subject than the property-path exception does', () => {
    // The property-path exception's subject is `src/` *minus* the seam,
    // because the seam is its permitted exception; this boundary's is `src/`
    // entire, because it has none. The two scans therefore cannot share a
    // subject, which is the concrete form of *neither subsumes the other* —
    // and the thing most likely to be lost when packaging mechanizes both as
    // "the boundary check".
    expect(srcDir.endsWith(path.join('tronbox-upgrades', 'src'))).toBe(true);

    // Compared by absolute path, not by `relative`. The three helpers are rooted
    // differently — `environmentSources()` at the seam directory, the other two at
    // `src/` — so `src/index.ts` and `src/environment/index.ts` share the relative
    // name `index.ts`. A partition check written against `relative` would report an
    // overlap that does not exist, and the obvious "fix" for that phantom overlap is
    // to weaken the check.
    const inv49 = allSources().map(source => source.file);
    const inv28 = nonEnvironmentSources().map(source => source.file);
    const seam = environmentSources().map(source => source.file);

    // Partition, asserted rather than assumed: every module is in exactly one
    // of the property-path exception's subject and the seam, and this
    // boundary covers the union.
    expect(inv28.filter(file => seam.includes(file))).toEqual([]);
    expect([...inv49].sort()).toEqual([...inv28, ...seam].sort());
    expect(inv49.length).toBeGreaterThan(inv28.length);
    expect(seam.length).toBeGreaterThan(0);

    expect(seam).toContain(path.join(srcDir, 'environment', 'errors.ts'));
    expect(inv28).toContain(path.join(srcDir, 'index.ts'));
    expect(seam).toContain(path.join(srcDir, 'environment', 'index.ts'));
  });
});
