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
 * INV-49 — no module in the plugin imports the host, by any path, anywhere.
 *
 * Critical, and paired with INV-28 rather than folded into it: INV-28 permits
 * `src/environment/**` to read a TronBox-internal *property path*, while INV-49
 * permits **nothing** to name the host as a *module*. Two exception structures, two
 * enforcement mechanisms, so two invariants rather than one folded pair — and that
 * same split is why this file exists beside `trust-boundary.test.ts`'s INV-28 block
 * instead of inside it.
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
 * The one module INV-49's `createRequire` ban exempts, resolved rather than
 * hand-written, so a rename fails loudly instead of leaving the compensating
 * assertions ranging over `undefined`.
 */
const PERMITTED_LOADER = path.join('validation-input', 'compiler.ts');

/**
 * A resolver call rendered for an equality assertion: where it is, what it is
 * invoked through, and what the **checker** says each argument is.
 *
 * Deliberately carries no line number. The value of this row is that it is stable
 * across every edit that does not change the resolver's reach — a line number would
 * make it churn on any edit above `loadCompiler` and train the next reader to update
 * the expectation without reading it.
 */
function renderResolverCall(site: ResolverCallSite): string {
  const args = site.args
    .map(argument => `${argument.text}: ${argument.type}`)
    .join(', ');
  return `${site.relative}: ${site.callee}(${args})`;
}

function loaderSource(): ScannedSource {
  const found = allSources().find(
    source => source.relative === PERMITTED_LOADER,
  );
  if (found === undefined) {
    throw new Error(
      `${PERMITTED_LOADER} is missing: INV-49's one createRequire exemption has ` +
        'no subject, so the assertions bounding it would be vacuous.',
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe('INV-49: no module in the plugin imports the host, by any path', () => {
  it('finds no host specifier anywhere under src/, seam included', () => {
    // The invariant, stated over its actual subject. `allSources()` is every `.ts`
    // under `src/` with no exception carved out — unlike INV-28's scan, which is
    // over `nonEnvironmentSources()` because the seam is INV-28's permitted
    // exception. Getting that difference wrong is the single most likely way for
    // this test to look right and prove nothing.
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
    // claim INV-49 rests on is *zero host imports*, and that is exact — but the
    // incidental count was off by one in two places at once, which is the argument
    // for pinning it here instead of in prose.
    //
    // **This block used to hold four independent assertions and now holds one.**
    // The three that followed the pin — the `node:fs` count, the type-only engine
    // pin and the outward-specifier pin — were unreachable for as long as the pin
    // failed, and they were unreachable in exactly the change that mattered: SF-2's
    // directory added five specifiers, the pin failed on all five, and the `node:fs`
    // count silently stopped being evaluated on the very commit that gave it a
    // second importer. A predicate that cannot run is the limit case of a predicate
    // evaluated in the wrong mode, so each is now its own `it()`.
    expect([...externalSpecifiers()].sort()).toEqual([
      // Added by SF-1 Code Draft, and additive: one row, nothing removed and
      // nothing loosened. Legitimate on two grounds. **It is not the host** —
      // INV-49's boundary is TronBox, and `@openzeppelin/upgrades-core` is the
      // validation engine, a declared runtime dependency already pinned twice
      // below for `src/options/**`. And SF-1's own INV-48 names it explicitly:
      // `src/chain/**` may import `src/environment/**` and `upgrades-core`
      // **types** only. This row is a single type-only import of
      // `EthereumProvider`, which is what lets `ChainAccess.provider` be declared
      // as the engine's own interface so none of SF-1's six consumers writes a
      // cast — see `src/chain/index.ts:asEngineProvider`. It is the only external
      // specifier in the whole directory: `policy.ts`, `classify.ts` and
      // `slots.ts` import nothing at all (INV-45).
      `chain${path.sep}index.ts: @openzeppelin/upgrades-core (import)`,
      `environment${path.sep}ambiguity.ts: node:fs (import)`,
      `environment${path.sep}ambiguity.ts: node:path (import)`,
      `environment${path.sep}artifacts.ts: node:path (import)`,
      `environment${path.sep}paths.ts: node:path (import)`,
      // Added by SF-2 Code Draft, and the row is the *reason* SF-2's own
      // `node:module` row below is safe. `soljson-path.ts` is where the seam took
      // ownership of the host's `~/.tronbox/{solc,evm-solc}/soljson_v<version>.js`
      // convention, and `node:path` is all it needs: the home directory arrives as an
      // argument, because `node:os` is forbidden seam-wide
      // (`test/performance-and-reuse.test.ts:129-130`, `:684-687`) and INV-44 makes
      // the seam a function of its arguments alone (`:441`). What it returns is an
      // `AbsolutePath`, and INV-2's brand is what the loader's clause 3 below reads
      // as provenance.
      `environment${path.sep}soljson-path.ts: node:path (import)`,
      // Added by SF-10 Code Draft. These two rows are also SF-10 INV-43's
      // directory rule read off the same scan: `src/options/**` may import
      // `@openzeppelin/upgrades-core` and nothing else, while `src/output/**`
      // imports nothing at all and `src/results/**` imports only `../output` —
      // so any non-relative specifier appearing under `output/` or `results/`
      // here is a violation of SF-10's leaf property, not merely a new
      // dependency. The engine is a declared runtime dependency of this package.
      `options${path.sep}resolve.ts: @openzeppelin/upgrades-core (import)`,
      `options${path.sep}types.ts: @openzeppelin/upgrades-core (import)`,
      // Added by SF-2 Code Draft — seven rows, additive, nothing removed and
      // nothing loosened. Read as a directory rule the way the SF-10 rows are:
      //
      // - **`node:module` in `validation-input/compiler.ts` is the whole package's
      //   only one, and it is the `createRequire` exemption's other half.** The ban
      //   on the primitive is amended for that file alone; the two blocks that pay for
      //   the amendment are titled, each on one line so a grep finds it:
      //
      //   "bounds where the one permitted constructed require can point"
      //   "bounds the type of what the one permitted constructed require is invoked with"
      //
      //   This row is what makes the amendment auditable from the import side, because
      //   a second module reaching for `node:module` fails here whether or not it
      //   names `createRequire`.
      // - **`node:os` in `pipeline.ts` is the only ambient-machine read in SF-2**,
      //   and it sits in the module that already owns the directory's injectable
      //   host surface (`exists`, `readSource`, `loadCompiler`). It is *not* in the
      //   seam and must not move there: `test/performance-and-reuse.test.ts:129-130`
      //   names `os` in INV-43's forbidden list and `:684-687` excludes it from
      //   INV-47's permitted set. `src/environment/soljson-path.ts` owns the
      //   `~/.tronbox` convention and takes the home directory as an argument for
      //   exactly that reason.
      // - **`node:fs` in `pipeline.ts` is the second importer in the package**, and
      //   the assertion that used to count them lives in its own block below,
      //   scoped to the seam it was written about.
      // - `node:path` in `import-graph.ts` and `source-key.ts` is SF-2's INV-6
      //   arithmetic; `@openzeppelin/upgrades-core` in `identity.ts` and
      //   `solc-input.ts` is the validation engine, a declared runtime dependency,
      //   and the type-only/runtime split of both is pinned below.
      `validation-input${path.sep}compiler.ts: node:module (import)`,
      `validation-input${path.sep}identity.ts: @openzeppelin/upgrades-core (import)`,
      `validation-input${path.sep}import-graph.ts: node:path (import)`,
      `validation-input${path.sep}pipeline.ts: node:fs (import)`,
      `validation-input${path.sep}pipeline.ts: node:os (import)`,
      `validation-input${path.sep}solc-input.ts: @openzeppelin/upgrades-core (import)`,
      `validation-input${path.sep}source-key.ts: node:path (import)`,
    ]);
  });

  it('imports node:fs in exactly one module of the seam', () => {
    // **Rewritten by SF-2 Code Draft, and the rewrite is a narrowing.** The
    // assertion was `toHaveLength(1)` over *all* of `src/`, while its own comment
    // tied it to INV-31 and INV-43 — both of which are claims about
    // `src/environment/**`: INV-31 enumerates the seam's filesystem access,
    // INV-43's own test is titled "no fs outside ambiguity.ts" and ranges over
    // `environmentSources()`. So the subject was wider than the invariant, and the
    // package now genuinely has two importers: the seam's reader and
    // `validation-input/pipeline.ts`, which owns SF-2's `existsSync` / `readFileSync`
    // defaults. Counting them together would have forced either a false claim about
    // the seam or a relaxation of a live invariant.
    //
    // Named rather than counted, which is the stronger form and the one the seam's
    // own INV-43 test uses (`test/performance-and-reuse.test.ts:141-146`): a count of
    // one passes if the importer moves, and the importer's identity is the property.
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
    // **Added by SF-1 Tests, closing a hole in the pin above.** The `(import)` label
    // is produced from `entry.kind`, which does not distinguish a **type-only**
    // import from a runtime one — so the `chain/index.ts` row, added by SF-1 Code
    // Draft precisely *because* the import is type-only, would equally have admitted
    // a future value import of `@openzeppelin/upgrades-core` from that module without
    // tripping anything. SF-1's INV-48 forbids exactly that: `src/chain/**` may
    // import `src/environment/**` and upgrades-core **types** only.
    //
    // Both halves of the fix are in place, and the scan is the one that changed:
    // `ModuleSpecifier` now carries `typeOnly` (handling `import type`, the inline
    // `{ type X }` form, and namespace/default bindings), and this assertion reads it.
    // The parallel per-directory assertion lives in
    // `test/sf-1-absence-scans.test.ts` → "imports upgrades-core as TYPES ONLY".
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
      // Type-only, and that is what INV-48 requires of this directory.
      `chain${path.sep}index.ts: @openzeppelin/upgrades-core (import, type-only)`,
      // **`options/resolve.ts` was the whole package's only *runtime* import of the
      // engine, and SF-2 made it two.** The original wording is corrected rather
      // than kept: it was measured — the first draft expected both SF-10 rows to be
      // runtime and the scan corrected it to one — but SF-2's `identity.ts` now
      // calls `extractLinkReferences` and `unlinkBytecode` as values, so "a single
      // row is what a dependency-weight question turns on" has stopped being true.
      // A measured claim that has since been overtaken is exactly the kind that gets
      // quoted onward, so it is fixed here instead of annotated.
      `options${path.sep}resolve.ts: @openzeppelin/upgrades-core (import, runtime)`,
      `options${path.sep}types.ts: @openzeppelin/upgrades-core (import, type-only)`,
      // Added by SF-2 Code Draft. `identity.ts` is a **runtime** importer and has to
      // be: INV-34's normalisation is upstream's own `unlinkBytecode`, and
      // reproducing it locally is what that invariant exists to forbid.
      // `solc-input.ts` is type-only — it aliases upstream's `SolcOutput` so a
      // produced record is assignable at the consumer boundary by construction.
      `validation-input${path.sep}identity.ts: @openzeppelin/upgrades-core (import, runtime)`,
      `validation-input${path.sep}solc-input.ts: @openzeppelin/upgrades-core (import, type-only)`,
    ]);
  });

  it('leaves the seam by only one relative specifier, the plugin manifest', () => {
    // The one relative specifier that leaves its own directory, named rather than
    // lumped in with the intra-directory imports: INV-19's single home for the
    // declared range is a *static* JSON import, which is why INV-31 needs no
    // filesystem carve-out for it.
    //
    // `../..` and not `..`, deliberately: SF-2's modules import `../environment`,
    // which is the seam's face and the supported direction. What this catches is a
    // module reaching *out of the package's own `src/`* — the shape a "just read the
    // installed host's manifest" edit would take.
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

  it('names no require-constructing primitive under src/, outside the one loader that pays for it', () => {
    /*
     * The second half of completeness, **amended by SF-2 Code Draft for exactly one
     * file, and instrumented rather than merely excused.**
     *
     * **The original ban's stated reason, with one correction it earned.**
     * `createRequire` hands back a resolver rooted wherever the caller likes. The ban
     * claimed that `module.createRequire(…)('tronbox/…')` *is* caught by the specifier
     * pin above and that only `createRequire(…)(someName)` escapes it. **That was
     * wrong, and fixture A in the non-vacuity block below measures it wrong rather
     * than arguing it:** `recordSpecifierArgument` fires only for a callee spelled
     * literally `require`, `require.resolve` or `import`, so a call through the
     * *constructed* resolver is invisible to both the specifier pin and the
     * dynamic-site check — whether its argument is a literal or a variable. Both
     * halves of the hazard were outside the scan, not one, which makes the ban more
     * load-bearing than its own comment claimed and the assertions replacing it
     * correspondingly more so.
     *
     * So the property INV-49 actually protects is **no module under `src/` can reach
     * the host by a path the specifier scan cannot see**, and forbidding the primitive
     * was a *proxy* for it: sound, cheap, and sound only while nothing legitimate
     * needed the primitive.
     *
     * **Something legitimate now does.** `src/validation-input/compiler.ts` loads an
     * emscripten `soljson_v<version>.js` out of the user's own `~/.tronbox` cache.
     * There is no other route: the file is CommonJS, it is named at runtime, and the
     * host's own resolution has three `process.exit(1)` sites, so calling the host is
     * both forbidden by this invariant and fatal to the user's process. And the need
     * will not age out — `_inputs/decisions-10.md` reclassifies the compile path as
     * the **fallback** under a lazy ladder (compile when the host's build record is
     * stale or absent, or when AST-only refuses on a shape that needs slot data), so
     * the loader stays reachable rather than becoming dead code.
     *
     * **So the instrument is remade to measure the property instead of the proxy.**
     * An allow-list entry on its own would be a *weakening*: for the exempted file
     * the old ban's protection drops to exactly zero, and the ban has caught real
     * leaks. The blocks below therefore give the exempted file positive assertions
     * about **where its constructed require can point**, which the ban never provided
     * for any file — one over the parse, one over the type-checker, and a non-vacuity
     * block for each:
     *
     * "bounds where the one permitted constructed require can point"
     * "bounds the type of what the one permitted constructed require is invoked with"
     *
     * Outside that file the ban is unchanged — and pinned as an *equality* rather than
     * a filter, so a second exemption fails here instead of being absorbed.
     *
     * **The parse-level half is not sufficient on its own, and that is measured.**
     * `AbsolutePath` on the loader's parameter binds its *callers*; inside the body the
     * resolver is a general CommonJS resolver, so a nested binding shadowing the
     * parameter at type `string` satisfies every text and identifier pin while erasing
     * the brand. The type-checked block is what refuses it, and it is the only
     * assertion in this file that does.
     *
     * **This follows INV-28's `_json` precedent, three days old.** That guard was a
     * pattern over forbidden access chains; `_json` was added to it and, in the same
     * pass, `test/trust-boundary.test.ts:443-500` recorded why the pattern could
     * *not* simply be widened to `bytecode` / `source` / `sourcePath` — those are
     * member names on the record the seam legitimately hands out, so a wider pattern
     * would forbid the supported path along with the unsupported one. The answer
     * there was to scope the instrument to where the hazard is and add a second,
     * name-based clause (`ContractHandle`, `:477`). Same move here: the primitive is
     * not the hazard, an unbounded *target* is.
     *
     * `test/real-tronbox.test.ts` uses `createRequire` deliberately and is not a
     * subject: INV-49 ranges over the plugin, and the test suite reaching into an
     * installed host tree is how the host's facts get pinned at all.
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

    // Exactly one row, and it names *which* primitive: `_load` and
    // `_resolveFilename` stay forbidden in the exempted file too. They are
    // `Module`'s private internals, they resolve against a caller-chosen parent, and
    // nothing in the loader needs them — an exemption that admitted them would be
    // wider than the need that bought it.
    expect(namers).toEqual([`${PERMITTED_LOADER}: createRequire`]);
  });

  it('bounds where the one permitted constructed require can point', () => {
    // The compensating half. Each assertion below is something the ban asserted
    // about *no* file, so together they are strictly stronger than the ban they
    // replace — for the exempted file the ban's contribution was zero, and outside it
    // the ban is intact.
    const loader = loaderSource();

    // 1 · Constructed once, and against this module's own file. `__filename` is the
    //     plugin's own location, so the resolver's base is the plugin — not a
    //     directory chosen from a config value, and not the host's tree.
    expect(callSites([loader], 'createRequire').map(site => site.args)).toEqual([
      ['__filename'],
    ]);

    // 2 · The binding invoked is the one `createRequire` produced, and its argument is
    //     *spelled* the loader's own parameter — never a literal, never an expression
    //     built inside the body. This is where the ban's protection starts being
    //     replaced rather than dropped, because `runtimeRequire(x)` is invisible to
    //     both the specifier pin and the dynamic-site check (measured in the
    //     non-vacuity block below).
    //
    //     It does not *finish* the job, and the limit is worth stating precisely:
    //     `callSites` matches a callee by name and reports its arguments as written, so
    //     this clause reasons about spellings. A resolver under another name, or an
    //     argument that is a different binding of the same name, both satisfy it —
    //     clause 6 is what those fail.
    //
    //     The two `toContain`s are exact code text, not prose — the same instrument
    //     this file's "passes the real errors.ts" block already uses on that module's
    //     comment. Cited by name rather than by line because a line number inside the
    //     file that holds it drifts on the next edit. `callSites` matches by callee
    //     name, so tying the name to the construction is what makes the argument pin
    //     mean anything at all.
    expect(loader.text).toContain(
      'const runtimeRequire = createRequire(__filename);',
    );
    expect(
      callSites([loader], 'runtimeRequire').map(site => site.args),
    ).toEqual([['soljsonPath']]);

    // 3 · And the *declared parameter* is a **seam-minted** absolute path. INV-2 makes
    //     `AbsolutePath` mintable only by `assertAbsolutePath` in
    //     `src/environment/paths.ts`, so the type is evidence of provenance: the
    //     value was composed by `src/environment/soljson-path.ts` out of the host's
    //     own `~/.tronbox` convention. A package name, a relative path or any
    //     `string` is a compile error **at the call site** — which is the scope of what
    //     this clause buys, and the scope the comment on `loadCompiler` used to
    //     overstate. `tsc` enforces the signature; this pins that the signature is
    //     still the one `tsc` is enforcing, because the *reason* it matters is
    //     invisible from the signature alone. What the resolver is handed *inside* the
    //     body is clause 6's subject, not this one's.
    expect(loader.text).toContain(
      'export function loadCompiler(soljsonPath: AbsolutePath): CompilerHandle {',
    );
    expect(
      loader.importSpecifiers.filter(specifier => /paths$/.test(specifier)),
      'the loader reaches for the brand minter instead of receiving a branded value',
    ).toEqual([]);

    // 4 · No string literal in the file names the host, in any of the shapes
    //     `HOST_SPECIFIER` covers — bare name, subpath, the version-aliased install
    //     names, a future `@tronbox/*` scope. Anchored, so the module's own refusal
    //     text may still say "TronBox" while nothing may *begin* with it.
    expect(
      loader.stringLiterals.filter(literal => HOST_SPECIFIER.test(literal)),
      'the loader holds a literal that names the host',
    ).toEqual([]);

    // 5 · And no literal other than the module's own import specifiers is
    //     path-shaped, so there is no fragment of a filesystem path in the file to
    //     assemble a specifier out of — `.tronbox/solc/…` included, which clause 4
    //     does not reach because it does not start with the host's name.
    const ownSpecifiers = new Set(
      loader.moduleSpecifiers.map(entry => entry.specifier),
    );
    expect(
      loader.stringLiterals.filter(
        literal => !ownSpecifiers.has(literal) && /[\\/~]/.test(literal),
      ),
      'the loader holds a path-shaped literal that is not one of its own imports',
    ).toEqual([]);

    // Clause 6 — the same bound read off the **type-checker** rather than the text —
    // is the sibling block below. It is deliberately not the seventh assertion in
    // this one: `expect` throws, so an assertion placed after clause 2 only ever runs
    // when clause 2 passed, and the shapes clause 6 exists for are precisely the ones
    // clause 2 mis-reports. Measured, not assumed — a second call through the
    // resolver aimed at the host makes clause 2 fail first, and clause 6's verdict on
    // the same file was never reached. A compensating clause whose red is conditional
    // on a weaker clause going green is not independently observable, which is the
    // same reason `externalSpecifiers()`' four readers live in four blocks.
  });

  it('bounds the type of what the one permitted constructed require is invoked with', () => {
    /*
     * **Clause 6. The clause that measures the resolver's reach rather than its
     * spelling, and the one the block above cannot express.**
     *
     * Clauses 2 and 3 there are pins on *code text and identifier spelling*, which is
     * weaker than it reads. `AbsolutePath` on `loadCompiler`'s parameter constrains
     * every **caller**; it says nothing about the body, where `runtimeRequire` is a
     * general CommonJS resolver in scope and `runtimeRequire('tronbox/…')`
     * type-checks. So clause 3's `toContain` on the signature is evidence about the
     * call sites and no evidence about the one line that matters, and clause 2 accepts
     * any binding that merely happens to be *spelled* `soljsonPath` — including a
     * nested one shadowing the parameter at type `string`, which was recorded in that
     * block as an uncaught residual. This is that residual being caught instead of
     * documented.
     *
     * `resolverCallSites()` asks the checker two things a parse cannot answer: *which*
     * values under `src/` are `createRequire` products — derived from the construction
     * site rather than matched by name, so a rename, a hand-off to a helper and an
     * inline `createRequire(__filename)(…)` all stay in range — and what the checker's
     * **type** for each argument is at that position. Same mechanism and same
     * `ts.Program` as INV-40's `typedInterpolations()`; the four shapes it catches and
     * clause 2 does not are measured in "clause 6 fires on …" below.
     */
    const resolverCalls = resolverCallSites();

    // One row, over all of `src/` rather than over the exempted file alone: a second
    // module that constructed a resolver would appear here even if it never named
    // `createRequire` in a form the identifier sweep recognises.
    expect(
      resolverCalls.map(renderResolverCall),
      'a constructed require under src/ is invoked somewhere other than the one ' +
        'permitted site, or with something other than a branded absolute path',
    ).toEqual([`${PERMITTED_LOADER}: runtimeRequire(soljsonPath: AbsolutePath)`]);

    // And the type rendered `AbsolutePath` is *the seam's*. `typeToString` renders a
    // name, so a local `type AbsolutePath = string` in the loader would produce a row
    // identical to the one above while admitting every string; the alias's declaration
    // site is what separates the brand from a same-named shim. INV-2 makes the brand
    // mintable only by `assertAbsolutePath`, so the declaring module *is* the
    // provenance claim — and it is `environment/types.ts`, inside the seam.
    const [resolverArgument] = resolverCalls[0]?.args ?? [];
    expect(
      resolverArgument?.isIdentifier,
      'the resolver is invoked with an expression rather than a bound identifier',
    ).toBe(true);
    expect(
      resolverArgument?.typeDeclaredIn,
      "the resolver's argument is branded by something other than the seam's own type",
    ).toBe(path.join('environment', 'types.ts'));

    // **The residual, named rather than implied.** `stringLiterals` does not collect
    // the text parts of a template literal with substitutions, so
    // `` runtimeRequire(`${x}/.tronbox/…`) `` slips past clauses 4 and 5 — clause 2
    // catches it because the argument is not the bare parameter, and clause 6 because
    // a template's type is `string` rather than `AbsolutePath`. What survives both is
    // narrower than the residual this replaces: a value that genuinely carries the
    // brand, which requires `assertAbsolutePath` to have minted it and therefore an
    // absolute filesystem path — not a package specifier at all. Reaching a host
    // *file* by absolute path stays possible in principle, and it is unreachable
    // through this signature unless the seam composes that path; SF-11 inherits it
    // with the rest of the mechanized boundary check. Stated because a compensating
    // instrument whose gaps are unrecorded is how the next amendment gets argued from
    // a false baseline.
  });

  it('fires on a constructed require that points anywhere but the parameter', () => {
    // Non-vacuity for the two clauses that are not `tsc`'s. Both fixtures are text
    // rather than files, for the reason the violating fixtures below are: a real
    // module under `src/` would violate the invariant it exists to test.

    // A · The host, reached by a constructed require with a literal specifier. The
    //     measurement the whole amendment rests on: the specifier pin and the
    //     dynamic-site check both report **nothing**, which is precisely why the ban
    //     existed and precisely why replacing it needs clause 2.
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
      'the specifier pin caught a constructed require after all, which would make ' +
        'clause 2 unnecessary — re-read the amendment before deleting it',
    ).toEqual([]);
    expect(
      literalTarget.dynamicSpecifierSites,
      'the dynamic-site check caught a constructed require after all',
    ).toEqual([]);
    // Clause 2 fires.
    expect(
      callSites([literalTarget], 'runtimeRequire').map(site => site.args),
    ).toEqual([["'tronbox/package.json'"]]);
    // And so does clause 4, independently — the layering is real, not nominal.
    expect(
      literalTarget.stringLiterals.filter(literal =>
        HOST_SPECIFIER.test(literal),
      ),
    ).toEqual(['tronbox/package.json']);

    // B · A computed specifier — the case the original ban's own comment named as
    //     the one no static scan can see. Clause 4 has nothing to catch here, so
    //     clause 2 is the only thing standing between this shape and the invariant.
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
      'clause 4 cannot see a computed target, which is why clause 2 exists',
    ).toEqual([]);
    expect(
      callSites([computedTarget], 'runtimeRequire').map(site => site.args),
    ).toEqual([['name']]);

    // And the instrument agrees with the real module, which is the half a pair of
    // synthetic fixtures cannot give: the argument the loader actually passes is the
    // parameter, and the two fixtures above are the two ways it could stop being.
    expect(
      callSites([loaderSource()], 'runtimeRequire').map(site => site.args),
    ).toEqual([['soljsonPath']]);
  });

  // -------------------------------------------------------------------------
  // Non-vacuity for clause 6
  // -------------------------------------------------------------------------

  /**
   * The shapes clause 6 exists for, one fixture each.
   *
   * A compensating assertion that has never been seen to fail is not evidence of
   * anything, and clause 6 is the compensating half of an *exemption* — so its
   * non-vacuity is not optional. Two of these four defeat clauses 2 and 3 while
   * satisfying them, which is the whole reason clause 6 was added; the other two
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
      // The residual clause 6 closes. The signature is the loader's, the argument is
      // spelled exactly what clause 2 pins, and the resolver still points anywhere.
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
      // Why clause 6b reads the declaration site: this row is shape-identical to the
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
      // The resolver is not found by its name — `callSites([…], 'runtimeRequire')`,
      // which clause 2 uses, reports nothing here.
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
    'clause 6 fires on $label',
    ({ label, name, body, rows, declaredIn }) => {
      const fixtureRoot = path.join(packageRoot, 'fixtures');
      const text = [RESOLVER_FIXTURE_PREAMBLE, ...body, ''].join('\n');
      const sites = resolverCallSitesIn(
        resolverCallProgram([{ name, text }], fixtureRoot),
        fixtureRoot,
      );

      expect(sites.map(renderResolverCall), label).toEqual(rows);
      expect(sites[0]?.args[0]?.typeDeclaredIn, label).toBe(declaredIn);

      // And none of these is a branded path from the seam, which is the one thing
      // clause 6 accepts. Stated as the complement so the fixture proves the
      // assertion *discriminates* rather than merely produces a row.
      expect(
        renderResolverCall(sites[0] as ResolverCallSite),
        `${label} rendered as the permitted row`,
      ).not.toBe(`${PERMITTED_LOADER}: runtimeRequire(soljsonPath: AbsolutePath)`);
    },
  );

  it('clause 2 cannot see two of the four shapes clause 6 catches', () => {
    // The layering, measured. `callSites` matches a callee by *name*, so a resolver
    // under any other name — or none — is invisible to clause 2 no matter what it is
    // invoked with. This is the same kind of measurement fixtures A and B above make
    // for the specifier pin, applied to clause 2 itself.
    for (const { name, body } of resolverFixtures.slice(2)) {
      const scanned = scanText(
        [RESOLVER_FIXTURE_PREAMBLE, ...body, ''].join('\n'),
        `fixtures/${name}`,
      );
      expect(
        callSites([scanned], 'runtimeRequire'),
        `${name} was caught by clause 2 after all, which would make clause 6 ` +
          'redundant for this shape — re-read the amendment before deleting it',
      ).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Non-vacuity: the scan must fail on a real violation
// ---------------------------------------------------------------------------

describe('INV-49: the scan fires on a genuine host import', () => {
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
    // copy of the tree the moment SF-10 added `options/`, `output/` and
    // `results/` — and the clean-tree assertion below compares this copy's file
    // count against the real tree's, so a fixture that misses a directory reads
    // as a scan that failed to recurse. Rewritten by SF-10 Code Draft; the
    // property under test is unchanged, and the injected violation below still
    // lands in a subdirectory.
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

describe('INV-49: a host mentioned in a comment only passes the scan', () => {
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
        ' * which is exactly why INV-49 forbids reaching for it.',
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
    // The fixture that matters: not a synthetic file but the module Code Draft
    // revision 3 rewrote. If this ever fails, the scan has regressed to text
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
    // INV-19's mechanism, asserted from the INV-49 side. The one home for the
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
  'INV-49: the host really is importable by subpath, which is why the invariant is needed',
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
// Hand-off to SF-11
// ---------------------------------------------------------------------------

describe('INV-49: SF-11 inherits a two-clause boundary check, not one item', () => {
  it('ranges over a strictly larger subject than INV-28 does', () => {
    // INV-28's subject is `src/` *minus* the seam, because the seam is INV-28's
    // permitted exception; INV-49's is `src/` entire, because it has none. The two
    // scans therefore cannot share a subject, which is the concrete form of Design
    // revision 2's "neither subsumes the other" — and the thing most likely to be
    // lost when SF-11 mechanizes both as "the boundary check".
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

    // Partition, asserted rather than assumed: every module is in exactly one of
    // INV-28's subject and the seam, and INV-49 covers the union.
    expect(inv28.filter(file => seam.includes(file))).toEqual([]);
    expect([...inv49].sort()).toEqual([...inv28, ...seam].sort());
    expect(inv49.length).toBeGreaterThan(inv28.length);
    expect(seam.length).toBeGreaterThan(0);

    expect(seam).toContain(path.join(srcDir, 'environment', 'errors.ts'));
    expect(inv28).toContain(path.join(srcDir, 'index.ts'));
    expect(seam).toContain(path.join(srcDir, 'environment', 'index.ts'));
  });
});
