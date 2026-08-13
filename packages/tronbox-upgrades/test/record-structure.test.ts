import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { packageRoot, srcDir } from './helpers/locate';
import {
  allSources,
  callSites,
  hostSpecifiers,
  scanDirectory,
  scanText,
  type ModuleSpecifier,
  type ScannedSource,
} from './helpers/source-scan';
import {
  ENGINE_VERSION_UNDER_TEST,
  engineDistDir,
  engineVersion,
} from './helpers/surface-fixtures';

/**
 * The record layer's **structural** half: the absence scans, the closure walk,
 * the face pins and the engine canary.
 *
 * Its sibling file carries the behavioural half — the fingerprint's width, its
 * explicit `null`, the atomic write, the three indeterminate routes, the pre-write
 * refusal and the read gate. The split is by *instrument*, not by category: every
 * property below is decided by reading the source tree, the type declarations or the
 * installed dependency, and none of them needs a temporary directory or a fake chain.
 * Keeping them apart means a failure here says "the shape moved" and a failure there
 * says "the behaviour moved", which are different repairs.
 *
 * **Three rules this file follows without exception.**
 *
 * 1. **Every scan is a function of its input, and every scan has a fixture that makes
 *    it red.** A scan that has never gone red is not evidence — this suite has
 *    already found instruments that did not measure their property, including one that
 *    was a tautology in the mode it ran in. So each predicate here takes the scanned
 *    sources (or a specifier map) as an argument, and each is applied twice: once to
 *    the real tree, and once to a fixture that violates the invariant, asserting the
 *    fixture is reported. The negative fixture lives beside the assertion rather than
 *    in a one-off induction run, so the falsifiability is re-proved on every run
 *    instead of being attested in prose.
 *
 * 2. **A predicate is evaluated in the mode it will actually run.** `scanText` parses
 *    a string with the same scanner the real files go through, so the fixture exercises
 *    the same code path — not a re-implementation that could agree with the invariant
 *    while the real scan does not.
 *
 * 3. **Nothing here claims the present tense about something that does not exist.**
 *    Two of these invariants range over consumers that have not been built, and one
 *    ranges over an entry module that is still a doc comment and `export {}`. Each of
 *    those says so in its own test name, pins the state that makes it trivially true,
 *    and proves the instrument on a subject that does have the thing being looked for.
 *    A guard whose subject is empty is recorded as empty, never as satisfied.
 */

// ---------------------------------------------------------------------------
// Shared scanning fixtures
// ---------------------------------------------------------------------------

const recordDir = path.join(srcDir, 'record');

let recordCache: readonly ScannedSource[] | undefined;
let srcCache: readonly ScannedSource[] | undefined;

/**
 * The nine modules of `src/record/**`, relative paths rooted at `src/record/`.
 *
 * Memoized per test file, for the reason the scanning kit memoizes its own program:
 * the assertions below read the same tree a few dozen times, and re-parsing it each
 * time would let two assertions in one file disagree because the tree changed
 * underneath them.
 */
function recordSources(): readonly ScannedSource[] {
  recordCache ??= scanDirectory(recordDir, recordDir);
  return recordCache;
}

/** Every module under `src/`, seam included — relative paths rooted at `src/`. */
function srcSources(): readonly ScannedSource[] {
  srcCache ??= allSources();
  return srcCache;
}

const RECORD_MODULES: readonly string[] = [
  'address.ts',
  'errors.ts',
  'index.ts',
  'location.ts',
  'manifest.ts',
  'reconcile.ts',
  'session.ts',
  'sidecar.ts',
  'types.ts',
];

function sourceNamed(
  sources: readonly ScannedSource[],
  relative: string,
): ScannedSource {
  const found = sources.find(source => source.relative === relative);
  if (found === undefined) {
    throw new Error(
      `the scan found no module at '${relative}' — it saw ` +
        `[${sources.map(source => source.relative).join(', ')}]`,
    );
  }
  return found;
}

/** Value references and property names, excluding type positions and comments. */
function emittedNames(source: ScannedSource): readonly string[] {
  return source.identifiers
    .filter(use => !use.inTypePosition)
    .map(use => use.name);
}

/** Every identifier the parser saw, type positions included — comments excluded. */
function allNames(source: ScannedSource): readonly string[] {
  return source.identifiers.map(use => use.name);
}

describe('the scanning subject itself — because a scan over the wrong tree passes for the wrong reason', () => {
  it('sees all nine modules of the record layer and nothing else', () => {
    expect(recordSources().map(source => source.relative)).toEqual(
      RECORD_MODULES,
    );
  });

  it('every module the scans range over was actually parsed, so no assertion below is over an empty set', () => {
    for (const source of recordSources()) {
      expect(
        source.identifiers.length,
        `${source.relative} parsed to zero identifiers, which means the scan read ` +
          'nothing and every absence assertion over it is vacuous',
      ).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// the host is reachable from `src/record/**` by no path
// ---------------------------------------------------------------------------

/**
 * This guard's report, as renderable strings: host-naming specifiers in any
 * loading syntax, **plus** every module-loading call whose specifier is
 * computed.
 *
 * The second clause is the helper's own completeness argument and it is not optional:
 * a computed specifier is invisible to a static scan, so zero host specifiers *plus*
 * zero computed sites is a proof and zero host specifiers alone is not.
 */
function hostReachabilityViolations(
  sources: readonly ScannedSource[],
): readonly string[] {
  return sources.flatMap(source => [
    ...hostSpecifiers(source).map(
      entry =>
        `${source.relative}:${entry.line} names the host as ` +
        `'${entry.specifier}' (${entry.kind})`,
    ),
    ...source.dynamicSpecifierSites.map(
      site =>
        `${source.relative}:${site.line} loads a computed specifier ` +
        `${site.expression} (${site.kind}), which no static scan can follow`,
    ),
  ]);
}

describe('`src/record/**` names the TronBox host in no loading syntax, and computes no specifier', () => {
  it('reports nothing over the record layer, in either clause', () => {
    expect(hostReachabilityViolations(recordSources())).toEqual([]);
  });

  it('the specifier census is non-empty, so the absence above is an absence rather than a scan that read nothing', () => {
    const specifiers = recordSources().flatMap(
      source => source.moduleSpecifiers,
    );
    expect(specifiers.length).toBeGreaterThan(20);
    // The record layer's own external dependencies, which is what makes the host's
    // absence a discriminating result rather than "this tree imports nothing".
    expect(
      [...new Set(specifiers.map(entry => entry.specifier))]
        .filter(specifier => !specifier.startsWith('.'))
        .sort(),
    ).toEqual([
      '@openzeppelin/upgrades-core',
      'ethers',
      'node:fs/promises',
      'node:path',
      'tronweb',
    ]);
  });

  it('non-vacuity: the same predicate reports every syntax that could name the host', () => {
    const fixtures: readonly (readonly [string, string])[] = [
      ['import', "import wrap from 'tronbox';\n"],
      ['export-from', "export { x } from 'tronbox/build/components/TronWrap';\n"],
      ['import-equals', "import wrap = require('tronbox');\n"],
      ['require', "const wrap = require('tronbox/package.json');\n"],
      ['require-resolve', "const p = require.resolve('tronbox');\n"],
      ['dynamic-import', "const m = import('tronbox-4.9.0/build/x');\n"],
      // The scoped form the invariant admits as a future shape, and the
      // version-aliased install names this repository's own test trees use.
      ['scoped', "import x from '@tronbox/core';\n"],
      ['version-aliased', "import x from 'tronbox-4.8.0/build/y';\n"],
    ];
    for (const [label, text] of fixtures) {
      const violations = hostReachabilityViolations([
        scanText(text, `fixtures/host-${label}.ts`),
      ]);
      expect(
        violations,
        `the ${label} syntax was not reported, so the scan does not cover it`,
      ).toHaveLength(1);
      expect(violations[0]).toContain(`fixtures/host-${label}.ts`);
    }
  });

  it('non-vacuity: the completeness clause reports a computed specifier even when no host name appears', () => {
    const violations = hostReachabilityViolations([
      scanText(
        'const name = process.argv[2];\nconst m = require(name);\n',
        'fixtures/computed-specifier.ts',
      ),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('which no static scan can follow');
  });

  it('a host named in a comment is not a violation, since a scan that fires on its own explanation gets reverted', () => {
    const commentOnly = scanText(
      [
        '/**',
        " * Never `require('tronbox')` — the package declares no `main`, so it",
        " * would throw; `require('tronbox/package.json')` resolves and must not",
        ' * be reached for either.',
        ' */',
        "export const note = 'see above';",
      ].join('\n'),
      'fixtures/host-in-comment.ts',
    );
    expect(hostReachabilityViolations([commentOnly])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the closure of the highest-consequence module
// ---------------------------------------------------------------------------

/** The two syntaxes that put a module into a *static* import closure. */
const STATIC_EDGE_KINDS: readonly ModuleSpecifier['kind'][] = [
  'import',
  'export-from',
];

type SpecifierIndex = ReadonlyMap<string, readonly ModuleSpecifier[]>;

function specifierIndex(sources: readonly ScannedSource[]): SpecifierIndex {
  return new Map(
    sources.map(source => [source.relative, source.moduleSpecifiers]),
  );
}

/** A relative specifier resolved against the index, `undefined` when it leaves it. */
function resolveWithin(
  index: SpecifierIndex,
  fromRelative: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined;
  }
  const base = path.join(path.dirname(fromRelative), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (index.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

interface Closure {
  /** Every in-tree module reached, the root included, sorted. */
  readonly modules: readonly string[];
  /** Bare specifiers reached by a **runtime static** edge, sorted and deduplicated. */
  readonly externals: readonly string[];
  /** `from -> specifier (kind)` for every runtime static edge naming the engine. */
  readonly engineRuntimeEdges: readonly string[];
  /** Edges skipped because they are erased at compile time. */
  readonly typeOnlyEdges: readonly string[];
  /**
   * Specifiers in a visited module whose syntax is **not** a static edge —
   * `require`, `require.resolve`, `import()`, `import x = require()`.
   *
   * Collected rather than ignored: the walker's guarantee is about the *static*
   * closure, so every specifier it declined to follow has to be visible to the
   * assertion reading it, or "no runtime engine import" would silently mean "no
   * runtime engine import in the syntaxes I happened to handle".
   */
  readonly deferredEdges: readonly string[];
}

/**
 * The **runtime** static import closure of one module, walked transitively.
 *
 * Two properties make this the checkable form of the invariant, and neither is
 * optional.
 *
 * **It is `typeOnly`-aware.** `import type … from '@openzeppelin/upgrades-core'` is
 * erased by the compiler and loads nothing, so it neither belongs in the closure nor
 * counts as a violation — and the record layer legitimately has five such edges today
 * for its wrapper types over the engine's manifest shapes. `ModuleSpecifier` carries
 * `isTypeOnly` for precisely this reason, handling the clause-level `import type`, the
 * inline `{ type X }` form where every binding is marked, and the `export … from`
 * mirror. A walker without it would render a permitted type-only edge
 * indistinguishable from the forbidden value import of the same specifier, which is
 * not pinning the invariant it was written for.
 *
 * **It follows only the two static syntaxes, and reports the rest.** A deferred
 * `import()` is the mechanism the record layer uses on purpose — the engine reads the
 * record's directory from the environment once, at module load, so the engine must be
 * loaded *after* the location is configured, which is exactly what a deferred import
 * buys. Following it would report the design as a violation. Ignoring it silently
 * would let a `require()` slip past. So it is followed by neither and listed by name.
 */
function runtimeStaticClosure(index: SpecifierIndex, root: string): Closure {
  if (!index.has(root)) {
    throw new Error(
      `the walk root '${root}' is not in the scanned tree, so the closure would ` +
        'be empty for the wrong reason',
    );
  }
  const modules = new Set<string>([root]);
  const externals = new Set<string>();
  const engineRuntimeEdges: string[] = [];
  const typeOnlyEdges: string[] = [];
  const deferredEdges: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of index.get(current) ?? []) {
      const rendered = `${current} -> '${edge.specifier}' (${edge.kind})`;
      if (!STATIC_EDGE_KINDS.includes(edge.kind)) {
        deferredEdges.push(rendered);
        continue;
      }
      if (edge.typeOnly) {
        typeOnlyEdges.push(rendered);
        continue;
      }
      if (edge.specifier === '@openzeppelin/upgrades-core') {
        engineRuntimeEdges.push(rendered);
      }
      const next = resolveWithin(index, current, edge.specifier);
      if (next === undefined) {
        externals.add(edge.specifier);
        continue;
      }
      if (!modules.has(next)) {
        modules.add(next);
        queue.push(next);
      }
    }
  }

  return {
    modules: [...modules].sort(),
    externals: [...externals].sort(),
    engineRuntimeEdges,
    typeOnlyEdges,
    deferredEdges,
  };
}

describe('`address.ts` reaches neither the seam nor the engine, and its whole closure is two third-party packages', () => {
  const address = (): ScannedSource => sourceNamed(recordSources(), 'address.ts');

  it('imports no seam module, no engine module and no Node built-in', () => {
    const forbidden = address().moduleSpecifiers.filter(
      entry =>
        entry.specifier.startsWith('node:') ||
        entry.specifier === '@openzeppelin/upgrades-core' ||
        /(?:^|\/)(?:environment|chain)$/.test(entry.specifier) ||
        entry.specifier.includes('../environment') ||
        entry.specifier.includes('../chain'),
    );
    expect(forbidden).toEqual([]);
  });

  it('its transitive closure is exactly one further module, and exactly two external packages', () => {
    // The stated form of this invariant used to be "`tronweb`, `ethers` and nothing
    // else". That is unsatisfiable alongside the invariants that give this
    // sub-feature a typed error surface, a closed `because` union and one renderer
    // per class: those live in `errors.ts`, and `address.ts` throws one of them. The
    // property that actually holds — and is the one worth having — is that the
    // closure *terminates* there: `errors.ts` imports nothing at all, so the
    // transitive closure of the highest-consequence module in the sub-feature is two
    // modules and two packages, which is what makes it testable with no fixture, no
    // network and no host.
    const closure = runtimeStaticClosure(
      specifierIndex(recordSources()),
      'address.ts',
    );
    expect(closure.modules).toEqual(['address.ts', 'errors.ts']);
    expect(closure.externals).toEqual(['ethers', 'tronweb']);
    expect(closure.engineRuntimeEdges).toEqual([]);
    expect(closure.deferredEdges).toEqual([]);
  });

  it('names the packages and not their versions, because which installed copy answers is not this scan\'s subject', () => {
    // `tronweb` and `ethers` are resolved by root hoisting rather than by a
    // declaration on this package, and the host pins a different `tronweb` minor
    // than the hoisted copy. That is recorded elsewhere and is deliberately outside
    // this assertion: a closure test that named a version would fail on an unrelated
    // dependency bump and be relaxed for the wrong reason.
    const closure = runtimeStaticClosure(
      specifierIndex(recordSources()),
      'address.ts',
    );
    for (const external of closure.externals) {
      expect(external).not.toMatch(/[@\d]/);
    }
  });

  it('non-vacuity: the closure grows the moment `errors.ts` reaches for anything', () => {
    // Fed through the same walker, so what is exercised is the real predicate rather
    // than a restatement of it.
    const index = specifierIndex([
      scanText("import { x } from './errors';\n", 'address.ts'),
      scanText("import path from 'node:path';\nexport const x = path;\n", 'errors.ts'),
    ]);
    const closure = runtimeStaticClosure(index, 'address.ts');
    expect(closure.externals).toEqual(['node:path']);
    expect(closure.externals).not.toEqual(['ethers', 'tronweb']);
  });

  it('non-vacuity: a seam import from `address.ts` is reported as a further module and a further package', () => {
    const index = specifierIndex([
      scanText(
        "import { utils } from 'tronweb';\nimport { assertAbsolute } from '../environment';\nexport const u = utils;\nexport const a = assertAbsolute;\n",
        'address.ts',
      ),
      scanText('export const nothing = 1;\n', 'errors.ts'),
    ]);
    const closure = runtimeStaticClosure(index, 'address.ts');
    expect(closure.externals).toEqual(['../environment', 'tronweb']);
    expect(closure.modules).toEqual(['address.ts']);
  });
});

// ---------------------------------------------------------------------------
// one module names `Manifest`, and it is inside the record layer
// ---------------------------------------------------------------------------

/** Every `src/`-relative module that mentions `Manifest` anywhere it is emitted or typed. */
function manifestNamers(sources: readonly ScannedSource[]): readonly string[] {
  return sources
    .filter(source => allNames(source).includes('Manifest'))
    .map(source => source.relative);
}

describe('only `manifest.ts` reaches the engine\'s `Manifest`, and no module outside the record layer names it', () => {
  it('names it in exactly one module across the whole of `src/`', () => {
    expect(manifestNamers(allSources())).toEqual([
      path.join('record', 'manifest.ts'),
    ]);
  });

  it('the one construction and the one access chain both live there', () => {
    const manifest = sourceNamed(recordSources(), 'manifest.ts');
    // Reached through the deferred import's namespace, which is what keeps the
    // engine out of the static closure. A bare `new Manifest(...)` would need a
    // static import to bind the name.
    expect(
      manifest.accessChains.filter(chain => chain.includes('Manifest')),
    ).toEqual(['engine.Manifest']);
  });

  it('the three address-taking methods are called from that module and nowhere else', () => {
    const sources = allSources();
    for (const method of [
      'getProxyFromAddress',
      'getDeploymentFromAddress',
      'addProxy',
    ]) {
      const sites = callSites(sources, method);
      expect(
        sites.map(site => site.relative),
        `${method} is called outside the one module permitted to call it`,
      ).toEqual([path.join('record', 'manifest.ts')]);
    }
  });

  it('non-vacuity: the namer census reports a module outside the record layer', () => {
    const offender = scanText(
      "import { Manifest } from '@openzeppelin/upgrades-core';\nexport const m = new Manifest(1);\n",
      path.join('ops', 'upgrade.ts'),
    );
    expect(manifestNamers([offender])).toEqual([path.join('ops', 'upgrade.ts')]);
  });

  it('non-vacuity: the call census reports an address-taking call made elsewhere', () => {
    const offender = scanText(
      'export const r = await handle.getProxyFromAddress(address);\n',
      path.join('ops', 'import.ts'),
    );
    expect(callSites([offender], 'getProxyFromAddress')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// the two functions that give the same wrong answer
// ---------------------------------------------------------------------------

const FORBIDDEN_KIND_FUNCTIONS: readonly string[] = [
  'setProxyKind',
  'detectProxyKind',
];

/**
 * This guard's report over a scanned tree: every occurrence of either forbidden
 * name as an identifier or inside a dotted access chain, plus the
 * computed-specifier completeness clause — an access chain assembled from a
 * string is invisible to an identifier census.
 */
function forbiddenKindUses(
  sources: readonly ScannedSource[],
): readonly string[] {
  return sources.flatMap(source => {
    const names = allNames(source).filter(name =>
      FORBIDDEN_KIND_FUNCTIONS.includes(name),
    );
    const chains = source.accessChains.filter(chain =>
      FORBIDDEN_KIND_FUNCTIONS.some(forbidden => chain.includes(forbidden)),
    );
    const strings = source.stringLiterals.filter(literal =>
      FORBIDDEN_KIND_FUNCTIONS.includes(literal),
    );
    return [
      ...names.map(name => `${source.relative} references ${name}`),
      ...chains.map(chain => `${source.relative} accesses ${chain}`),
      ...strings.map(
        literal => `${source.relative} names ${literal} as a string key`,
      ),
      ...source.dynamicSpecifierSites.map(
        site =>
          `${source.relative}:${site.line} loads a computed specifier, so the ` +
          'census above cannot be complete',
      ),
    ];
  });
}

describe('`setProxyKind` and `detectProxyKind` occur in zero imports and zero access chains', () => {
  it('reports nothing anywhere under `src/`', () => {
    // A prohibition rather than "always call `processProxyKind`": that function
    // throws when the resolved kind is a beacon, so a positive phrasing would be
    // unsatisfiable for the beacon workflows this package will grow. Both forbidden
    // routes give the same wrong answer — an un-recorded UUPS proxy recorded as
    // transparent — and one of them is deprecated upstream for exactly that reason.
    expect(forbiddenKindUses(allSources())).toEqual([]);
  });

  it('the census reaches every module under `src/`, so the emptiness is not a filter that excluded them', () => {
    const sources = allSources();
    expect(sources.length).toBeGreaterThan(50);
    // Re-pinned when the entry module gained its type-only surface: no module
    // under `src/` parses to zero identifiers any more. The pin stays, empty,
    // so the day an empty module appears it is named here rather than silently
    // tolerated by every census that walks the tree.
    expect(
      sources
        .filter(source => source.identifiers.length === 0)
        .map(source => source.relative),
    ).toEqual([]);
  });

  it('non-vacuity: it reports the import, the access chain and the string-built route separately', () => {
    const asImport = scanText(
      "import { setProxyKind } from '@openzeppelin/upgrades-core';\nexport const f = setProxyKind;\n",
      path.join('ops', 'force-import.ts'),
    );
    expect(forbiddenKindUses([asImport]).length).toBeGreaterThan(0);

    const asChain = scanText(
      'export const k = await engine.detectProxyKind(provider, address);\n',
      path.join('ops', 'diagnose.ts'),
    );
    expect(forbiddenKindUses([asChain]).length).toBeGreaterThan(0);

    const asString = scanText(
      "export const name = 'setProxyKind';\n",
      path.join('ops', 'indirect.ts'),
    );
    expect(forbiddenKindUses([asString]).length).toBeGreaterThan(0);

    const asComputed = scanText(
      'const engine = await import(specifier);\nexport const e = engine;\n',
      path.join('ops', 'computed.ts'),
    );
    expect(forbiddenKindUses([asComputed]).length).toBeGreaterThan(0);
  });

  it('non-vacuity: the safe neighbour is not reported, so the census is not a grep for the substring', () => {
    const safe = scanText(
      'export const run = async () => processProxyKind(provider, address, opts, data, version);\n',
      path.join('ops', 'deploy.ts'),
    );
    expect(forbiddenKindUses([safe])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// one `env` view, threaded
// ---------------------------------------------------------------------------

/** Every `process.*` access chain in a scanned tree, with its module. */
function processChains(
  sources: readonly ScannedSource[],
): readonly string[] {
  return sources.flatMap(source =>
    source.accessChains
      .filter(chain => chain === 'process' || chain.startsWith('process.'))
      .map(chain => `${source.relative}: ${chain}`),
  );
}

describe('`process.env` is read nowhere in `src/record/**`; the one `env` view arrives through the dependency seam', () => {
  it('reads the process environment in no module of the record layer', () => {
    expect(
      processChains(recordSources()).filter(entry =>
        entry.includes('process.env'),
      ),
    ).toEqual([]);
  });

  it('pins the whole `process.*` set instead of banning the identifier, since one legitimate use exists', () => {
    // `process.pid` names the atomic write's temporary file. A census over the
    // *identifier* `process` would fire on it, and the first person it fired on would
    // be right to relax it — so the census is over the access chain and the permitted
    // chain is pinned by name. A `process.env` added anywhere in this tree fails the
    // equality above and this one.
    expect(processChains(recordSources())).toEqual([
      'sidecar.ts: process.pid',
    ]);
  });

  it('the seam that replaces it is a declared member, so there is a route in that is not the process global', () => {
    const types = sourceNamed(recordSources(), 'types.ts');
    expect(types.text).toContain(
      'readonly env: Readonly<Record<string, string | undefined>>;',
    );
  });

  it('non-vacuity: the census reports a `process.env` read added to any module in the tree', () => {
    const offender = scanText(
      "export const dir = process.env['MANIFEST_DEFAULT_DIR'];\n",
      'location.ts',
    );
    expect(processChains([offender])).toEqual(['location.ts: process.env']);
  });

  it('non-vacuity: it reports a destructured read too, which a text grep for `process.env[` would miss', () => {
    const offender = scanText(
      'const { env } = process;\nexport const dir = env;\n',
      'session.ts',
    );
    expect(processChains([offender])).toEqual([]);
    // The destructure leaves no `process.env` chain, so the chain census alone is not
    // a complete instrument. The complete form is the pinned set above: a bare
    // `process` reference that is not `process.pid` shows up as an identifier that the
    // pin does not admit.
    expect(
      allNames(offender).filter(name => name === 'process'),
    ).toHaveLength(1);
    expect(
      allNames(sourceNamed(recordSources(), 'session.ts')).filter(
        name => name === 'process',
      ),
    ).toEqual([]);
  });

  it('the identifier `process` appears in exactly one module of the record layer, and only for the temporary file', () => {
    const namers = recordSources()
      .filter(source => emittedNames(source).includes('process'))
      .map(source => source.relative);
    expect(namers).toEqual(['sidecar.ts']);
  });
});

// ---------------------------------------------------------------------------
// the entry module's static import closure
// ---------------------------------------------------------------------------

/** Every module under `src/` with a **runtime** static import of the engine. */
function runtimeEngineImporters(
  sources: readonly ScannedSource[],
): readonly string[] {
  return sources.flatMap(source =>
    source.moduleSpecifiers
      .filter(
        entry =>
          entry.specifier === '@openzeppelin/upgrades-core' &&
          STATIC_EDGE_KINDS.includes(entry.kind) &&
          !entry.typeOnly,
      )
      .map(entry => `${source.relative}:${entry.line}`),
  );
}

describe('the walker: transitive, static-only, and `typeOnly`-aware', () => {
  it('skips a type-only engine edge rather than reporting it, because that edge is erased and loads nothing', () => {
    const index = specifierIndex([
      scanText(
        "import type { ManifestData } from '@openzeppelin/upgrades-core';\nexport type D = ManifestData;\n",
        'root.ts',
      ),
    ]);
    const closure = runtimeStaticClosure(index, 'root.ts');
    expect(closure.engineRuntimeEdges).toEqual([]);
    expect(closure.typeOnlyEdges).toEqual([
      "root.ts -> '@openzeppelin/upgrades-core' (import)",
    ]);
  });

  it('skips the inline `{ type X }` form too, which a clause-level `isTypeOnly` check alone would call runtime', () => {
    const index = specifierIndex([
      scanText(
        "import { type ManifestData, type ProxyDeployment } from '@openzeppelin/upgrades-core';\nexport type D = ManifestData | ProxyDeployment;\n",
        'root.ts',
      ),
    ]);
    const closure = runtimeStaticClosure(index, 'root.ts');
    expect(closure.engineRuntimeEdges).toEqual([]);
    expect(closure.typeOnlyEdges).toHaveLength(1);
  });

  it('reports a value import of the same specifier, so the permitted case and the forbidden one are distinguishable', () => {
    const index = specifierIndex([
      scanText(
        "import { withValidationDefaults } from '@openzeppelin/upgrades-core';\nexport const f = withValidationDefaults;\n",
        'root.ts',
      ),
    ]);
    const closure = runtimeStaticClosure(index, 'root.ts');
    expect(closure.engineRuntimeEdges).toEqual([
      "root.ts -> '@openzeppelin/upgrades-core' (import)",
    ]);
    expect(closure.typeOnlyEdges).toEqual([]);
  });

  it('reports a mixed import — one value binding among type bindings is still a runtime load', () => {
    // This is the shape the real runtime importer of the engine actually has, and it
    // is the one a clause-level check gets right only by accident: the clause is not
    // `isTypeOnly`, one element is, one is not, and the specifier is emitted.
    const index = specifierIndex([
      scanText(
        "import {\n  withValidationDefaults,\n  type ValidationOptions,\n} from '@openzeppelin/upgrades-core';\nexport const f = withValidationDefaults;\nexport type V = ValidationOptions;\n",
        'root.ts',
      ),
    ]);
    const closure = runtimeStaticClosure(index, 'root.ts');
    expect(closure.engineRuntimeEdges).toEqual([
      "root.ts -> '@openzeppelin/upgrades-core' (import)",
    ]);
    expect(closure.typeOnlyEdges).toEqual([]);
  });

  it('walks transitively, so an engine import three modules down is still found', () => {
    const index = specifierIndex([
      scanText("export * from './a';\n", 'root.ts'),
      scanText("export * from './b';\n", 'a.ts'),
      scanText(
        "import { Manifest } from '@openzeppelin/upgrades-core';\nexport const m = Manifest;\n",
        'b.ts',
      ),
    ]);
    const closure = runtimeStaticClosure(index, 'root.ts');
    expect(closure.modules).toEqual(['a.ts', 'b.ts', 'root.ts']);
    expect(closure.engineRuntimeEdges).toEqual([
      "b.ts -> '@openzeppelin/upgrades-core' (import)",
    ]);
  });

  it('does not follow a deferred import, and lists it rather than dropping it', () => {
    // Following it would report the design as a violation — the engine is loaded
    // deferred *on purpose*, because it reads the record's directory from the
    // environment once at module load. Dropping it silently would let a `require()`
    // through. So it is neither followed nor hidden.
    const index = specifierIndex([
      scanText(
        "export async function open() {\n  const engine = await import('@openzeppelin/upgrades-core');\n  return engine;\n}\n",
        'root.ts',
      ),
    ]);
    const closure = runtimeStaticClosure(index, 'root.ts');
    expect(closure.engineRuntimeEdges).toEqual([]);
    expect(closure.deferredEdges).toEqual([
      "root.ts -> '@openzeppelin/upgrades-core' (dynamic-import)",
    ]);
  });

  it('refuses a root it did not scan, so a typo cannot produce an empty closure that passes', () => {
    expect(() =>
      runtimeStaticClosure(specifierIndex(recordSources()), 'sesion.ts'),
    ).toThrow(/not in the scanned tree/);
  });
});

describe('applied to the real tree', () => {
  it('the record layer\'s own runtime closure spans the seam and the chain layer, and contains no runtime engine import', () => {
    // The substantive live claim, and it is not vacuous: 33 modules (the seam
    // carries the shared host-sharing leaf; `soljson-path.ts` left the seam
    // with the embedded compiler), three directories plus that
    // leaf, five type-only engine edges and one deferred one.
    const closure = runtimeStaticClosure(
      specifierIndex(allSources()),
      path.join('record', 'index.ts'),
    );
    expect(closure.modules.length).toBe(33);
    expect(closure.engineRuntimeEdges).toEqual([]);
    expect(
      closure.typeOnlyEdges.filter(edge =>
        edge.includes('@openzeppelin/upgrades-core'),
      ).length,
    ).toBeGreaterThan(0);
    expect(closure.externals).toEqual([
      // The seam's own error module reads this package's declared dependency range
      // from its own manifest. A relative specifier that leaves the TypeScript tree,
      // so the walker records it as external rather than following it — and it is
      // listed rather than filtered, because a walker that silently dropped
      // unresolvable relative specifiers could drop a `.ts` one too.
      '../../package.json',
      'ethers',
      'node:fs',
      'node:fs/promises',
      'node:path',
      'tronweb',
    ]);
  });

  it('the only non-static edge in that closure is the deferred engine import, named once', () => {
    const closure = runtimeStaticClosure(
      specifierIndex(allSources()),
      path.join('record', 'index.ts'),
    );
    expect(closure.deferredEdges).toEqual([
      `${path.join('record', 'manifest.ts')} -> '@openzeppelin/upgrades-core' (dynamic-import)`,
    ]);
  });

  it('the walker\'s edge set is complete: no module under `src/` computes a specifier', () => {
    // The walker handles the two static syntaxes and names the four deferred ones. A
    // specifier assembled at runtime would be outside all six, so its absence is what
    // turns "no runtime engine edge in the closure" from a scan result into a proof.
    expect(
      allSources().flatMap(source =>
        source.dynamicSpecifierSites.map(
          site => `${source.relative}:${site.line} ${site.kind}`,
        ),
      ),
    ).toEqual([]);
  });

  it('exactly two modules under `src/` import the engine at runtime, and neither is in the record layer', () => {
    const importers = runtimeEngineImporters(allSources());
    expect(importers.map(entry => entry.split(':')[0])).toEqual([
      path.join('options', 'resolve.ts'),
      path.join('validation-input', 'identity.ts'),
    ]);
    for (const importer of importers) {
      expect(importer.startsWith(`record${path.sep}`)).toBe(false);
    }
  });

  it('the entry module carries only erased edges, so its runtime closure is itself alone', () => {
    // Re-pinned when the entry module gained its type-only surface. Both of
    // its specifiers are `export type … from` — erased at compile time — so
    // the RUNTIME closure is still the entry alone, which is the property the
    // invariant actually needs: nothing evaluates the engine's record-directory
    // constant at import time. The exact edge census is asserted so a third
    // specifier, or one that stops being type-only, fails here by name.
    const entry = allSources().find(source => source.relative === 'index.ts');
    // Re-pinned when the operations landed: the entry now carries VALUE edges
    // to ./proxy (operations + refusals) and ./deploy (the deployment-seam
    // refusal family), alongside the two erased type edges. What the invariant
    // actually needs is unchanged and asserted below: the runtime closure
    // reaches the engine ZERO times statically — the toolkit's engine access
    // is a dynamic import, recorded as a deferred edge, never a static one.
    //
    // Re-pinned again for `./record/errors`: the one record-layer edge the entry
    // now carries, for `RecordFingerprintUnreadableError`. Still a VALUE edge —
    // consumers need the real class, not its type, to write a `catch` — and still
    // engine-free, because `errors.ts` is the module that imports nothing.
    //
    // Re-pinned again for the cheap public additions: `./output/silence`
    // (`silenceWarnings`, exact-specifier sanctioned — the face and its two
    // engine-reaching leaves stay unreachable), `./erc1967` (the public 1967
    // readers, engine-free by construction: it reaches only `./environment`,
    // `./chain`, `./record` and `./adopt/errors`), and `./chain` (the two
    // 1967 reader errors, `ChainImplementationNotFoundError` and
    // `ChainBeaconNotFoundError` — real classes, for the same reason
    // `./record/errors` is: a consumer needs them to write a `catch`).
    //
    // Re-pinned again when the published surface was made to match the
    // runtime: `./options/errors` (the option-refusal family a caller catches
    // — a leaf that imports NOTHING, which is why the family is reachable
    // from here while `./options` itself, whose face re-exports the
    // engine-loading resolver, still is not), `./validation-input/errors`
    // (same shape: a leaf whose only imports are `import type`),
    // `./environment` (the environment refusals, through the seam's FACE
    // because `test/performance-and-reuse.test.ts` forbids anything outside
    // the seam reaching a seam internal — and the face was already in the
    // runtime closure through `./erc1967`), and a third `./proxy` specifier,
    // which is the erased `export type { MigrationHandles }`.
    expect(entry?.moduleSpecifiers.map(edge => edge.specifier).sort()).toEqual([
      './admin',
      './admin/errors',
      './adopt',
      './adopt/errors',
      './beacon',
      './chain',
      './deploy',
      './environment',
      './erc1967',
      './options/errors',
      './options/types',
      './output/silence',
      './proxy',
      './proxy',
      './proxy',
      './record/errors',
      './results/types',
      './standalone',
      './validation-input/errors',
    ]);
    const closure = runtimeStaticClosure(
      specifierIndex(allSources()),
      'index.ts',
    );
    expect(closure.engineRuntimeEdges).toEqual([]);
    // The deferred edges are the sanctioned pattern, by name: the toolkit's
    // three loads plus the record layer's own manifest deferral, which the
    // closure now reaches through the operations.
    const deferredTargets = [
      ...new Set(closure.deferredEdges.map(edge => edge.split("'")[1])),
    ].sort();
    expect(deferredTargets).toEqual([
      '../options/resolve',
      '../validation-input',
      '@openzeppelin/upgrades-core',
    ]);
    expect(
      closure.deferredEdges.filter(edge =>
        edge.includes('@openzeppelin/upgrades-core'),
      ),
    ).toHaveLength(2);
  });

  it('non-vacuity: re-exporting the public option surface from the entry module puts a runtime engine import in its closure', () => {
    // The measured shortest path to a working entry module, and it is the obvious
    // thing to do — the option surface *is* the plugin's API. The module that surface
    // re-exports carries the package's runtime engine import, so the closure reaches
    // the engine's own index, which evaluates the record-directory constant before any
    // plugin code has run. The same walker, over the same real tree, with one edge
    // added to the root.
    const index = new Map(specifierIndex(allSources()));
    index.set(
      'index.ts',
      scanText("export * from './options';\n", 'index.ts').moduleSpecifiers,
    );
    const closure = runtimeStaticClosure(index, 'index.ts');
    expect(closure.modules).toContain(path.join('options', 'resolve.ts'));
    expect(closure.engineRuntimeEdges).toEqual([
      `${path.join('options', 'resolve.ts')} -> '@openzeppelin/upgrades-core' (import)`,
    ]);
  });

  it('non-vacuity: re-exporting the record layer instead does not, which is what makes the previous result discriminating', () => {
    const index = new Map(specifierIndex(allSources()));
    index.set(
      'index.ts',
      scanText("export * from './record';\n", 'index.ts').moduleSpecifiers,
    );
    const closure = runtimeStaticClosure(index, 'index.ts');
    expect(closure.modules.length).toBe(34);
    expect(closure.engineRuntimeEdges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// exactly one caught-and-not-rethrown site
// ---------------------------------------------------------------------------

interface CaughtSite {
  readonly relative: string;
  readonly line: number;
  /** `true` when the catch body itself throws, not merely some nested closure. */
  readonly rethrows: boolean;
}

/**
 * Every `catch` clause in a scanned tree, with whether its **own** body throws.
 *
 * "Its own body" is the load-bearing part. A `throw` inside a function expression
 * declared within the catch is not a rethrow — the closure may never be called — so
 * counting it would let a swallow be laundered past the census by wrapping the throw
 * in an arrow nobody invokes. Descent therefore stops at every function boundary.
 */
function caughtSites(
  sources: readonly ScannedSource[],
): readonly CaughtSite[] {
  const found: CaughtSite[] = [];
  for (const source of sources) {
    const sourceFile = ts.createSourceFile(
      source.file,
      source.text,
      ts.ScriptTarget.ES2022,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCatchClause(node)) {
        let rethrows = false;
        const inspect = (inner: ts.Node): void => {
          if (ts.isThrowStatement(inner)) {
            rethrows = true;
            return;
          }
          if (
            ts.isFunctionDeclaration(inner) ||
            ts.isFunctionExpression(inner) ||
            ts.isArrowFunction(inner) ||
            ts.isMethodDeclaration(inner) ||
            ts.isClassDeclaration(inner)
          ) {
            return;
          }
          ts.forEachChild(inner, inspect);
        };
        ts.forEachChild(node.block, inspect);
        found.push({
          relative: source.relative,
          line:
            sourceFile.getLineAndCharacterOfPosition(
              node.getStart(sourceFile),
            ).line + 1,
          rethrows,
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return found;
}

describe('exactly two caught-and-not-rethrown sites in the record layer, each converting the failure into a named state', () => {
  it('the census finds three `catch` clauses, and exactly two of them swallow', () => {
    // The count is the invariant, not a spot check: the hazard is a NEW swallow
    // appearing somewhere unrelated, which is how a failed manifest write becomes a
    // silent no-op — a session returned, the operation proceeding, the record
    // half-canonicalized, and nothing in the output channel. Two swallows are
    // sanctioned, and both convert the failure into a named state instead of
    // dropping it: the sidecar read (an unreadable fingerprint IS a state), and
    // the fingerprint refusal's diagnosis (failure-tolerant BY DESIGN — it runs
    // inside a refusal whose message promises nothing was changed, so a manifest
    // or chain that cannot answer degrades the diagnosis to `indeterminate`
    // rather than masking the refusal with a different error).
    const sites = caughtSites(recordSources());
    expect(sites).toHaveLength(3);
    expect(sites.filter(site => !site.rethrows)).toHaveLength(2);
  });

  it('the swallows are the fingerprint read and the refusal diagnosis; the rethrow is the record lookup', () => {
    const sites = caughtSites(recordSources());
    expect(
      sites
        .filter(site => !site.rethrows)
        .map(site => site.relative)
        .sort(),
    ).toEqual(['session.ts', 'sidecar.ts']);
    expect(
      sites.filter(site => site.rethrows).map(site => site.relative),
    ).toEqual(['manifest.ts']);
  });

  it('both swallowing sites convert the failure into a named state rather than dropping it', () => {
    const sidecar = sourceNamed(recordSources(), 'sidecar.ts');
    expect(sidecar.text).toContain("return Object.freeze({ kind: 'absent' }");
    expect(sidecar.text).toContain(
      "return unreadable(cause instanceof SyntaxError ? 'not-json' : 'unreadable-file');",
    );
    const session = sourceNamed(recordSources(), 'session.ts');
    expect(session.text).toContain("return 'indeterminate';");
  });

  it('non-vacuity: a further swallow anywhere in the tree is reported', () => {
    const offender = scanText(
      [
        'export async function migrate(): Promise<void> {',
        '  try {',
        '    await write(data);',
        '  } catch {',
        '    // best effort',
        '  }',
        '}',
      ].join('\n'),
      'migrator.ts',
    );
    const sites = caughtSites([...recordSources(), offender]);
    expect(sites.filter(site => !site.rethrows)).toHaveLength(3);
  });

  it('non-vacuity: a throw nested in an uninvoked closure does not count as a rethrow', () => {
    const laundered = scanText(
      [
        'export function f(): void {',
        '  try {',
        '    g();',
        '  } catch (cause) {',
        '    const rethrow = () => {',
        '      throw cause;',
        '    };',
        '    void rethrow;',
        '  }',
        '}',
      ].join('\n'),
      'fixtures/laundered-swallow.ts',
    );
    const sites = caughtSites([laundered]);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.rethrows).toBe(false);
  });

  it('non-vacuity: a genuine rethrow does count, so the census is not simply calling everything a swallow', () => {
    const honest = scanText(
      [
        'export function f(): void {',
        '  try {',
        '    g();',
        '  } catch (cause) {',
        '    throw cause;',
        '  }',
        '}',
      ].join('\n'),
      'fixtures/honest-rethrow.ts',
    );
    expect(caughtSites([honest])[0]?.rethrows).toBe(true);
  });

  it('non-vacuity: a conditional rethrow counts, which is the shape the record lookup actually uses', () => {
    const conditional = scanText(
      [
        'export function f(): void {',
        '  try {',
        '    g();',
        '  } catch (cause) {',
        '    if (cause instanceof DeploymentNotFound) {',
        '      return;',
        '    }',
        '    throw cause;',
        '  }',
        '}',
      ].join('\n'),
      'fixtures/conditional-rethrow.ts',
    );
    expect(caughtSites([conditional])[0]?.rethrows).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type-declaration readers, for the face and the shape invariants
// ---------------------------------------------------------------------------

function parsedSource(source: ScannedSource): ts.SourceFile {
  return ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

function interfaceNamed(
  source: ScannedSource,
  name: string,
): ts.InterfaceDeclaration {
  const sourceFile = parsedSource(source);
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === name) {
      return statement;
    }
  }
  throw new Error(`${source.relative} declares no interface named ${name}`);
}

/** The declared type of a property signature, as written — never inferred. */
function propertyTypeText(
  declaration: ts.InterfaceDeclaration,
  member: string,
): string {
  for (const element of declaration.members) {
    if (
      ts.isPropertySignature(element) &&
      element.name.getText(parsedSource0(declaration)) === member
    ) {
      return (
        element.type?.getText(parsedSource0(declaration)) ?? '<no annotation>'
      );
    }
  }
  throw new Error(
    `${declaration.name.text} declares no property named ${member}`,
  );
}

/** The parameters of a method signature, as `name: type` pairs written verbatim. */
function methodParameterTexts(
  declaration: ts.InterfaceDeclaration,
  member: string,
): readonly string[] {
  const sourceFile = parsedSource0(declaration);
  for (const element of declaration.members) {
    if (
      ts.isMethodSignature(element) &&
      element.name.getText(sourceFile) === member
    ) {
      return element.parameters.map(parameter =>
        `${parameter.name.getText(sourceFile)}: ${
          parameter.type?.getText(sourceFile) ?? '<no annotation>'
        }`.replace(/\s+/g, ' '),
      );
    }
  }
  throw new Error(`${declaration.name.text} declares no method named ${member}`);
}

function parsedSource0(node: ts.Node): ts.SourceFile {
  return node.getSourceFile();
}

/** The string-literal members of a union-typed property, in declaration order. */
function propertyUnionMembers(
  declaration: ts.InterfaceDeclaration,
  member: string,
): readonly string[] {
  const sourceFile = parsedSource0(declaration);
  for (const element of declaration.members) {
    if (
      ts.isPropertySignature(element) &&
      element.name.getText(sourceFile) === member
    ) {
      const type = element.type;
      if (type === undefined) {
        throw new Error(`${member} carries no type annotation`);
      }
      const arms = ts.isUnionTypeNode(type) ? type.types : [type];
      return arms.map(arm => arm.getText(sourceFile));
    }
  }
  throw new Error(`${declaration.name.text} declares no property ${member}`);
}

interface FaceExport {
  readonly name: string;
  readonly typeOnly: boolean;
  readonly from: string;
}

/** Every name a module re-exports, with whether the re-export is erased. */
function faceExports(source: ScannedSource): readonly FaceExport[] {
  const sourceFile = parsedSource(source);
  const found: FaceExport[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          found.push({
            name: element.name.text,
            typeOnly: node.isTypeOnly || element.isTypeOnly,
            from: node.moduleSpecifier.text,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

// ---------------------------------------------------------------------------
// the face
// ---------------------------------------------------------------------------

const FACE_VALUES: readonly string[] = [
  'openRecord',
  'configureRecordLocation',
  'canonicalizeAddress',
  'isCanonicalAddress',
  'toBase58',
];

const FACE_TYPES: readonly string[] = [
  'AddressNotCanonicalizableError',
  'AddressRejectionCause',
  'CanonicalAddress',
  'KindProvenance',
  'NamedAddress',
  'ProxyRecordStatus',
  'ProxyRecordVerdict',
  'RecordDeps',
  'RecordFingerprintUnreadableError',
  'RecordLocation',
  'RecordLocationCause',
  'RecordLocationUnusableError',
  'RecordSession',
  'ReplayReconciliationReport',
];

/**
 * Internal names that must stay off the face — one per way the preflight's order
 * could be skipped.
 *
 * Not a taste list. The order *is* the design: configure the location, resolve the
 * identity, assert the outcome, compare the fingerprint, refuse before any write. Each
 * name below is a route that reaches one of those steps without the ones before it —
 * a module that derived the fingerprint's path itself would print a path from a
 * derivation that later moved, inside a message telling the user to delete that file.
 */
const OFF_FACE_NAMES: readonly string[] = [
  'toTronHex',
  'assertCanonicalAddress',
  'tryCanonicalizeAddress',
  'assertRecordLocation',
  'Manifest',
  'RecordManifest',
  'openRecordManifest',
  'recordCount',
  'canonicalizeStoredAddresses',
  'fingerprintPathFor',
  'fingerprintFor',
  'readFingerprint',
  'writeFingerprint',
  'fingerprintKeys',
  'buildReport',
  'reconcileProxies',
  'instanceOutcomeOf',
  'incompleteFieldOf',
  'recordRemedyTables',
  'FINGERPRINT_SCHEMA',
];

describe('the face is `openRecord` plus four named values, and everything else is unreachable through it', () => {
  const face = (): ScannedSource => sourceNamed(recordSources(), 'index.ts');

  it('exports exactly five values, in the order the face declares them', () => {
    expect(
      faceExports(face())
        .filter(entry => !entry.typeOnly)
        .map(entry => entry.name),
    ).toEqual(FACE_VALUES);
  });

  it('exports exactly those five at runtime too, which is where the erasure is actually observable', async () => {
    // The declaration pin above and this one answer different questions. The
    // declaration says what was written; this says what a consumer can reach. A type
    // export that stopped being type-only would pass the first and fail this one.
    const module_ = (await import('../src/record')) as Record<string, unknown>;
    expect(
      Object.keys(module_)
        .filter(key => key !== 'default')
        .sort(),
    ).toEqual([...FACE_VALUES].sort());
    for (const value of FACE_VALUES) {
      expect(typeof module_[value]).toBe('function');
    }
  });

  it('exports exactly the pinned type set, so an addition is a deliberate edit', () => {
    expect(
      faceExports(face())
        .filter(entry => entry.typeOnly)
        .map(entry => entry.name)
        .sort(),
    ).toEqual(FACE_TYPES);
  });

  it('names none of the twenty internal routes to the record, in either export list', () => {
    const exported = new Set(faceExports(face()).map(entry => entry.name));
    for (const name of OFF_FACE_NAMES) {
      expect(exported.has(name), `${name} reached the face`).toBe(false);
    }
  });

  it('the correlation helper exists and is deliberately internal, so its absence above is a decision rather than an omission', () => {
    const address = sourceNamed(recordSources(), 'address.ts');
    expect(address.text).toContain('export function toTronHex(');
    expect(faceExports(face()).map(entry => entry.name)).not.toContain(
      'toTronHex',
    );
  });

  it('the report type is internal in this version: the entry module re-exports nothing from the record layer\'s operations, and exactly one thing from its errors', () => {
    // "Internal in v1" is a statement about the package's public API, not about this
    // directory's own face — the report type is on the internal face, because the
    // preflight returns it. Re-pinned when the entry module gained its type-only
    // surface: it now carries names outward, so the guard is live — every export
    // is type-only, and none of them comes from the record layer.
    const entry = sourceNamed(allSources(), 'index.ts');
    // Re-pinned when the operations landed: the entry now carries value
    // exports — the operations and the two refusal families — so the live
    // guard is the ROUTE: nothing is re-exported from the record layer, and
    // none of the record face's five values appears among the exported names.
    //
    // Re-pinned again for `RecordFingerprintUnreadableError`: `openRecord` throws it
    // directly, so a caller has to be able to catch it, and `./record`'s own face
    // (asserted above) deliberately exports it as a type only — a consumer is meant
    // to distinguish record-layer errors by `code`, not by importing constructors.
    // This one class is the sanctioned exception, named explicitly below rather
    // than matched by a prefix, so a second `./record/*` edge — or a route to any
    // of the five operational values — still fails here by name.
    const SANCTIONED_RECORD_EDGE = './record/errors';
    for (const edge of entry.moduleSpecifiers) {
      if (edge.specifier === SANCTIONED_RECORD_EDGE) {
        continue;
      }
      expect(
        edge.specifier.startsWith('./record'),
        `${edge.specifier} reaches the record layer from the entry module`,
      ).toBe(false);
    }
    expect(
      entry.moduleSpecifiers.some(
        edge => edge.specifier === SANCTIONED_RECORD_EDGE,
      ),
      `${SANCTIONED_RECORD_EDGE} should be the one sanctioned record-layer edge`,
    ).toBe(true);
    expect(
      faceExports(entry)
        .filter(export_ => export_.from === SANCTIONED_RECORD_EDGE)
        .map(export_ => export_.name),
    ).toEqual(['RecordFingerprintUnreadableError']);
    const exportedNames = new Set(faceExports(entry).map(entry_ => entry_.name));
    for (const recordValue of FACE_VALUES) {
      expect(exportedNames.has(recordValue), `${recordValue} escaped`).toBe(false);
    }
    expect(exportedNames.has('RecordFingerprintUnreadableError')).toBe(true);
  });

  it('non-vacuity: the export reader distinguishes a value re-export from a type one', () => {
    const fixture = scanText(
      [
        "export { openRecord } from './session';",
        "export { toTronHex, type CanonicalAddress } from './address';",
        "export type { RecordDeps } from './types';",
      ].join('\n'),
      'fixtures/face.ts',
    );
    expect(
      faceExports(fixture)
        .filter(entry => !entry.typeOnly)
        .map(entry => entry.name),
    ).toEqual(['openRecord', 'toTronHex']);
    expect(
      faceExports(fixture)
        .filter(entry => entry.typeOnly)
        .map(entry => entry.name),
    ).toEqual(['CanonicalAddress', 'RecordDeps']);
  });
});

/**
 * The face invariant's consumer half: every name a module outside `src/record/`
 * imports from it.
 *
 * Reported as `module -> name` rather than counted, so a failure says which consumer
 * reached for which internal.
 */
function recordImportsFromOutside(
  sources: readonly ScannedSource[],
): readonly string[] {
  const index = specifierIndex(sources);
  const found: string[] = [];
  for (const source of sources) {
    if (source.relative.startsWith(`record${path.sep}`)) {
      continue;
    }
    const sourceFile = parsedSource(source);
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const target = resolveWithin(
          index,
          source.relative,
          node.moduleSpecifier.text,
        );
        if (target !== undefined && target.startsWith(`record${path.sep}`)) {
          const clause = node.importClause;
          const bindings = clause?.namedBindings;
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              found.push(`${source.relative} -> ${element.name.text}`);
            }
          } else {
            found.push(
              `${source.relative} -> <namespace or default of ${target}>`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return found;
}

describe('`openRecord` is the only way in; the consumers that would test it do not exist yet', () => {
  it('the consumer census is exact: the deployment seam, importing through the face', () => {
    // Originally asserted as zero consumers, recorded as a measured state rather
    // than a satisfied rule. Consumers have appeared since — most recently
    // `erc1967.ts`, which takes the mint and the base58 conversion, both
    // through the face, to answer the public 1967 readers in TRON's own
    // address form. A new consumer, or a route change, edits this list
    // deliberately or fails here.
    expect(recordImportsFromOutside(allSources())).toEqual([
      `${path.join('admin', 'index.ts')} -> canonicalizeAddress`,
      `${path.join('adopt', 'index.ts')} -> canonicalizeAddress`,
      `${path.join('beacon', 'index.ts')} -> canonicalizeAddress`,
      `${path.join('deploy', 'sender.ts')} -> canonicalizeAddress`,
      `${path.join('deploy', 'sender.ts')} -> CanonicalAddress`,
      `erc1967.ts -> canonicalizeAddress`,
      `erc1967.ts -> toBase58`,
      `${path.join('proxy', 'deploy-proxy.ts')} -> canonicalizeAddress`,
      `${path.join('proxy', 'replay.ts')} -> canonicalizeAddress`,
      `${path.join('proxy', 'replay.ts')} -> CanonicalAddress`,
      `${path.join('proxy', 'replay.ts')} -> ProxyRecordVerdict`,
      `${path.join('proxy', 'toolkit.ts')} -> configureRecordLocation`,
      `${path.join('proxy', 'toolkit.ts')} -> openRecord`,
      `${path.join('proxy', 'toolkit.ts')} -> canonicalizeAddress`,
      `${path.join('proxy', 'toolkit.ts')} -> ProxyRecordVerdict`,
      `${path.join('proxy', 'toolkit.ts')} -> RecordSession`,
      `${path.join('proxy', 'upgrade-proxy.ts')} -> canonicalizeAddress`,
    ]);
  });

  it('every consumer import is on the face — values and exported types alike', () => {
    const permitted = new Set([...FACE_VALUES, ...FACE_TYPES]);
    for (const entry of recordImportsFromOutside(allSources())) {
      const name = entry.split(' -> ')[1] ?? '';
      expect(permitted.has(name), `${entry} is not on the face`).toBe(true);
    }
  });

  it('non-vacuity: the consumer scan reports a deep import of an internal helper', () => {
    // The measured violation scenario: a consumer imports the fingerprint's path
    // helper "just to log the filename", and a later change to the derivation leaves
    // it printing a path that does not exist inside a message telling the user to
    // delete it.
    const sources = [
      ...allSources(),
      scanText(
        "import { fingerprintPathFor } from '../record/sidecar';\nexport const p = fingerprintPathFor;\n",
        path.join('ops', 'upgrade.ts'),
      ),
    ];
    const found = recordImportsFromOutside(sources).filter(entry =>
      entry.startsWith(`ops${path.sep}`),
    );
    expect(found).toEqual([
      `${path.join('ops', 'upgrade.ts')} -> fingerprintPathFor`,
    ]);
    const permitted = new Set(FACE_VALUES);
    expect(permitted.has('fingerprintPathFor')).toBe(false);
  });

  it('non-vacuity: it reports a namespace import too, which names no bindings for a name check to inspect', () => {
    const sources = [
      ...allSources(),
      scanText(
        "import * as record from '../record/manifest';\nexport const r = record;\n",
        path.join('ops', 'deploy.ts'),
      ),
    ];
    expect(
      recordImportsFromOutside(sources).filter(entry =>
        entry.startsWith(`ops${path.sep}`),
      ),
    ).toEqual([
      `${path.join('ops', 'deploy.ts')} -> <namespace or default of ${path.join('record', 'manifest.ts')}>`,
    ]);
  });

  it('non-vacuity: an import of a face value through the face is not reported as a violation by the name check', () => {
    const sources = [
      ...allSources(),
      scanText(
        "import { openRecord } from '../record';\nexport const o = openRecord;\n",
        path.join('ops', 'ok.ts'),
      ),
    ];
    const found = recordImportsFromOutside(sources).filter(entry =>
      entry.startsWith(`ops${path.sep}`),
    );
    expect(found).toEqual([`${path.join('ops', 'ok.ts')} -> openRecord`]);
    for (const entry of found) {
      expect(new Set(FACE_VALUES).has(entry.split(' -> ')[1] ?? '')).toBe(true);
    }
  });
});
